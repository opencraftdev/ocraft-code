import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantState } from "../shared/assistant.ts";
import { AssistantSessions, CLAUDE_SETTINGS, CODEX_ARGS, sessionName, type AssistantPanes } from "./assistant-sessions.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";

/** herdr as these tests see it: every pane opened, read and closed is recorded, nothing runs */
function fakePanes() {
  const opened: Parameters<AssistantPanes["open"]>[0][] = [];
  const closed: string[] = [];
  const panes: AssistantPanes = {
    open: async (options) => { opened.push(options); return { paneId: `pane-${opened.length}`, workspaceId: `ws-${opened.length}` }; },
    read: async (paneId) => ({ turns: [{ role: "user", text: `hello ${paneId}` }, { role: "assistant", text: "hi" }] }),
    close: async (workspaceId) => { closed.push(workspaceId); },
  };
  return { panes, opened, closed };
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
      expect(opened[0]!.args.join(" ")).not.toMatch(/dangerously|yolo|full-auto|never/);
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
