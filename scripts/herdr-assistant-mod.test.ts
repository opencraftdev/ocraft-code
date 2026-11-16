import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { readLink } from "../src/lib/deepLink.ts";
import { linkedAssistantView } from "../src/lib/assistantMode.ts";
import { buildHerdrMods, MODS_DIR } from "./build-herdr-mods.ts";

// assistant.js imports the lib.js the build writes, so it is loaded after the build
let a: typeof import("../herdr-mods/ovis-assistant/assistant.js");
beforeAll(async () => {
  await buildHerdrMods();
  a = await import("../herdr-mods/ovis-assistant/assistant.js");
});

const pane = (pane_id: string, cwd: string, agent: string | null, agent_status = "idle", title = pane_id): HerdrPane =>
  ({ pane_id, workspace_id: pane_id.split(":")[0], cwd, foreground_cwd: cwd, agent, agent_status, terminal_title_stripped: title } as unknown as HerdrPane);
const machine = (id: string, name: string, kind: "local" | "ssh", panes: HerdrPane[], state = "connected", destination = id): Machine =>
  ({ id, name, kind, state, target: kind === "ssh" ? { destination } : undefined, snapshot: { workspaces: [], panes } } as unknown as Machine);
const AGENT_DIR = "/home/opencraft/.config/ovis/assistant/agent";
const roster = (): Machine[] => [
  machine("local", "air.local", "local", [pane("w1:p1", "/Users/me/ovis", "claude", "done")]),
  machine("mbp", "macbook-pro", "ssh", [
    pane("w26:p1", "/Users/p/lg_magazine", "claude", "working", "LG docs"),
    pane("w1V:p1", "/Users/p/dr_alaseo", "claude", "blocked", "alaseo check"),
    pane("w1V:p2", "/Users/p/dr_alaseo", "claude", "done", "alaseo report"),
    pane("w2:p1", "/Users/p/x", null),
  ], "connected", "potenlab-macbookpro"),
  machine("vm", "raka-devs", "ssh", [pane("wF:p1", AGENT_DIR, "claude", "done", "MCP progress status"), pane("wF:p2", AGENT_DIR, null)]),
];

describe("build", () => {
  test("lib.js carries the Assistant helpers without React", () => {
    const lib = readFileSync(join(MODS_DIR, "ovis-assistant/lib.js"), "utf8");
    expect(lib).toContain("function expandSessionTags");
    expect(lib).not.toContain("react.development");
  });
});

describe("finding the Assistant", () => {
  test("is the agent pane in the VM's Assistant folder, as the web app tells it", () => {
    const found = a.findAssistant(roster())!;
    expect([found.machineId, found.paneId, found.machine!.name]).toEqual(["vm", "wF:p1", "raka-devs"]);
    expect(a.findAssistant(roster().slice(0, 2))).toBeNull();
    expect(a.findAssistant([])).toBeNull();
  });

  test("props name it outright, even before the roster has it", () => {
    expect(a.findAssistant(roster(), { machine: "mbp", pane: "w26:p1" })!.pane!.agent_status).toBe("working");
    expect(a.findAssistant([], { pane: "w9:p1" })).toMatchObject({ machineId: "local", paneId: "w9:p1", pane: null });
  });
});

describe("sessions", () => {
  test("every PC but the Assistant VM, working and blocked first, the rest folded as finished", () => {
    const machines = a.delegateMachines(roster(), "vm");
    expect(machines.map((m) => m.id)).toEqual(["local", "mbp"]);
    const folded = a.sessionsSection(machines, false);
    expect(folded.shown.map((g) => [g.machine.id, g.panes.map((p) => p.pane_id)])).toEqual([["mbp", ["w26:p1", "w1V:p1"]]]);
    expect(folded.finished).toBe(2);
    expect(a.sessionsSection(machines, true).shown.flatMap((g) => g.panes.map((p) => p.pane_id))).toEqual(["w1:p1", "w26:p1", "w1V:p1", "w1V:p2"]);
    expect(a.statusOf(pane("x", "/", "claude", "blocked"))).toEqual({ word: "Needs input", color: "blocked" });
  });
});

describe("session tags", () => {
  test("an @word right before the caret opens the picker", () => {
    expect(a.mentionAt("look at @lg", 11)).toEqual({ start: 8, query: "lg" });
    expect(a.mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(a.mentionAt("mail me@host", 12)).toBeNull();
    expect(a.mentionAt("look at @lg now", 15)).toBeNull();
  });

  test("the picker lists connected PCs' sessions by the web composer's tag, and a pick leaves the box", () => {
    const machines = a.delegateMachines(roster(), "vm");
    const choices = a.mentionChoices(machines, "alaseo");
    // two sessions share the folder: the tag names the pane too
    expect(choices.map((c) => c.tag)).toEqual(["@macbook-pro/dr_alaseo:w1V:p1", "@macbook-pro/dr_alaseo:w1V:p2"]);
    expect(a.mentionChoices(machines, "lg").map((c) => c.tag)).toEqual(["@macbook-pro/lg_magazine"]);
    expect(a.dropMention("look at @lg now", 8, 11)).toBe("look at now");
  });

  test("chips go out first, each as the exact @session(...) the web composer sends", () => {
    const machines = a.delegateMachines(roster(), "vm");
    const chips = [{ tag: "@macbook-pro/lg_magazine", machineId: "mbp", paneId: "w26:p1" }];
    const text = a.outgoingText("how is it going?", chips, machines, new Map());
    expect(text).toStartWith('@session(machine="macbook-pro" host="potenlab-macbookpro" pane="w26:p1" folder="/Users/p/lg_magazine" agent="claude"');
    expect(text).toEndWith(") how is it going?");
    expect(a.outgoingText("plain", [], machines, new Map())).toBe("plain");
  });
});

describe("panel", () => {
  test("context used, restart command, background tasks and change totals", () => {
    expect(a.contextUsed({ context: { used: 157_531, window: 1_000_000 } })).toBe(16);
    expect(a.contextUsed(null)).toBeNull();
    expect([a.restartCommand("claude"), a.restartCommand("codex"), a.restartCommand("pi")]).toEqual(["/clear", "/new", null]);
    const tasks = a.backgroundTasks({ tasks: [{ status: "running" }, { status: "completed" }], runs: [{ status: "paused" }, { status: "failed" }] } as never);
    expect([tasks.running.length, tasks.ended.length, tasks.runs]).toEqual([1, 1, 1]);
    expect(a.changeTotals({ files: [{ additions: 3, deletions: 1 }, { additions: null, deletions: 2 }] })).toEqual({ files: 2, added: 3, removed: 3 });
    expect(a.changeTotals(null).files).toBe(0);
  });
});

describe("voice", () => {
  test("opens the web app on the Assistant's pane in voice", () => {
    const url = a.voiceUrl("http://127.0.0.1:7317", "vm 1", "wF:p1");
    const search = new URL(url).search;
    expect(readLink(search)).toMatchObject({ machine: "vm 1", pane: "wF:p1", view: "chat" });
    expect(linkedAssistantView(search)).toBe("voice");
    expect(new URL(a.voiceUrl("http://x", "local", "w1:p1")).searchParams.has("machine")).toBe(false);
    expect(a.openCommand("macos", url)).toEqual(["open", [url]]);
    expect(a.openCommand("linux", url)[0]).toBe("xdg-open");
  });
});
