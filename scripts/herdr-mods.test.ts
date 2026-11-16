import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationResponse, ConversationTurn } from "../shared/protocol.ts";
import { buildHerdrMods, MODS_DIR } from "./build-herdr-mods.ts";
import { defaultModsDir, installHerdrMods } from "./install-herdr-mods.ts";

// chat.js imports the lib.js the build writes, so it is loaded after the build
let chat: typeof import("../herdr-mods/ovis-chat/chat.js");
beforeAll(async () => {
  await buildHerdrMods();
  chat = await import("../herdr-mods/ovis-chat/chat.js");
});

const local = () => chat.target({ pane: "w1:p1" });
const remote = () => chat.target({ server: "http://127.0.0.1:7317/", machine: "vm 1", pane: "w1:p1" });

describe("build", () => {
  test("lib.js carries the web client's helpers without React or the dictionaries", () => {
    const lib = readFileSync(join(MODS_DIR, "ovis-chat/lib.js"), "utf8");
    expect(lib).toContain("function workSummary");
    expect(lib).not.toContain("react");
    expect(lib).not.toContain("i18n.ja");
  });
});

describe("endpoints", () => {
  test("a local pane uses the server's own routes, another machine its proxy", () => {
    expect(chat.apiUrl(local(), "pane/prompt")).toBe("http://127.0.0.1:7317/api/pane/prompt");
    expect(chat.apiUrl(remote(), "pane/prompt")).toBe("http://127.0.0.1:7317/api/machines/vm%201/pane/prompt");
    expect(chat.wsUrl(remote())).toBe("ws://127.0.0.1:7317/ws?machine_id=vm%201");
    // shown with pane.view, the host adds its own pane and terminal: the Ovis pane comes as paneId
    expect(chat.target({ pane: "p9", terminal: "t3", paneId: "w1:p1" })).toMatchObject({ pane: "w1:p1", host: "p9" });
    expect(chat.target({ pane: "p9", terminal: "t3" }).pane).toBeNull();
    expect(chat.conversationUrl(local(), { before: "a:1", since: null })).toBe("http://127.0.0.1:7317/api/pane/conversation?pane_id=w1%3Ap1&before=a%3A1");
  });
});

const turn = (role: "user" | "assistant", ts: string, parts: ConversationTurn["parts"], end_ts?: string): ConversationTurn => ({ role, ts, parts, ...(end_ts ? { end_ts } : {}) });
const say = (text: string): ConversationTurn["parts"][number] => ({ kind: "text", text });
const tool = (name: string, input: object, summary: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary, input: JSON.stringify(input), output: "ok" });

describe("rows", () => {
  const turns = [
    turn("user", "2026-01-01T00:00:00Z", [say("fix it")]),
    turn("assistant", "2026-01-01T00:00:01Z", [
      tool("Read", { file_path: "src/a.ts" }, "src/a.ts"),
      tool("Bash", { command: "bun test", description: "Run the tests" }, "Run the tests"),
      say("Done."),
    ], "2026-01-01T00:00:23Z"),
  ];

  test("a settled turn folds its work under one head and keeps the answer outside", () => {
    const [user, agent] = chat.chatRows(turns, "idle");
    expect(user).toMatchObject({ kind: "user", text: "fix it" });
    expect(agent!.kind).toBe("assistant");
    const [work, answer] = (agent as { blocks: Array<Record<string, unknown>> }).blocks;
    expect(work).toMatchObject({ kind: "work", title: "Worked for 22s", summary: "1 file read · 1 command", open: false });
    expect((work!["rows"] as Array<{ line: string }>).map((r) => r.line)).toEqual(["Read src/a.ts", "Run the tests"]);
    expect(answer).toMatchObject({ kind: "answer", text: "Done." });
    expect((agent as { copy: string }).copy).toBe("Done.");
  });

  test("the last turn reads Working… while the agent runs, Needs you while it waits", () => {
    const running = chat.chatRows(turns, "working")[1] as { blocks: Array<{ title?: string; open?: boolean }> };
    expect(running.blocks[0]).toMatchObject({ title: "Working…", open: true });
    const blocked = chat.chatRows(turns, "blocked")[1] as { blocks: Array<{ title?: string }> };
    expect(blocked.blocks[0]!.title).toBe("Needs you");
  });

  test("keys stay the same when older turns are put in front", () => {
    const later = chat.chatRows(turns, "idle").map((r) => r.key);
    const withOlder = chat.chatRows([turn("user", "2025-12-31T00:00:00Z", [say("hi")]), ...turns], "idle").map((r) => r.key);
    expect(withOlder.slice(1)).toEqual(later);
  });

  test("the model pill and context use the web client's names", () => {
    expect(chat.modelText({ model: "claude-opus-5-5", reasoning_effort: "high" })).toBe("Opus 5.5 · high");
    expect(chat.contextText({ model: null, reasoning_effort: null, context: { used: 250_000, window: 1_000_000 } })).toBe("75% context left");
    expect(chat.modelText(null)).toBeNull();
  });
});

