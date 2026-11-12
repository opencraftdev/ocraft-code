import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantState } from "../shared/assistant.ts";
import type { AgentStatus } from "../shared/protocol.ts";
import { AssistantSession, claudeSettings, CODEX_ARGS, COMPACT_COOLDOWN_MS, compactCommand, distillRequest, KEEP_ALIVE_MS, logDay, notesRequest, userCodexAuth, writeAgentFolder, type AssistantPanes } from "./assistant-sessions.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";

/** herdr as these tests see it: every pane opened, started, messaged and closed is recorded, nothing runs */
function fakePanes() {
  const opened: Parameters<AssistantPanes["open"]>[0][] = [];
  const started: { paneId: string; args: string[] }[] = [];
  const sent: string[] = [];
  const closed: string[] = [];
  /** the panes herdr has; null: herdr cannot be asked */
  const live: { panes: Map<string, { agent: string | null; status: AgentStatus | null }> | null } = { panes: new Map() };
  const usage: { context: { used: number; window: number | null } | null } = { context: null };
  const panes: AssistantPanes = {
    open: async (options) => { opened.push(options); const paneId = `pane-${opened.length}`; live.panes?.set(paneId, { agent: options.agent, status: "idle" }); return { paneId, workspaceId: `ws-${opened.length}` }; },
    start: async (paneId, agent, args) => { started.push({ paneId, args }); live.panes?.set(paneId, { agent, status: "idle" }); },
    pane: async (paneId) => { if (!live.panes) throw new Error("herdr is not running"); return live.panes.get(paneId) ?? null; },
    context: async () => usage.context,
    send: async (_paneId, text) => { sent.push(text); },
    close: async (workspaceId) => { closed.push(workspaceId); },
  };
  const set = (paneId: string, value: { agent: string | null; status: AgentStatus | null } | undefined) => { if (value) live.panes!.set(paneId, value); else live.panes!.delete(paneId); };
  return { panes, opened, started, sent, closed, live, usage, set };
}

