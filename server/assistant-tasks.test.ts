import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantProject, AssistantTask } from "../shared/assistant.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Assistant } from "./assistant.ts";
import { AssistantError } from "./assistant.ts";
import { statusAfter, taskSlug, type TaskBridge } from "./assistant-tasks.ts";
import { cliRequest } from "./ovis-task-cli.ts";

/**
 * Tasks against a fake machine and a fake bridge: every call the task runner makes to a machine is
 * recorded and answered here, so no test reaches a real PC or the user's herdr.
 */
const PROJECT: AssistantProject = { id: "app", machine: "m1", path: "/home/me/app", mergeMode: "pr", defaultAgent: "claude" };
const snapshot = (panes: { pane_id: string; agent_status: string; agent?: string | null }[], workspaces: unknown[] = []) =>
  ({ panes: panes.map((pane) => ({ workspace_id: "w9", tab_id: "t9", terminal_id: "x", focused: false, revision: 0, agent: "claude", ...pane })), workspaces, tabs: [], agents: [], layouts: [], protocol: 22, version: "0" }) as unknown as SessionSnapshot;

function fixture(options: { stateDir?: string; state?: Machine["state"]; workspaces?: unknown[]; now?: () => number } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-tasks-"));
  mkdirSync(join(stateDir, "assistant"), { recursive: true });
  writeFileSync(join(stateDir, "assistant", "projects.json"), JSON.stringify([PROJECT]));
  const machine: Machine = { id: "m1", herdr_profile_id: "p1", name: "Laptop", kind: "ssh", target: { destination: "laptop.invalid" }, enabled: true, state: options.state ?? "connected", error: null, snapshot: snapshot([], options.workspaces) };
  const calls: { path: string; method?: string; body?: unknown; query?: Record<string, string> }[] = [];
  const answers: Record<string, (body: unknown) => unknown> = {
    "workspace/create": () => ({ workspace_id: "w1", pane_id: "p0", agent_started: false }),
    "worktree/create": () => ({ workspace_id: "w2", pane_id: "p1", path: "/home/me/.herdr/worktrees/app/assistant-1-fix-login", branch: "assistant/1-fix-login", agent_started: true }),
    "pane/close": () => ({ ok: true }),
    "pane/read": () => ({ read: { text: "line one\nline two" } }),
    "pane/prompt": () => ({ prompt: { id: "q1", agent: "claude", kind: "question", title: "", question: "Which database?", body: null, options: [{ label: "Postgres", description: null }, { label: "SQLite", description: null }], multi_select: false, custom_option_index: null } }),
    "pane/prompt/answer": () => ({ ok: true }),
  };
  const bridge: TaskBridge = async (machineId, path, request = {}) => {
    expect(machineId).toBe("m1");
    calls.push({ path, ...request });
    return answers[path]!(request.body);
  };
  let listener: ((event: MachineEvent) => void) | undefined;
  const assistant = new Assistant(stateDir, { list: () => [machine], subscribe: (next) => { listener = next; return () => { listener = undefined; }; }, retryNow: () => {} },
    async () => "herdr\nclaude\n", { bridge, timer: () => () => {}, intervalMs: 1000, ...(options.now ? { now: options.now } : {}) });
  // the watcher learns of the machine as Remote PCs tells it
  listener!({ type: "machines", machines: [machine] });
  const frame = (message: unknown) => listener!({ type: "machine-message", machine_id: "m1", message } as MachineEvent);
  const task = (id = "1") => assistant.tasks.get(id);
  const done = () => { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); };
  return { assistant, machine, calls, answers, frame, task, stateDir, done };
}

const create = (assistant: Assistant, body: Record<string, unknown> = {}) => assistant.tasks.create({ project: "app", title: "Fix login", brief: "The login form\nrejects valid emails.", ...body });
const refusal = async (promise: Promise<unknown>) => { try { await promise; return null; } catch (error) { return error instanceof AssistantError ? error.code : String(error); } };