describe("frames", () => {
  test("the snapshot readies the pane; status, changes and queued messages follow it", () => {
    const s = { status: undefined, agent: null, features: new Set<string>(), pending: [], error: null };
    const snapshot = { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }] };
    expect(chat.applyFrame(s, { type: "snapshot", snapshot, features: ["submit", "conversation-watch"] }, "w1:p1")).toBe("ready");
    expect(s).toMatchObject({ status: "idle", agent: "claude" });
    expect(s.features.has("conversation-watch")).toBe(true);
    expect(chat.applyFrame(s, { type: "pane-status", pane_id: "w1:p2", agent_status: "working" }, "w1:p1")).toBeNull();
    expect(chat.applyFrame(s, { type: "pane-status", pane_id: "w1:p1", agent_status: "working" }, "w1:p1")).toBe("prompt");
    expect(s.status).toBe("working");
    expect(chat.applyFrame(s, { type: "conversation-changed", pane_id: "w1:p1", signature: "x" }, "w1:p1")).toBe("refresh");
    chat.applyFrame(s, { type: "pending-messages", pane_id: "w1:p1", messages: [{ id: "m1", text: "next" }] }, "w1:p1");
    expect(s.pending).toHaveLength(1);
    expect(chat.applyFrame(s, { type: "snapshot", snapshot: { panes: [] } }, "w1:p1")).toBeNull();
    expect(s.error).toContain("not on that PC");
  });

  test("a prompt answer names the prompt and the option, or the checks", () => {
    const prompt = { id: "q1", multi_select: false, custom_option_index: 2 };
    expect(chat.promptAnswer("w1:p1", prompt, 0, "")).toEqual({ pane_id: "w1:p1", prompt_id: "q1", option_index: 0 });
    expect(chat.promptAnswer("w1:p1", prompt, 2, "mine")).toEqual({ pane_id: "w1:p1", prompt_id: "q1", option_index: 2, custom_text: "mine" });
    expect(chat.promptAnswer("w1:p1", { ...prompt, multi_select: true }, [0, 1], "")).toEqual({ pane_id: "w1:p1", prompt_id: "q1", option_indices: [0, 1] });
  });
});

describe("transcript paging", () => {
  // a fake server: turns t0..t(n-1), pages of 3 newest-first, cursors are turn indexes
  function server(count: () => number, history = () => "h1") {
    const calls: string[] = [];
    const turnAt = (i: number) => turn("user", `t${i}`, [say(`m${i}`)]);
    const getJson = async (url: string) => {
      const q = new URL(url).searchParams;
      calls.push(q.toString().replace("pane_id=w1%3Ap1&", "").replace("pane_id=w1%3Ap1", ""));
      const n = count();
      const since = q.has("since") ? Number(q.get("since")) : 0;
      let end = q.has("before") ? Number(q.get("before")) : n;
      let start = Math.max(since, end - 3);
      if (q.has("from")) { start = Math.max(Number(q.get("from")), n - 3); end = n; }
      const body: ConversationResponse = { source: "claude-transcript", history_id: history(), turns: Array.from({ length: end - start }, (_, k) => turnAt(start + k)), cursor: start === 0 ? null : String(start) };
      return { status: 200, body };
    };
    return { calls, getJson };
  }
  const texts = (t: { turns(): ConversationTurn[] }) => t.turns().map((x) => (x.parts[0] as { text: string }).text);

  test("reads the newest page, then older pages before it", async () => {
    const fake = server(() => 7);
    const transcript = new chat.Transcript(fake.getJson, local());
    await transcript.refresh();
    expect(texts(transcript)).toEqual(["m4", "m5", "m6"]);
    expect(transcript.hasOlder()).toBe(true);
    await transcript.loadOlder();
    await transcript.loadOlder();
    expect(texts(transcript)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(transcript.hasOlder()).toBe(false);
  });

  test("a newest page that moved on brings the turns in between", async () => {
    let n = 7;
    const fake = server(() => n);
    const transcript = new chat.Transcript(fake.getJson, local());
    await transcript.refresh();
    await transcript.loadOlder();
    n = 12;
    await transcript.refresh();
    expect(texts(transcript)).toEqual(Array.from({ length: 11 }, (_, i) => `m${i + 1}`));
    expect(fake.calls).toContain("from=4");
    expect(fake.calls).toContain("before=9&since=4");
  });

  test("a new history starts over", async () => {
    let history = "h1";
    const fake = server(() => 7, () => history);
    const transcript = new chat.Transcript(fake.getJson, local());
    await transcript.refresh();
    await transcript.loadOlder();
    history = "h2";
    await transcript.refresh();
    expect(texts(transcript)).toEqual(["m4", "m5", "m6"]);
  });
});

describe("install", () => {
  test("copies each mod without its bundle entry, and defaults to the herdr-app home", async () => {
    const target = mkdtempSync(join(tmpdir(), "herdr-mods-"));
    try {
      const [dir] = await installHerdrMods(target);
      const files = readdirSync(dir!);
      expect(files).toEqual(expect.arrayContaining(["main.js", "chat.js", "lib.js", "mod.json", "icons"]));
      expect(files).not.toContain("lib.entry.ts");
      expect(existsSync(join(dir!, "icons/copy.svg"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
    expect(defaultModsDir({ HERDR_APP_HOME: "/x" })).toBe(join("/x", "mods"));
    expect(defaultModsDir({})).toEndWith(join(".config", "herdr-app", "mods"));
  });
});