function session(agent: "claude" | "codex" = "claude", stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-session-"))) {
  const fake = fakePanes();
  let now = 1_000_000;
  const scheduled: { ms: number; fire: () => void }[] = [];
  const assistant = new AssistantSession(stateDir, agent, () => ({ OVIS_TASK_TOKEN: "t" }), fake.panes, { now: () => now, timer: (fire, ms) => { scheduled.push({ ms, fire }); return () => {}; } });
  return { ...fake, assistant, stateDir, scheduled, advance: (ms: number) => { now += ms; }, now: () => now, done: () => { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}

describe("the long-lived Assistant session", () => {
  it("opens one session the first time, fresh, and keeps it in session.json", async () => {
    const s = session();
    try {
      expect(s.assistant.info()).toBeNull();
      await s.assistant.check();
      expect(s.opened).toHaveLength(1);
      expect(s.opened[0]).toMatchObject({ cwd: join(s.stateDir, "assistant", "agent"), label: "Assistant", env: { OVIS_TASK_TOKEN: "t" }, agent: "claude", args: [] });
      expect(s.assistant.info()).toEqual({ agent: "claude", pane_id: "pane-1", started_at: s.now(), last_compaction: null, state: "running" });
      expect(JSON.parse(readFileSync(join(s.stateDir, "assistant", "session.json"), "utf8"))).toMatchObject({ pane_id: "pane-1", workspace_id: "ws-1" });
      // its pane is there: nothing more
      await s.assistant.check();
      expect(s.opened).toHaveLength(1);
      expect(s.started).toHaveLength(0);
      // a second server on the same state takes the same session
      const again = new AssistantSession(s.stateDir, "claude", () => ({}), s.panes);
      expect(again.info()?.pane_id).toBe("pane-1");
    } finally { s.done(); }
  });

  it("checks every minute from start() until stop()", async () => {
    const s = session();
    try {
      s.assistant.start();
      const deadline = Date.now() + 5000;
      while (s.scheduled.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(s.scheduled[0]!.ms).toBe(KEEP_ALIVE_MS);
      expect(s.opened).toHaveLength(1);
    } finally { s.done(); }
  });

  it("reopens a pane that is gone in the Assistant folder, resuming the same conversation", async () => {
    for (const agent of ["claude", "codex"] as const) {
      const s = session(agent);
      try {
        await s.assistant.check();
        const startedAt = s.assistant.info()!.started_at;
        s.advance(5_000);
        // herdr cannot be asked: left as it is
        s.live.panes = null;
        await s.assistant.check();
        expect(s.opened).toHaveLength(1);
        // herdr restarted without the pane
        s.live.panes = new Map();
        await s.assistant.check();
        expect(s.opened).toHaveLength(2);
        expect(s.closed).toEqual(["ws-1"]);
        expect(s.opened[1]!.cwd).toBe(join(s.stateDir, "assistant", "agent"));
        expect(s.opened[1]!.args).toEqual(agent === "claude" ? ["--continue"] : ["resume", "--last", ...CODEX_ARGS]);
        if (agent === "codex") expect(s.opened[1]!.env["CODEX_HOME"]).toBe(join(s.stateDir, "assistant", "agent", ".codex"));
        // the same conversation: its start stays
        expect(s.assistant.info()).toMatchObject({ pane_id: "pane-2", started_at: startedAt });
      } finally { s.done(); }
    }
  });

  it("starts an agent that exited again in its pane, resuming; a resume that did not hold starts fresh", async () => {
    const s = session();
    try {
      await s.assistant.check();
      s.set("pane-1", { agent: null, status: null });
      await s.assistant.check();
      expect(s.started).toEqual([{ paneId: "pane-1", args: ["--continue"] }]);
      expect(s.opened).toHaveLength(1);
      // the resumed agent exited again (no conversation to continue): a fresh one, a new start
      s.set("pane-1", { agent: null, status: null });
      s.advance(KEEP_ALIVE_MS);
      await s.assistant.check();
      expect(s.started[1]).toEqual({ paneId: "pane-1", args: [] });
      expect(s.assistant.info()!.started_at).toBe(s.now());
    } finally { s.done(); }
  });

  it("leaves an agent waiting on a prompt as it is, and says so", async () => {
    const s = session();
    try {
      await s.assistant.check();
      s.set("pane-1", { agent: "claude", status: "blocked" });
      s.usage.context = { used: 190_000, window: 200_000 };
      await s.assistant.check();
      expect(s.assistant.info()!.state).toBe("prompt");
      expect([s.opened.length, s.started.length, s.sent.length]).toEqual([1, 0, 0]);
    } finally { s.done(); }
  });

  it("compacts only an idle agent over 70% of its context, after asking it to save notes", async () => {
    const s = session();
    try {
      await s.assistant.check();
      s.usage.context = { used: 140_000, window: 200_000 };
      await s.assistant.check();
      expect(s.sent).toEqual([]);
      s.usage.context = { used: 150_000, window: 200_000 };
      // never while it works
      s.set("pane-1", { agent: "claude", status: "working" });
      await s.assistant.check();
      expect(s.sent).toEqual([]);
      s.set("pane-1", { agent: "claude", status: "idle" });
      await s.assistant.check();
      expect(s.sent).toEqual([notesRequest("assistant")]);
      // the notes request at work, then at rest: /compact with what to keep
      s.assistant.heard("pane-1", "working");
      s.set("pane-1", { agent: "claude", status: "working" });
      await s.assistant.check();
      expect(s.sent).toHaveLength(1);
      s.set("pane-1", { agent: "claude", status: "idle" });
      s.advance(10_000);
      s.assistant.heard("pane-1", "idle");
      await s.assistant.check();
      expect(s.sent).toEqual([notesRequest("assistant"), compactCommand("claude")]);
      expect(compactCommand("claude")).toBe("/compact keep: open delegations, user preferences, what each session is doing; then reread profiles/assistant/ (SOUL.md, PROFILE.md, projects/, today's log)");
      expect(notesRequest("assistant")).toContain("profiles/assistant/");
      expect(notesRequest("assistant")).not.toContain("notes.md");
      expect(s.assistant.info()!.last_compaction).toBe(s.now());
      // a usage figure still over 70% right after does not compact again
      await s.assistant.check();
      expect(s.sent).toHaveLength(2);
      s.advance(COMPACT_COOLDOWN_MS);
      await s.assistant.check();
      expect(s.sent).toHaveLength(3);
      // a window not known: never
      const t = session();
      try {
        t.usage.context = { used: 999_999, window: null };
        await t.assistant.check(); await t.assistant.check();
        expect(t.sent).toEqual([]);
      } finally { t.done(); }
    } finally { s.done(); }
  });

  it("takes over the current session an earlier build kept under sessions/", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-earlier-"));
    mkdirSync(join(stateDir, "assistant", "sessions", "20261111-2112"), { recursive: true });
    mkdirSync(join(stateDir, "assistant", "sessions", "20261112-0900"), { recursive: true });
    writeFileSync(join(stateDir, "assistant", "sessions", "20261111-2112", "session.json"), JSON.stringify({ name: "20261111-2112", agent: "claude", started_at: 1, pane_id: null, workspace_id: null, archived_at: 2 }));
    writeFileSync(join(stateDir, "assistant", "sessions", "20261112-0900", "session.json"), JSON.stringify({ name: "20261112-0900", agent: "claude", started_at: 3, pane_id: "old-pane", workspace_id: "old-ws" }));
    const s = session("claude", stateDir);
    try {
      expect(s.assistant.info()).toMatchObject({ pane_id: "old-pane", started_at: 3 });
      s.set("old-pane", { agent: "claude", status: "idle" });
      await s.assistant.check();
      expect(s.opened).toHaveLength(0);
    } finally { s.done(); }
  });

  it("writes instructions for delegation and settings that allow ovis-task and deny ssh, scp, herdr and curl", async () => {
    const s = session("codex");
    try {
      await s.assistant.check();
      const folder = join(s.stateDir, "assistant", "agent");
      expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      const instructions = readFileSync(join(folder, "AGENTS.md"), "utf8");
      for (const line of ["ovis-task sessions", "ovis-task peek", "ovis-task send", "ovis-task open", "ovis-task graph", "graph.json", "profiles/assistant/", "SOUL.md", "PROFILE.md", "projects/", "logs/YYYY-MM-DD.md", "not in your memory", "@session(", "its SSH host"]) expect(instructions).toContain(line);
      for (const gone of ["ovis-task projects", "ovis-task create", "ovis-task list", "ovis-task read"]) expect(instructions).not.toContain(gone);
      expect(instructions).not.toContain("notes.md");
      const settings = JSON.parse(readFileSync(join(folder, ".claude", "settings.json"), "utf8")) as ReturnType<typeof claudeSettings>;
      expect(settings).toEqual(claudeSettings("assistant"));
      expect(settings.permissions.allow).toContain("Bash(ovis-task:*)");
      for (const rule of ["Bash(ssh:*)", "Bash(scp:*)", "Bash(herdr:*)", "Bash(curl:*)", "Edit(./.claude/**)"]) expect(settings.permissions.deny).toContain(rule);
      // nothing outside the allow list runs, asked or not, and the Assistant is never started full auto
      expect(settings.permissions.defaultMode).toBe("dontAsk");
      expect(s.opened[0]!.args).toEqual(CODEX_ARGS);
      expect(s.opened[0]!.args.join(" ")).not.toMatch(/dangerously|yolo|full-auto|never|untrusted/);
      expect(s.opened[0]!.env["CODEX_HOME"]).toBe(join(folder, ".codex"));
      if (process.platform !== "win32") expect(readlinkSync(join(folder, ".codex", "auth.json"))).toBe(userCodexAuth());
      const rules = readFileSync(join(folder, ".codex", "rules", "ovis-task.rules"), "utf8");
      expect(rules).toContain('prefix_rule(pattern=["ovis-task"], decision="allow")');
      // the Assistant's own profile survives the folder being written again (every pane it opens)
      writeFileSync(join(folder, "profiles", "assistant", "PROFILE.md"), "kept");
      writeAgentFolder(folder);
      expect(readFileSync(join(folder, "profiles", "assistant", "PROFILE.md"), "utf8")).toBe("kept");
      expect(existsSync(join(folder, "notes.md"))).toBe(false);
      expect(compactCommand("codex")).toBe("/compact");
    } finally { s.done(); }
  });

  it("seeds the profile folder once and lets the agent edit only its own profile", () => {
    const folder = mkdtempSync(join(tmpdir(), "ovis-assistant-profile-"));
    try {
      writeAgentFolder(folder, undefined, "second");
      const own = join(folder, "profiles", "second");
      expect(readdirSync(own).sort()).toEqual(["PROFILE.md", "SOUL.md", "logs", "projects"]);
      writeFileSync(join(own, "SOUL.md"), "refined by the agent");
      writeAgentFolder(folder, undefined, "second");
      expect(readFileSync(join(own, "SOUL.md"), "utf8")).toBe("refined by the agent");
      const { allow, deny } = claudeSettings("second").permissions;
      expect(allow.filter((rule) => /^(Edit|Write)\(/.test(rule))).toEqual(["Edit(./profiles/second/**)", "Write(./profiles/second/**)"]);
      expect(deny).toContain("Edit(./graph.json)");
      expect(JSON.parse(readFileSync(join(folder, ".claude", "settings.json"), "utf8"))).toEqual(claudeSettings("second"));
      expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toContain("profiles/second/");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("moves notes.md into the profile byte for byte, once, and asks a resting Assistant once to distill it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-migrate-"));
    const folder = join(stateDir, "assistant", "agent");
    mkdirSync(folder, { recursive: true });
    const notes = Buffer.from("# Notes\n\n- macbook: ~/ovis é\r\nno newline at end", "utf8");
    writeFileSync(join(folder, "notes.md"), notes);
    // a session.json of the build before profiles: no profile field
    writeFileSync(join(stateDir, "assistant", "session.json"), JSON.stringify({ agent: "claude", started_at: 1, pane_id: "pane-9", workspace_id: "ws-9", last_compaction: null }));
    const s = session("claude", stateDir);
    try {
      expect(s.assistant.profile).toBe("assistant");
      s.set("pane-9", { agent: "claude", status: "working" });
      await s.assistant.check();
      const logs = join(folder, "profiles", "assistant", "logs");
      const file = `${logDay(s.now())}-notes-import.md`;
      expect(readdirSync(logs)).toEqual([file]);
      expect(readFileSync(join(logs, file)).equals(notes)).toBe(true);
      expect(readFileSync(join(folder, "notes.md.migrated")).equals(notes)).toBe(true);
      expect(existsSync(join(folder, "notes.md"))).toBe(false);
      // never while it works; once it is at rest, one request
      expect(s.sent).toEqual([]);
      s.set("pane-9", { agent: "claude", status: "idle" });
      await s.assistant.check();
      expect(s.sent).toEqual([distillRequest("assistant", file)]);
      await s.assistant.check();
      expect(s.sent).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(stateDir, "assistant", "session.json"), "utf8"))).toMatchObject({ profile: "assistant", profile_migrated_asked: true });
      // a notes.md that shows up again is not imported a second time
      writeFileSync(join(folder, "notes.md"), "later");
      writeAgentFolder(folder, undefined, "assistant", s.now() + 86_400_000);
      expect(readdirSync(logs)).toEqual([file]);
      expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("later");
      // a server started again does not ask again
      const again = session("claude", stateDir);
      again.set("pane-9", { agent: "claude", status: "idle" });
      await again.assistant.check();
      expect(again.sent).toEqual([]);
      again.assistant.stop();
    } finally { s.done(); }
  });

  it("opens with the ovis-task token and bin on the pane's environment, and has no restart route", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-server-"));
    const { panes, opened } = fakePanes();
    const profile: HerdrMachineProfile = { id: "sessions-test", label: "Test PC", enabled: true, target: { destination: "sessions-test.invalid" } };
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: true, assistantRun: async () => "", assistantPanes: panes, herdrProfiles: async () => [profile] });
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const deadline = Date.now() + 5000;
      while (opened.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      const state = (await (await fetch(`${base}/api/assistant`)).json()) as AssistantState;
      expect(state.session).toMatchObject({ agent: "claude", pane_id: "pane-1", last_compaction: null, state: "running" });
      const token = (JSON.parse(readFileSync(join(stateDir, "assistant", "cli-token.json"), "utf8")) as { token: string }).token;
      expect(opened[0]!.env).toMatchObject({ OVIS_TASK_URL: `http://127.0.0.1:${app.port}`, OVIS_TASK_TOKEN: token, OVIS_BUN: process.execPath });
      expect(opened[0]!.env["PATH"]!.split(process.platform === "win32" ? ";" : ":")[0]).toBe(join(import.meta.dir, "..", "bin"));
      // no New chat, no archive and no restart route (Restart Assistant sends /clear to the pane, in the app)
      for (const [path, method] of [["/restart", "POST"], ["/sessions", "POST"], ["/sessions/20261111-2112", "GET"], ["/projects", "POST"], ["/tasks/1/approve", "POST"]] as const) {
        expect((await fetch(`${base}/api/assistant${path}`, { method, headers: { origin: base, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(404);
      }
    } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});