describe("starting a task", () => {
  it("makes a worktree on the project's machine with a full-auto agent and the brief as its first prompt", async () => {
    const { assistant, calls, stateDir, done } = fixture({ workspaces: [{ workspace_id: "w0", worktree: { checkout_path: PROJECT.path, is_linked_worktree: false } }] });
    try {
      const task = await create(assistant, { review: true, cron: "0 9 * * 1" });
      expect(task).toMatchObject({ id: "1", status: "working", paneId: "p1", workspaceId: "w2", worktree: "/home/me/.herdr/worktrees/app/assistant-1-fix-login", branch: "assistant/1-fix-login", agent: "claude", review: true, autoMerge: false, cron: "0 9 * * 1" });
      // the workspace already open on the checkout is the source; no other workspace is made
      expect(calls).toEqual([{ path: "worktree/create", method: "POST", body: {
        workspace_id: "w0", branch: "assistant/1-fix-login", label: "Fix login", agent: { kind: "claude", args: ["--", "The login form rejects valid emails."] },
      } }]);
      // herdr's focus is never asked for, and nothing takes over a pane
      expect(JSON.stringify(calls)).not.toMatch(/focus|takeover/);
      const path = join(stateDir, "assistant", "tasks.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect((JSON.parse(readFileSync(path, "utf8")) as AssistantTask[])[0]!.brief).toBe("The login form\nrejects valid emails.");
    } finally { done(); }
  });

  it("opens a workspace on the checkout when none is, and takes --agent over the project's default", async () => {
    const { assistant, calls, done } = fixture();
    try {
      expect(await create(assistant, { agent: "codex" })).toMatchObject({ agent: "codex", status: "working" });
      expect(calls.map((call) => call.path)).toEqual(["workspace/create", "worktree/create"]);
      expect(calls[0]!.body).toEqual({ cwd: PROJECT.path, label: "app" });
      expect(calls[1]!.body).toMatchObject({ workspace_id: "w1", agent: { kind: "codex" } });
    } finally { done(); }
  });

  it("refuses an unknown project, an empty brief and the rest before anything runs", async () => {
    const { assistant, calls, done } = fixture();
    try {
      expect(await refusal(create(assistant, { project: "nope" }))).toBe("unknown_project");
      expect(await refusal(create(assistant, { brief: "  " }))).toBe("invalid_brief");
      expect(await refusal(create(assistant, { brief: "a\u001b[2Jb" }))).toBe("invalid_brief");
      expect(await refusal(create(assistant, { title: "" }))).toBe("invalid_title");
      expect(await refusal(create(assistant, { agent: "gemini" }))).toBe("invalid_agent");
      expect(await refusal(create(assistant, { after: "9" }))).toBe("unknown_task");
      expect(await refusal(create(assistant, { at: "someday" }))).toBe("invalid_at");
      expect(await refusal(create(assistant, { cron: "every day" }))).toBe("invalid_cron");
      expect(calls).toEqual([]);
      expect(assistant.tasks.list()).toEqual([]);
    } finally { done(); }
  });

  it("refuses a task while its machine is down", async () => {
    const { assistant, calls, done } = fixture({ state: "reconnecting" });
    try {
      expect(await refusal(create(assistant))).toBe("machine_offline");
      expect(calls).toEqual([]);
      expect(assistant.tasks.list()).toEqual([]);
    } finally { done(); }
  });

  it("fails a task whose agent did not start, keeping its worktree for a restart", async () => {
    const { assistant, answers, calls, task, done } = fixture();
    try {
      answers["worktree/create"] = () => ({ workspace_id: "w2", pane_id: "p1", path: "/wt/1", agent_started: false, error: { message: "claude: not found" } });
      expect(await refusal(create(assistant))).toBe("agent_not_started");
      expect(task()).toMatchObject({ status: "failed", worktree: "/wt/1", error: "claude: not found" });
      calls.length = 0;
      answers["workspace/create"] = () => ({ workspace_id: "w3", pane_id: "p3", agent_started: true });
      expect(await assistant.tasks.restart("1")).toMatchObject({ status: "working", paneId: "p3", workspaceId: "w3" });
      expect(calls).toEqual([{ path: "workspace/create", method: "POST", body: { cwd: "/wt/1", label: "Fix login", agent: { kind: "claude", args: ["--", "Continue this task; earlier work may already be in this worktree. The login form rejects valid emails."] } } }]);
      expect(task().error).toBeUndefined();
      expect(await refusal(assistant.tasks.restart("1"))).toBe("not_restartable");
    } finally { done(); }
  });

  it("names its branch after its id and title", () => {
    expect(taskSlug("Fix the Login form (urgent!)")).toBe("fix-the-login-form-urgent");
    expect(taskSlug("日本語")).toBe("task");
  });
});

describe("a task's status", () => {
  it("follows herdr's agent state of its pane", async () => {
    const { assistant, frame, task, done } = fixture();
    try {
      await create(assistant);
      // at rest before it ever worked: still starting, not Ready
      frame({ type: "pane-status", pane_id: "p1", agent_status: "idle" });
      expect(task().status).toBe("working");
      frame({ type: "pane-status", pane_id: "p1", agent_status: "working" });
      frame({ type: "pane-status", pane_id: "p1", agent_status: "blocked" });
      expect(task().status).toBe("needs_you");
      frame({ type: "pane-status", pane_id: "p1", agent_status: "working" });
      expect(task().status).toBe("working");
      // at rest with its background work still running is still at work
      frame({ type: "pane-status", pane_id: "p1", agent_status: "done", background_wait: true });
      expect(task().status).toBe("working");
      frame({ type: "pane-status", pane_id: "p1", agent_status: "done" });
      expect(task().status).toBe("ready");
      // another machine's pane of the same id is not this task's
      frame({ type: "pane-status", pane_id: "p2", agent_status: "blocked" });
      expect(task().status).toBe("ready");
    } finally { done(); }
  });

  it("maps each agent state", () => {
    expect(statusAfter({ status: "working" }, "blocked")).toEqual({ status: "needs_you", worked: true });
    expect(statusAfter({ status: "working", worked: true }, "idle")).toEqual({ status: "ready", worked: true });
    expect(statusAfter({ status: "working" }, "done")).toBeNull();
    expect(statusAfter({ status: "cancelled", worked: true }, "working")).toBeNull();
  });

  it("fails when its pane closes or is gone from the machine", async () => {
    let now = 1_000_000;
    const { assistant, machine, frame, task, done } = fixture({ now: () => now });
    try {
      await create(assistant);
      frame({ type: "pane-exited", pane_id: "p1" });
      expect(task()).toMatchObject({ status: "failed", error: "The agent's pane closed" });

      await create(assistant, { title: "Second" });
      machine.snapshot = snapshot([]);
      // just started: the snapshot may not hold it yet
      await assistant.check("m1");
      expect(task("2").status).toBe("working");
      now += 5000;
      await assistant.check("m1");
      expect(task("2")).toMatchObject({ status: "failed", error: "The agent's pane is gone" });
    } finally { done(); }
  });

  it("catches up from the machine's snapshot, and fails a running task whose agent stopped", async () => {
    let now = 1_000_000;
    const { assistant, machine, task, done } = fixture({ now: () => now });
    try {
      await create(assistant);
      machine.snapshot = snapshot([{ pane_id: "p1", agent_status: "blocked" }]);
      await assistant.check("m1");
      expect(task().status).toBe("needs_you");
      now += 5000;
      machine.snapshot = snapshot([{ pane_id: "p1", agent_status: "unknown", agent: null }]);
      await assistant.check("m1");
      expect(task()).toMatchObject({ status: "failed", error: "The agent stopped" });
      expect(assistant.state().tasks.map((shown) => shown.id)).toEqual(["1"]);
    } finally { done(); }
  });

  it("is kept across a restart of the server", async () => {
    const first = fixture();
    const stateDir = first.stateDir;
    await create(first.assistant);
    first.frame({ type: "pane-status", pane_id: "p1", agent_status: "blocked" });
    first.assistant.stop();
    const second = fixture({ stateDir });
    try {
      expect(second.task()).toMatchObject({ status: "needs_you", paneId: "p1", worked: true });
      second.frame({ type: "pane-status", pane_id: "p1", agent_status: "done" });
      expect(second.task().status).toBe("ready");
    } finally { second.done(); }
  });
});

describe("answering and cancelling", () => {
  it("answers through the prompt-answer route, by number, label or nothing else", async () => {
    const { assistant, calls, frame, done } = fixture();
    try {
      await create(assistant);
      expect(await refusal(assistant.tasks.answer("1", "1"))).toBe("not_waiting");
      frame({ type: "pane-status", pane_id: "p1", agent_status: "blocked" });
      calls.length = 0;
      expect(await assistant.tasks.answer("1", "2")).toEqual({ answered: "SQLite" });
      expect(await assistant.tasks.answer("1", "postgres")).toEqual({ answered: "Postgres" });
      expect(calls.filter((call) => call.path === "pane/prompt/answer").map((call) => call.body)).toEqual([
        { pane_id: "p1", prompt_id: "q1", option_index: 1 },
        { pane_id: "p1", prompt_id: "q1", option_index: 0 },
      ]);
      expect(await refusal(assistant.tasks.answer("1", "MySQL"))).toBe("invalid_choice");
      // never keys typed into the pane
      expect(calls.some((call) => call.path === "pane/input" || call.path === "pane/keys")).toBe(false);
    } finally { done(); }
  });

  it("shows the end of the pane", async () => {
    const { assistant, done } = fixture();
    try {
      await create(assistant);
      expect(await assistant.tasks.show("1")).toMatchObject({ id: "1", output: "line one\nline two" });
    } finally { done(); }
  });

  it("closes the pane on cancel and keeps the worktree", async () => {
    const { assistant, calls, task, done } = fixture();
    try {
      await create(assistant);
      calls.length = 0;
      expect(await assistant.tasks.cancel("1")).toMatchObject({ status: "cancelled", worktree: "/home/me/.herdr/worktrees/app/assistant-1-fix-login" });
      expect(calls).toEqual([{ path: "pane/close", method: "POST", body: { pane_id: "p1" } }]);
      expect(await refusal(assistant.tasks.cancel("1"))).toBe("finished");
      expect(task().status).toBe("cancelled");
    } finally { done(); }
  });
});

describe("ovis-task's task commands", () => {
  it("makes requests of create, list, show, answer and cancel", () => {
    expect(cliRequest(["create", "app", "--title", "Fix login", "--brief", "Do it", "--agent", "codex", "--review", "--at", "2026-11-12T09:00"])).toEqual({
      path: "create", body: { project: "app", title: "Fix login", brief: "Do it", agent: "codex", review: true, autoMerge: undefined, after: undefined, at: "2026-11-12T09:00", cron: undefined },
    });
    expect(cliRequest(["list", "--status", "needs_you"])).toEqual({ path: "list?status=needs_you" });
    expect(cliRequest(["show", "3"])).toEqual({ path: "show", body: { id: "3" } });
    expect(cliRequest(["answer", "3", "2"])).toEqual({ path: "answer", body: { id: "3", choice: "2" } });
    expect(cliRequest(["cancel", "3"])).toEqual({ path: "cancel", body: { id: "3" } });
    expect("usage" in cliRequest(["create", "app", "--title", "x"])).toBe(true);
    expect("usage" in cliRequest(["create", "app", "--title", "x", "--brief", "y", "--force"])).toBe(true);
  });

  it("refuses approve: only the user approves, in the app", () => {
    expect(cliRequest(["approve", "3"])).toEqual({ refused: "ovis-task approve is refused: only the user approves a task, in the app" });
  });
});
