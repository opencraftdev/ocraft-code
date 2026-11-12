import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantState } from "../shared/assistant.ts";
import { AssistantSessions, CLAUDE_SETTINGS, CODEX_ARGS, sessionName, userCodexAuth, type AssistantPanes } from "./assistant-sessions.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";

/** herdr as these tests see it: every pane opened, read and closed is recorded, nothing runs */
function fakePanes() {
  const opened: Parameters<AssistantPanes["open"]>[0][] = [];
  const closed: string[] = [];
  /** the panes herdr has; null: herdr cannot be asked */
  const live: { panes: Set<string> | null } = { panes: new Set() };
  const panes: AssistantPanes = {
    open: async (options) => { opened.push(options); live.panes?.add(`pane-${opened.length}`); return { paneId: `pane-${opened.length}`, workspaceId: `ws-${opened.length}` }; },
    read: async (paneId) => ({ turns: [{ role: "user", text: `hello ${paneId}` }, { role: "assistant", text: "hi" }] }),
    close: async (workspaceId) => { closed.push(workspaceId); },
    alive: async (paneId) => { if (!live.panes) throw new Error("herdr is not running"); return live.panes.has(paneId); },
  };
  return { panes, opened, closed, live };
}

describe("Assistant sessions", () => {
  it("are named by their local start time, YYYYMMDD-HHMM", () => {
    expect(sessionName(new Date(2026, 10, 11, 21, 12, 59))).toBe("20261111-2112");
    expect(sessionName(new Date(2026, 0, 2, 3, 4))).toBe("20260102-0304");
  });

  it("starts a fresh pane in the agent folder and archives the one before with its conversation", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-sessions-"));
    const { panes, opened, closed } = fakePanes();
    let now = new Date(2026, 10, 11, 21, 12);
    const sessions = new AssistantSessions(stateDir, "claude", () => ({ OVIS_TASK_TOKEN: "t" }), panes, () => now);
    try {
      const first = await sessions.start();
      expect(first).toEqual({ name: "20261111-2112", agent: "claude", started_at: now.getTime(), pane_id: "pane-1" });
      expect(opened[0]).toMatchObject({ cwd: join(stateDir, "assistant", "agent"), env: { OVIS_TASK_TOKEN: "t" }, agent: "claude", args: [] });
      // the same minute again: a second name, never the first one's folder
      const second = await sessions.start();
      expect(second.name).toBe("20261111-2112-2");
      now = new Date(2026, 10, 11, 22, 0);
      await sessions.start();
      expect(closed).toEqual(["ws-1", "ws-2"]);
      const list = sessions.list();
      expect(list.map((session) => [session.name, session.pane_id, session.archived_at !== undefined])).toEqual([
        ["20261111-2200", "pane-3", false], ["20261111-2112-2", null, true], ["20261111-2112", null, true],
      ]);
      expect(sessions.transcript("20261111-2112")).toEqual({ name: "20261111-2112", turns: [{ role: "user", text: "hello pane-1" }, { role: "assistant", text: "hi" }] });
      expect(() => sessions.transcript("20261111-2200")).toThrow("not archived");
      expect(() => sessions.transcript("../../etc")).toThrow();
      if (process.platform !== "win32") expect(statSync(join(stateDir, "assistant", "sessions", "20261111-2112", "transcript.json")).mode & 0o777).toBe(0o600);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("starts a fresh pane under the same name when herdr lost the current one, and only then", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-revive-"));
    const { panes, opened, closed, live } = fakePanes();
    const sessions = new AssistantSessions(stateDir, "claude", () => ({}), panes, () => new Date(2026, 10, 12, 9, 0));
    try {
      // no session yet: nothing to start
      await sessions.revive(new Set());
      expect(opened).toHaveLength(0);
      await sessions.start();
      // the pane is listed: nothing happens
      await sessions.revive(new Set(["pane-1"]));
      expect(opened).toHaveLength(1);
      // a list without it, while herdr itself cannot be asked: left as it is
      live.panes = null;
      await sessions.revive(new Set());
      expect(opened).toHaveLength(1);
      // herdr restarted without it: one fresh pane, however many lists say so meanwhile
      live.panes = new Set();
      await Promise.all([sessions.revive(new Set()), sessions.revive(new Set())]);
      expect(opened).toHaveLength(2);
      expect(opened[1]).toMatchObject({ label: "Assistant 20261112-0900", cwd: join(stateDir, "assistant", "agent") });
      expect(closed).toEqual(["ws-1"]);
      expect(sessions.list()).toEqual([{ name: "20261112-0900", agent: "claude", started_at: new Date(2026, 10, 12, 9, 0).getTime(), pane_id: "pane-2" }]);
      await sessions.revive(new Set(["pane-2"]));
      expect(opened).toHaveLength(2);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("writes instructions and settings that allow ovis-task and deny ssh, scp, herdr and curl", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-agent-"));
    const { panes, opened } = fakePanes();
    const sessions = new AssistantSessions(stateDir, "codex", () => ({}), panes);
    try {
      await sessions.start();
      const folder = join(stateDir, "assistant", "agent");
      expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      const instructions = readFileSync(join(folder, "AGENTS.md"), "utf8");
      for (const line of ["ovis-task list", "ovis-task projects", "notes.md", "not in your memory"]) expect(instructions).toContain(line);
      const settings = JSON.parse(readFileSync(join(folder, ".claude", "settings.json"), "utf8")) as typeof CLAUDE_SETTINGS;
      expect(settings).toEqual(CLAUDE_SETTINGS);
      expect(settings.permissions.allow).toContain("Bash(ovis-task:*)");
      for (const rule of ["Bash(ssh:*)", "Bash(scp:*)", "Bash(herdr:*)", "Bash(curl:*)", "Edit(./.claude/**)"]) expect(settings.permissions.deny).toContain(rule);
      // nothing outside the allow list runs, asked or not, and the Assistant is never started full auto
      expect(settings.permissions.defaultMode).toBe("dontAsk");
      expect(settings.permissions.allow.some((rule) => rule.startsWith("Bash(") && !rule.startsWith("Bash(ovis-task"))).toBe(false);
      expect(opened[0]!.args).toEqual(CODEX_ARGS);
      expect(opened[0]!.args.join(" ")).not.toMatch(/dangerously|yolo|full-auto|never|untrusted/);
      // Codex loads a project's .codex/ only once the user trusted it: the folder's .codex/ is its CODEX_HOME,
      // whose config and rules/ always load, and whose auth.json is the user's own sign-in, linked
      expect(opened[0]!.env["CODEX_HOME"]).toBe(join(folder, ".codex"));
      expect(readFileSync(join(folder, ".codex", "config.toml"), "utf8")).toContain('approval_policy = "on-request"');
      if (process.platform !== "win32") expect(readlinkSync(join(folder, ".codex", "auth.json"))).toBe(userCodexAuth());
      const rules = readFileSync(join(folder, ".codex", "rules", "ovis-task.rules"), "utf8");
      expect(rules).toContain('prefix_rule(pattern=["ovis-task"], decision="allow")');
      for (const command of ["ssh", "scp", "herdr", "curl"]) expect(rules).toContain(`"${command}"`);
      // the Assistant's own notes survive a new session
      writeFileSync(join(folder, "notes.md"), "kept");
      await sessions.start();
      expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("kept");
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("start from the UI's New session, with the ovis-task token and bin on the pane's environment", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-new-"));
    const { panes, opened } = fakePanes();
    const profile: HerdrMachineProfile = { id: "sessions-test", label: "Test PC", enabled: true, target: { destination: "sessions-test.invalid" } };
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: true, assistantRun: async () => "", assistantPanes: panes, herdrProfiles: async () => [profile] });
    const base = `http://127.0.0.1:${app.port}`;
    try {
      // a client with no browser Origin is refused, as every Assistant write is
      expect((await fetch(`${base}/api/assistant/sessions`, { method: "POST" })).status).toBe(403);
      const response = await fetch(`${base}/api/assistant/sessions`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(201);
      const state = (await response.json()) as AssistantState;
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0]!.pane_id).toBe("pane-1");
      const token = (JSON.parse(readFileSync(join(stateDir, "assistant", "cli-token.json"), "utf8")) as { token: string }).token;
      expect(opened[0]!.env).toMatchObject({ OVIS_TASK_URL: `http://127.0.0.1:${app.port}`, OVIS_TASK_TOKEN: token, OVIS_BUN: process.execPath });
      expect(opened[0]!.env["PATH"]!.split(process.platform === "win32" ? ";" : ":")[0]).toBe(join(import.meta.dir, "..", "bin"));
      expect((await fetch(`${base}/api/assistant/sessions/${state.sessions[0]!.name}`)).status).toBe(404);
    } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});
