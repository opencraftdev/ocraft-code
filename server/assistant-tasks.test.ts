import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantProject, AssistantTask } from "../shared/assistant.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Assistant, type RunScript } from "./assistant.ts";
import { AssistantError } from "./assistant.ts";
import { cleanupScript, localMergeScript, parseVerdict, statusAfter, taskSlug, VERDICT_NUDGE, type TaskBridge } from "./assistant-tasks.ts";
import { shellQuote } from "./machine-security.ts";
import { cliRequest } from "./ovis-task-cli.ts";

/**
 * Tasks against a fake machine and a fake bridge: every call the task runner makes to a machine is
 * recorded and answered here, so no test reaches a real PC or the user's herdr.
 */
const PROJECT: AssistantProject = { id: "app", machine: "m1", path: "/home/me/app", mergeMode: "pr", defaultAgent: "claude" };
const snapshot = (panes: { pane_id: string; agent_status: string; agent?: string | null }[], workspaces: unknown[] = []) =>
  ({ panes: panes.map((pane) => ({ workspace_id: "w9", tab_id: "t9", terminal_id: "x", focused: false, revision: 0, agent: "claude", ...pane })), workspaces, tabs: [], agents: [], layouts: [], protocol: 22, version: "0" }) as unknown as SessionSnapshot;

function fixture(options: { stateDir?: string; state?: Machine["state"]; workspaces?: unknown[]; now?: () => number; project?: Partial<AssistantProject>; run?: RunScript } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-tasks-"));
  mkdirSync(join(stateDir, "assistant"), { recursive: true });
  writeFileSync(join(stateDir, "assistant", "projects.json"), JSON.stringify([{ ...PROJECT, ...options.project }]));
  const machine: Machine = { id: "m1", herdr_profile_id: "p1", name: "Laptop", kind: "ssh", target: { destination: "laptop.invalid" }, enabled: true, state: options.state ?? "connected", error: null, snapshot: snapshot([], options.workspaces) };
  const calls: { path: string; method?: string; body?: unknown; query?: Record<string, string> }[] = [];
  const answers: Record<string, (body: unknown) => unknown> = {
    "workspace/create": () => ({ workspace_id: "w1", pane_id: "p0", agent_started: false }),
    "worktree/create": () => ({ workspace_id: "w2", pane_id: `p${(started += 1)}`, path: "/home/me/.herdr/worktrees/app/assistant-1-fix-login", branch: "assistant/1-fix-login", agent_started: true }),
    "pane/close": () => ({ ok: true }),
    "pane/read": () => ({ read: { text: "line one\nline two" } }),
    "pane/prompt": () => ({ prompt: { id: "q1", agent: "claude", kind: "question", title: "", question: "Which database?", body: null, options: [{ label: "Postgres", description: null }, { label: "SQLite", description: null }], multi_select: false, custom_option_index: null } }),
    "pane/prompt/answer": () => ({ ok: true }),
    "pane/input": () => ({ ok: true }),
    "pane/keys": () => ({ ok: true }),
    "pane/conversation": () => ({ source: "claude-transcript", turns: [] }),
    "worktree/remove": () => ({ ok: true }),
  };
  // every script a machine is asked to run, answered as a machine whose checkout is on main and whose gh works
  const scripts: string[] = [];
  const run: RunScript = options.run ?? (async (_machine, script) => {
    scripts.push(script);
    if (script.includes("symbolic-ref --short HEAD") && !script.includes("rev-list")) return "main\n";
    if (script.includes("gh pr create")) return "ok\nhttps://github.com/me/app/pull/7\n";
    if (script.includes("gh pr merge") || script.includes("worktree prune")) return "ok\n";
    return "herdr\nclaude\n";
  });
  const bridge: TaskBridge = async (machineId, path, request = {}) => {
    expect(machineId).toBe("m1");
    calls.push({ path, ...request });
    return answers[path]!(request.body);
  };
  let started = 0;
  let listener: ((event: MachineEvent) => void) | undefined;
  const assistant = new Assistant(stateDir, { list: () => [machine], subscribe: (next) => { listener = next; return () => { listener = undefined; }; }, retryNow: () => {} },
    run, { bridge, timer: () => () => {}, intervalMs: 1000, ...(options.now ? { now: options.now } : {}) });
  // the watcher learns of the machine as Remote PCs tells it
  listener!({ type: "machines", machines: [machine] });
  const frame = (message: unknown) => listener!({ type: "machine-message", machine_id: "m1", message } as MachineEvent);
  const task = (id = "1") => assistant.tasks.get(id);
  const done = () => { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); };
  return { assistant, machine, calls, answers, scripts, frame, task, stateDir, done, machinesChanged: () => listener!({ type: "machines", machines: [machine] }) };
}

const create = (assistant: Assistant, body: Record<string, unknown> = {}) => assistant.tasks.create({ project: "app", title: "Fix login", brief: "The login form rejects valid emails.", ...body });
const refusal = async (promise: Promise<unknown>) => { try { await promise; return null; } catch (error) { return error instanceof AssistantError ? error.code : String(error); } };

describe("starting a task", () => {
  it("makes a worktree on the project's machine with a full-auto agent and the brief as its first prompt", async () => {
    const { assistant, calls, stateDir, done } = fixture({ workspaces: [{ workspace_id: "w0", worktree: { checkout_path: PROJECT.path, is_linked_worktree: false } }] });
    try {
      const task = await create(assistant, { review: true });
      expect(task).toMatchObject({ id: "1", status: "working", paneId: "p1", workspaceId: "w2", worktree: "/home/me/.herdr/worktrees/app/assistant-1-fix-login", branch: "assistant/1-fix-login", agent: "claude", review: true, autoMerge: false });
      // the workspace already open on the checkout is the source; no other workspace is made
      expect(calls).toEqual([{ path: "worktree/create", method: "POST", body: {
        workspace_id: "w0", branch: "assistant/1-fix-login", label: "Fix login", agent: { kind: "claude", args: ["--", "The login form rejects valid emails."] },
      } }]);
      // herdr's focus is never asked for, and nothing takes over a pane
      expect(JSON.stringify(calls)).not.toMatch(/focus|takeover/);
      const path = join(stateDir, "assistant", "tasks.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect((JSON.parse(readFileSync(path, "utf8")) as AssistantTask[])[0]!.brief).toBe("The login form rejects valid emails.");
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
      expect(await refusal(create(assistant, { cron: "61 * * * *" }))).toBe("invalid_cron");
      // a date no calendar has
      expect(await refusal(create(assistant, { cron: "0 0 31 2 *" }))).toBe("invalid_cron");
      expect(await refusal(create(assistant, { cron: "0 9 * * *", at: "09:00" }))).toBe("invalid_cron");
      expect(await refusal(create(assistant, { at: "25:00" }))).toBe("invalid_at");
      expect(calls).toEqual([]);
      expect(assistant.tasks.list()).toEqual([]);
    } finally { done(); }
  });

  it("fails a task whose agent did not start, keeping its worktree for a restart", async () => {
    const { assistant, answers, calls, task, done } = fixture();
    try {
      answers["worktree/create"] = () => ({ workspace_id: "w2", pane_id: "p1", path: "/wt/1", agent_started: false, error: { message: "claude: not found" } });
      expect(await create(assistant)).toMatchObject({ status: "failed", worktree: "/wt/1", error: "claude: not found" });
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

describe("the queue", () => {
  // 08:00 on a Thursday, the VM's local time
  const MORNING = new Date(2026, 10, 12, 8, 0).getTime();
  const MINUTE = 60_000;
  const clock = (start = MORNING) => { const state = { now: start }; return { state, now: () => state.now }; };
  const statuses = (assistant: Assistant) => Object.fromEntries(assistant.tasks.list().map((task) => [task.id, task.status]));

  it("keeps to the machine's Max running and starts the oldest waiting task first", async () => {
    const { assistant, frame, done } = fixture();
    try {
      assistant.setMachine("m1", { maxRunning: 2 });
      for (const title of ["One", "Two", "Three", "Four"]) await create(assistant, { title });
      expect(statuses(assistant)).toEqual({ 1: "working", 2: "working", 3: "queued", 4: "queued" });
      // Needs you still holds its slot
      frame({ type: "pane-status", pane_id: "p1", agent_status: "blocked" });
      await assistant.tasks.runQueue();
      expect(statuses(assistant)).toMatchObject({ 3: "queued" });
      // Ready frees it, for the oldest of the waiting ones
      frame({ type: "pane-status", pane_id: "p1", agent_status: "done" });
      await assistant.tasks.runQueue();
      expect(statuses(assistant)).toEqual({ 1: "ready", 2: "working", 3: "working", 4: "queued" });
      // a higher Max running starts the rest at once
      assistant.setMachine("m1", { maxRunning: 3 });
      await assistant.tasks.runQueue();
      expect(statuses(assistant)[4]).toBe("working");
    } finally { done(); }
  });

  it("keeps a task Queued while its machine is down, and starts it when the machine is back", async () => {
    const { assistant, machine, calls, machinesChanged, done } = fixture({ state: "reconnecting" });
    try {
      expect(await create(assistant)).toMatchObject({ status: "queued", paneId: null });
      await assistant.tasks.runQueue();
      expect(calls).toEqual([]);
      machine.state = "connected";
      machinesChanged();
      await assistant.tasks.runQueue();
      expect(assistant.tasks.get("1")).toMatchObject({ status: "working", paneId: "p1" });
    } finally { done(); }
  });

  it("waits for an --after task to be Done, and fails when that one is cancelled", async () => {
    const first = fixture();
    const stateDir = first.stateDir;
    await create(first.assistant, { title: "First" });
    expect(await create(first.assistant, { title: "Second", after: "1" })).toMatchObject({ status: "queued", after: "1" });
    first.frame({ type: "pane-status", pane_id: "p1", agent_status: "working" });
    first.frame({ type: "pane-status", pane_id: "p1", agent_status: "done" });
    await first.assistant.tasks.runQueue();
    // Ready is not Done
    expect(first.task("2").status).toBe("queued");
    first.assistant.stop();
    // phase 6's merge makes a task Done; here the file says so
    const path = join(stateDir, "assistant", "tasks.json");
    writeFileSync(path, JSON.stringify((JSON.parse(readFileSync(path, "utf8")) as AssistantTask[]).map((task) => task.id === "1" ? { ...task, status: "done" } : task)));
    const second = fixture({ stateDir });
    try {
      await second.assistant.tasks.runQueue();
      expect(second.task("2").status).toBe("working");
      await create(second.assistant, { title: "Third", after: "2" });
      await second.assistant.tasks.cancel("2");
      await second.assistant.tasks.runQueue();
      expect(second.task("3")).toMatchObject({ status: "failed", error: "Task #2, which it waited for, was cancelled" });
    } finally { second.done(); }
  });

  it("holds an --at task Scheduled until its time, then queues and starts it", async () => {
    const time = clock();
    const { assistant, calls, done } = fixture({ now: time.now });
    try {
      const task = await create(assistant, { at: "09:30" });
      expect(task).toMatchObject({ status: "scheduled", at: new Date(2026, 10, 12, 9, 30).toISOString() });
      time.state.now += 89 * MINUTE;
      await assistant.tasks.runQueue();
      expect(calls).toEqual([]);
      time.state.now += MINUTE;
      await assistant.tasks.runQueue();
      expect(assistant.tasks.get("1").status).toBe("working");
      // a clock time already passed today is tomorrow's; one in the past is queued at once
      expect(await create(assistant, { title: "Tomorrow", at: "07:00" })).toMatchObject({ status: "scheduled", at: new Date(2026, 10, 13, 7, 0).toISOString() });
      expect((await create(assistant, { title: "Late", at: "2026-11-01T09:00" })).status).toBe("working");
    } finally { done(); }
  });

  it("fires a cron template once per slot into a new task, and cancelling the template stops it", async () => {
    const time = clock();
    const { assistant, calls, done } = fixture({ now: time.now });
    try {
      const template = await create(assistant, { cron: "0 9 * * *", review: true });
      expect(template).toMatchObject({ status: "scheduled", cron: "0 9 * * *", next: new Date(2026, 10, 12, 9, 0).getTime() });
      expect(calls).toEqual([]);
      time.state.now = new Date(2026, 10, 12, 9, 0, 20).getTime();
      await assistant.tasks.runQueue();
      await assistant.tasks.runQueue();
      expect(assistant.tasks.list().map(({ id, status, fromCron, cron }) => ({ id, status, fromCron, cron }))).toEqual([
        { id: "2", status: "working", fromCron: "1", cron: undefined },
        { id: "1", status: "scheduled", fromCron: undefined, cron: "0 9 * * *" },
      ]);
      expect(assistant.tasks.get("2")).toMatchObject({ title: "Fix login", review: true, branch: "assistant/2-fix-login" });
      expect(assistant.tasks.get("1").next).toBe(new Date(2026, 10, 13, 9, 0).getTime());
      // an --after names a task, not a template
      expect(await refusal(create(assistant, { after: "1" }))).toBe("invalid_after");
      expect(await assistant.tasks.cancel("1")).toMatchObject({ status: "cancelled" });
      time.state.now = new Date(2026, 10, 14, 9, 0).getTime();
      await assistant.tasks.runQueue();
      expect(assistant.tasks.list().length).toBe(2);
    } finally { done(); }
  });

  it("after a restart neither fires a slot twice nor once per missed slot", async () => {
    const time = clock();
    const first = fixture({ now: time.now });
    const stateDir = first.stateDir;
    await create(first.assistant, { cron: "*/10 * * * *" });
    time.state.now = MORNING + 10 * MINUTE;
    await first.assistant.tasks.runQueue();
    expect(first.assistant.tasks.list().length).toBe(2);
    first.assistant.stop();
    // the same minute again: already fired
    const again = fixture({ stateDir, now: time.now });
    await again.assistant.tasks.runQueue();
    expect(again.assistant.tasks.list().length).toBe(2);
    again.assistant.stop();
    // down for five slots: the start fires once for them, and the next fire time is after now
    time.state.now = MORNING + 65 * MINUTE;
    const later = fixture({ stateDir, now: time.now });
    try {
      await later.assistant.tasks.runQueue();
      expect(later.assistant.tasks.list().filter((task) => task.fromCron === "1").length).toBe(2);
      expect(later.task("1").next).toBe(MORNING + 70 * MINUTE);
    } finally { later.done(); }
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

/** a task at rest after it worked: Ready, and the steps Ready starts have run */
async function ready(fx: ReturnType<typeof fixture>, pane = "p1") {
  fx.frame({ type: "pane-status", pane_id: pane, agent_status: "working" });
  fx.frame({ type: "pane-status", pane_id: pane, agent_status: "done" });
  await fx.assistant.tasks.settled();
}
const reply = (text: string) => ({ source: "claude-transcript", turns: [{ role: "user", ts: null, parts: [{ kind: "text", text: "Review ... REVIEW: PASS ..." }] }, { role: "assistant", ts: null, parts: [{ kind: "text", text }] }] });
/** reviewers start as panes r1, r2, ... */
function reviewers(fx: ReturnType<typeof fixture>) {
  let opened = 0;
  fx.answers["workspace/create"] = () => ({ workspace_id: `wr${opened + 1}`, pane_id: `r${(opened += 1)}`, agent_started: true });
}
async function verdict(fx: ReturnType<typeof fixture>, pane: string, text: string) {
  fx.answers["pane/conversation"] = () => reply(text);
  fx.frame({ type: "pane-status", pane_id: pane, agent_status: "done" });
  await fx.assistant.tasks.settled();
}

describe("review", () => {
  it("starts a fresh reviewer in the worktree at Ready, and a pass makes the task Ready (reviewed) and opens its PR", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { review: true });
      reviewers(fx);
      await ready(fx);
      expect(fx.task()).toMatchObject({ status: "reviewing", reviewPaneId: "r1", reviewRounds: 1, base: "main" });
      const opened = fx.calls.filter((call) => call.path === "workspace/create").at(-1)!;
      expect(opened.body).toMatchObject({ cwd: "/home/me/.herdr/worktrees/app/assistant-1-fix-login", agent: { kind: "claude" } });
      const prompt = (opened.body as { agent: { args: string[] } }).agent.args[1]!;
      expect(prompt).toContain("git diff main...HEAD");
      expect(prompt).toContain("REVIEW: PASS");
      // no verdict yet (it has not answered): it waits
      await verdict(fx, "r1", "Reading the diff now.");
      expect(fx.task().status).toBe("reviewing");
      await verdict(fx, "r1", "All good.\n**REVIEW: PASS**");
      expect(fx.task()).toMatchObject({ status: "ready", reviewed: true, prUrl: "https://github.com/me/app/pull/7" });
      expect(fx.task().reviewPaneId).toBeUndefined();
      expect(fx.calls).toContainEqual({ path: "pane/close", method: "POST", body: { pane_id: "r1" } });
      // it answered at once: nothing nudged it
      expect(fx.calls.some((call) => call.path === "pane/input")).toBe(false);
      expect(fx.scripts.find((script) => script.includes("gh pr create"))).toContain("Reviewed by a second agent: passed after 1 round(s).");
      // Approve is the user's: nothing merged by itself
      expect(fx.scripts.some((script) => script.includes("gh pr merge"))).toBe(false);
    } finally { fx.done(); }
  });

  it("sends findings back to the task's agent, and after three rounds hands them to the user", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { review: true });
      reviewers(fx);
      await ready(fx);
      for (const round of [1, 2]) {
        await verdict(fx, `r${round}`, `Some notes.\nREVIEW: FINDINGS\n- round ${round}: the test is missing`);
        expect(fx.task()).toMatchObject({ status: "working", findings: `- round ${round}: the test is missing`, reviewRounds: round });
        const typed = fx.calls.filter((call) => call.path === "pane/input").at(-1)!;
        expect(typed.body).toEqual({ pane_id: "p1", text: `A reviewer found problems in your changes. Fix them and commit: - round ${round}: the test is missing` });
        expect(fx.calls.at(-1)).toEqual({ path: "pane/keys", method: "POST", body: { pane_id: "p1", keys: ["Enter"] } });
        await ready(fx);
        expect(fx.task()).toMatchObject({ status: "reviewing", reviewPaneId: `r${round + 1}`, reviewRounds: round + 1 });
      }
      await verdict(fx, "r3", "REVIEW: FINDINGS still no test");
      expect(fx.task()).toMatchObject({ status: "needs_you", reason: "The review still found problems after 3 rounds", findings: "still no test", reviewRounds: 3 });
      expect(fx.calls.filter((call) => call.path === "pane/input")).toHaveLength(2);
      // herdr's agent state leaves it with the user
      fx.frame({ type: "pane-status", pane_id: "p1", agent_status: "working" });
      fx.frame({ type: "pane-status", pane_id: "p1", agent_status: "idle" });
      await fx.assistant.tasks.settled();
      expect(fx.task().status).toBe("needs_you");
      // the user may approve it anyway
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done" });
    } finally { fx.done(); }
  });

  it("asks a reviewer that rests without a verdict once more, then hands the task to the user", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { review: true });
      reviewers(fx);
      await ready(fx);
      fx.frame({ type: "pane-status", pane_id: "r1", agent_status: "working" });
      await verdict(fx, "r1", "The diff looks fine to me.");
      expect(fx.task()).toMatchObject({ status: "reviewing", reviewPaneId: "r1", reviewNudged: true });
      expect(fx.calls.slice(-2)).toEqual([
        { path: "pane/input", method: "POST", body: { pane_id: "r1", text: VERDICT_NUDGE } },
        { path: "pane/keys", method: "POST", body: { pane_id: "r1", keys: ["Enter"] } },
      ]);
      // a rest before it took the nudge is not its answer
      await verdict(fx, "r1", "The diff looks fine to me.");
      expect(fx.task().status).toBe("reviewing");
      fx.frame({ type: "pane-status", pane_id: "r1", agent_status: "working" });
      await verdict(fx, "r1", "Still thinking.");
      expect(fx.task()).toMatchObject({ status: "needs_you", reason: "Reviewer gave no verdict" });
      expect(fx.task().reviewPaneId).toBeUndefined();
      expect(fx.calls).toContainEqual({ path: "pane/close", method: "POST", body: { pane_id: "r1" } });
      expect(fx.calls.filter((call) => call.path === "pane/input")).toHaveLength(1);
      // Approve goes on as for any reason the server set
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done" });
    } finally { fx.done(); }
  });

  it("reads the verdict from the reviewer's last reply line", () => {
    expect(parseVerdict("REVIEW: PASS")).toEqual({ pass: true });
    expect(parseVerdict("> REVIEW: FINDINGS\n1. a\n2. b")).toEqual({ pass: false, findings: "1. a\n2. b" });
    expect(parseVerdict("I will end with REVIEW: PASS")).toBeNull();
    expect(parseVerdict("REVIEW: FINDINGS x\nREVIEW: PASS")).toEqual({ pass: true });
  });
});

describe("merge, pr project", () => {
  it("opens the PR at Ready with shell-quoted commands, and only Approve merges it; Done removes the worktree and branch", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { title: "Fix O'Brien's login" });
      await ready(fx);
      expect(fx.task()).toMatchObject({ status: "ready", prUrl: "https://github.com/me/app/pull/7" });
      const pr = fx.scripts.find((script) => script.includes("gh pr create"))!;
      expect(pr).toContain(`gh pr create --head ${shellQuote("assistant/1-fix-o-brien-s-login")} --base ${shellQuote("main")} --title ${shellQuote("Fix O'Brien's login")} --body ${shellQuote("The login form rejects valid emails.\n\nNot reviewed.\n\nOpened by the Ovis Assistant (task #1).")}`);
      expect(pr).toContain(`git push -u origin ${shellQuote("assistant/1-fix-o-brien-s-login")}`);
      fx.calls.length = 0;
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done", worktree: null, paneId: null });
      expect(fx.scripts.find((script) => script.includes("gh pr merge"))).toContain(`gh pr merge ${shellQuote("7")} --repo ${shellQuote("me/app")} --squash --delete-branch`);
      // herdr's own removal, so its workspace goes too; then the branch herdr keeps
      expect(fx.calls).toContainEqual({ path: "worktree/remove", method: "POST", body: { workspace_id: "w2" } });
      expect(fx.scripts.at(-1)).toContain(`git branch -D ${shellQuote("assistant/1-fix-o-brien-s-login")}`);
      expect(fx.scripts.at(-1)).not.toContain("git worktree remove");
      expect(await refusal(fx.assistant.tasks.approve("1"))).toBe("not_ready");
    } finally { fx.done(); }
  });

  it("makes a failed merge a Needs you card with gh's words, and Approve tries again", async () => {
    let refuse = true;
    const fx = fixture({ run: async (_machine, script) => {
      if (script.includes("symbolic-ref --short HEAD")) return "main\n";
      if (script.includes("gh pr create")) return "ok\nhttps://github.com/me/app/pull/7\n";
      if (script.includes("gh pr merge")) return refuse ? "failed\nPull request is not mergeable: checks failing\n" : "ok\n";
      return script.includes("worktree prune") ? "ok\n" : "herdr\nclaude\n";
    } });
    try {
      await create(fx.assistant);
      await ready(fx);
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "needs_you", reason: "The PR could not be merged: Pull request is not mergeable: checks failing" });
      refuse = false;
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done" });
      expect(fx.task().reason).toBeUndefined();
    } finally { fx.done(); }
  });

  it("refuses Approve before Ready", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant);
      expect(await refusal(fx.assistant.tasks.approve("1"))).toBe("not_ready");
    } finally { fx.done(); }
  });
});

describe("autoMerge", () => {
  it("merges at Ready without review, and unblocks a task --after it", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { autoMerge: true });
      await create(fx.assistant, { title: "Then this", after: "1" });
      expect(fx.task("2").status).toBe("queued");
      await ready(fx);
      expect(fx.task()).toMatchObject({ status: "done", worktree: null });
      await fx.assistant.tasks.runQueue();
      expect(fx.task("2").status).toBe("working");
    } finally { fx.done(); }
  });

  it("with review on, merges only once the review passed", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { autoMerge: true, review: true });
      reviewers(fx);
      await ready(fx);
      expect(fx.task().status).toBe("reviewing");
      expect(fx.scripts.some((script) => script.includes("gh pr"))).toBe(false);
      await verdict(fx, "r1", "REVIEW: PASS");
      expect(fx.task()).toMatchObject({ status: "done", reviewed: true });
      expect(fx.scripts.some((script) => script.includes("gh pr merge"))).toBe(true);
    } finally { fx.done(); }
  });

  it("without autoMerge, waits at Ready", async () => {
    const fx = fixture({ project: { mergeMode: "local" } });
    try {
      await create(fx.assistant);
      await ready(fx);
      expect(fx.task()).toMatchObject({ status: "ready", base: "main" });
      expect(fx.scripts.some((script) => script.includes("merge"))).toBe(false);
    } finally { fx.done(); }
  });
});

describe("cleanup", () => {
  it("keeps a Ready task Ready when its pane is gone", async () => {
    const fx = fixture({ project: { mergeMode: "local" } });
    try {
      await create(fx.assistant);
      await ready(fx);
      fx.frame({ type: "pane-exited", pane_id: "p1" });
      fx.assistant.tasks.checkPanes(fx.machine, -1);
      expect(fx.task().status).toBe("ready");
    } finally { fx.done(); }
  });

  it("refuses to remove a worktree while an agent works in it, and Dismiss removes it once it stopped", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant);
      fx.frame({ type: "pane-exited", pane_id: "p1" });
      expect(fx.task().status).toBe("failed");
      fx.machine.snapshot = snapshot([{ pane_id: "p7", agent_status: "working", workspace_id: "w2" } as never]);
      expect(await refusal(fx.assistant.tasks.dismiss("1"))).toBe("agent_working");
      expect(fx.calls.some((call) => call.path === "worktree/remove")).toBe(false);
      expect(fx.assistant.tasks.list()).toHaveLength(1);
      fx.machine.snapshot = snapshot([{ pane_id: "p7", agent_status: "idle", workspace_id: "w2" } as never]);
      expect(await fx.assistant.tasks.dismiss("1")).toMatchObject({ dismissed: true, worktree: null });
      expect(fx.calls).toContainEqual({ path: "worktree/remove", method: "POST", body: { workspace_id: "w2" } });
      expect(fx.assistant.tasks.list()).toEqual([]);
    } finally { fx.done(); }
  });

  it("dismisses a cancelled task, and refuses one still running", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant);
      expect(await refusal(fx.assistant.tasks.dismiss("1"))).toBe("not_finished");
      await fx.assistant.tasks.cancel("1");
      await fx.assistant.tasks.dismiss("1");
      expect(fx.scripts.at(-1)).toContain("git branch -D");
      expect(fx.assistant.tasks.list()).toEqual([]);
    } finally { fx.done(); }
  });
});

describe("merge, local project (real temporary repositories)", () => {
  // the user's own git config (signing, hooks) stays out of it
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env }).stdout.toString().trim();
  function local() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-merge-")));
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    // a machine that is this test's shell, in these folders only
    const run: RunScript = async (_machine, script) => {
      if (script.includes("status server")) return "herdr\nclaude\n";
      const child = Bun.spawnSync(["sh", "-c", script], { stdout: "pipe", stderr: "pipe", env });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      return child.stdout.toString();
    };
    const fx = fixture({ project: { mergeMode: "local", path: repo }, run });
    fx.answers["worktree/create"] = () => { git(repo, "worktree", "add", "-q", "-b", "assistant/1-fix-login", worktree); return { workspace_id: "w2", pane_id: "p1", path: worktree, agent_started: true }; };
    // herdr no longer has the workspace: git's own removal runs
    fx.answers["worktree/remove"] = () => { throw new AssistantError("not_found", "no such workspace", 404); };
    const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", `edit ${file}`); };
    return { ...fx, repo, worktree, commit, done: () => { fx.done(); rmSync(root, { recursive: true, force: true }); } };
  }

  it("merges the branch into the checkout's branch with --no-ff, then removes the worktree and branch", async () => {
    const fx = local();
    try {
      await create(fx.assistant);
      fx.commit(fx.worktree, "b.txt", "new\n");
      await ready(fx);
      expect(fx.task()).toMatchObject({ status: "ready", base: "main" });
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done", worktree: null });
      expect(fx.task().note).toBeUndefined();
      expect(readFileSync(join(fx.repo, "b.txt"), "utf8")).toBe("new\n");
      expect(git(fx.repo, "log", "-1", "--format=%s|%p")).toMatch(/^Merge task #1: Fix login\|\w+ \w+$/);
      expect(existsSync(fx.worktree)).toBe(false);
      expect(git(fx.repo, "branch", "--list", "assistant/*")).toBe("");
    } finally { fx.done(); }
  });

  it("aborts a conflict, never forces it, and names the conflicting files", async () => {
    const fx = local();
    try {
      await create(fx.assistant);
      fx.commit(fx.worktree, "a.txt", "theirs\n");
      fx.commit(fx.repo, "a.txt", "ours\n");
      const head = git(fx.repo, "rev-parse", "HEAD");
      await ready(fx);
      const task = await fx.assistant.tasks.approve("1");
      expect(task.status).toBe("needs_you");
      expect(task.reason).toContain("conflicts in: a.txt");
      expect(git(fx.repo, "rev-parse", "HEAD")).toBe(head);
      expect(git(fx.repo, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(fx.repo, "a.txt"), "utf8")).toBe("ours\n");
      expect(existsSync(fx.worktree)).toBe(true);
    } finally { fx.done(); }
  });

  it("refuses a checkout with uncommitted changes", async () => {
    const fx = local();
    try {
      await create(fx.assistant);
      fx.commit(fx.worktree, "b.txt", "new\n");
      writeFileSync(join(fx.repo, "a.txt"), "unsaved\n");
      const head = git(fx.repo, "rev-parse", "HEAD");
      await ready(fx);
      expect((await fx.assistant.tasks.approve("1")).reason).toContain("has uncommitted changes");
      expect(git(fx.repo, "rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(fx.repo, "a.txt"), "utf8")).toBe("unsaved\n");
    } finally { fx.done(); }
  });

  it("marks a branch with nothing ahead Done with nothing merged", async () => {
    const fx = local();
    try {
      await create(fx.assistant);
      const head = git(fx.repo, "rev-parse", "HEAD");
      await ready(fx);
      expect(await fx.assistant.tasks.approve("1")).toMatchObject({ status: "done", note: "Nothing merged: assistant/1-fix-login has no commits ahead of main" });
      expect(git(fx.repo, "rev-parse", "HEAD")).toBe(head);
      expect(existsSync(fx.worktree)).toBe(false);
    } finally { fx.done(); }
  });

  it("builds a merge that is never forced", () => {
    const script = localMergeScript("/r", "main", { id: "1", branch: "assistant/1-x", title: "X" });
    expect(script).toContain("git merge --no-ff --no-edit");
    expect(script).toContain("git merge --abort");
    expect(script).not.toMatch(/--force|-X|-s ours|reset --hard/);
    expect(cleanupScript("/r", "/wt", "assistant/1-x")).not.toMatch(/--force|-f\b/);
  });
});

describe("a brief of several lines", () => {
  const brief = "Fix the login form.\nIt rejects valid emails.\n\nAdd a test.";
  it("starts the agent without it, then pastes it with its line breaks framed once the agent is up, and Enter", async () => {
    const fx = fixture();
    try {
      expect(await create(fx.assistant, { brief })).toMatchObject({ status: "working", briefPending: true });
      expect(fx.calls.at(-1)!.body).toMatchObject({ agent: { kind: "claude" } });
      expect((fx.calls.at(-1)!.body as { agent: { args?: string[] } }).agent.args).toBeUndefined();
      // at rest before the snapshot shows the agent: not up yet, nothing typed
      fx.frame({ type: "pane-status", pane_id: "p1", agent_status: "idle" });
      await fx.assistant.tasks.settled();
      expect(fx.calls.some((call) => call.path === "pane/input")).toBe(false);
      fx.machine.snapshot = snapshot([{ pane_id: "p1", agent_status: "idle" }]);
      fx.frame({ type: "pane-status", pane_id: "p1", agent_status: "idle" });
      await fx.assistant.tasks.settled();
      expect(fx.calls.slice(-2)).toEqual([
        { path: "pane/input", method: "POST", body: { pane_id: "p1", text: "\u001b[200~Fix the login form.\rIt rejects valid emails.\r\rAdd a test.\u001b[201~" } },
        { path: "pane/keys", method: "POST", body: { pane_id: "p1", keys: ["Enter"] } },
      ]);
      expect(fx.task().briefPending).toBeUndefined();
      // sent once; its rest before it took the brief is not Ready, its work after it is
      fx.frame({ type: "pane-status", pane_id: "p1", agent_status: "idle" });
      await fx.assistant.tasks.settled();
      expect(fx.task().status).toBe("working");
      expect(fx.calls.filter((call) => call.path === "pane/input")).toHaveLength(1);
      await ready(fx);
      expect(fx.task().status).toBe("ready");
    } finally { fx.done(); }
  });

  it("is sent by the watcher's check when a frame was missed", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant, { brief });
      fx.machine.snapshot = snapshot([{ pane_id: "p1", agent_status: "done" }]);
      await fx.assistant.check("m1");
      await fx.assistant.tasks.settled();
      expect(fx.calls.find((call) => call.path === "pane/input")!.body).toMatchObject({ pane_id: "p1" });
      expect(fx.task()).toMatchObject({ status: "working" });
    } finally { fx.done(); }
  });
});

describe("a task's alerts", () => {
  it("names the live task a pane runs, not its reviewer's or an ended one's", async () => {
    const fx = fixture();
    try {
      await create(fx.assistant);
      expect(fx.assistant.tasks.paneTask("m1", "p1")).toMatchObject({ id: "1", title: "Fix login" });
      expect(fx.assistant.tasks.paneTask("m2", "p1")).toBeUndefined();
      await fx.assistant.tasks.cancel("1");
      expect(fx.assistant.tasks.paneTask("m1", "p1")).toBeUndefined();
    } finally { fx.done(); }
  });
});

describe("the herdr sessions the Assistant coordinates", () => {
  const sessions = (fx: ReturnType<typeof fixture>) => {
    fx.machine.snapshot = snapshot([
      { pane_id: "a1", agent_status: "idle", agent: "claude", workspace_id: "w1", cwd: "/home/me/web", terminal_title_stripped: "Fix nav" },
      { pane_id: "a2", agent_status: "working", agent: "codex", workspace_id: "w1", cwd: "/home/me/web" },
      { pane_id: "s1", agent_status: "unknown", agent: null, workspace_id: "w3", cwd: "/home/me" },
    ] as never, [{ workspace_id: "w1", label: "web" }, { workspace_id: "w3", label: "shell" }]);
    fx.machinesChanged();
  };

  it("lists every workspace and pane on the machines, by machine name", () => {
    const fx = fixture();
    try {
      sessions(fx);
      expect(fx.assistant.herdrSessions()).toEqual([{ machine: "Laptop", state: "connected", workspaces: [
        { workspace: "web", panes: [
          { pane: "a1", agent: "claude", status: "idle", title: "Fix nav", folder: "/home/me/web" },
          { pane: "a2", agent: "codex", status: "working", title: null, folder: "/home/me/web" },
        ] },
        { workspace: "shell", panes: [{ pane: "s1", agent: null, status: "unknown", title: null, folder: "/home/me" }] },
      ] }]);
      expect(fx.assistant.herdrSessions("Laptop")).toHaveLength(1);
      expect(() => fx.assistant.herdrSessions("Desktop")).toThrow(AssistantError);
    } finally { fx.done(); }
  });

  it("reads an agent's last turns, and a shell's screen", async () => {
    const fx = fixture();
    try {
      sessions(fx);
      fx.answers["pane/conversation"] = () => ({ source: "claude-transcript", turns: [
        { role: "user", ts: null, parts: [{ kind: "text", text: "fix the nav" }] },
        { role: "assistant", ts: null, parts: [{ kind: "text", text: "Done: the nav wraps now." }] },
      ] });
      expect(await fx.assistant.peekSession({ machine: "Laptop", pane: "a1" })).toEqual({ machine: "Laptop", pane: "a1", agent: "claude", status: "idle",
        turns: [{ role: "user", text: "fix the nav" }, { role: "assistant", text: "Done: the nav wraps now." }] });
      expect(await fx.assistant.peekSession({ machine: "Laptop", pane: "s1" })).toMatchObject({ screen: "line one\nline two" });
      expect(await refusal(fx.assistant.peekSession({ machine: "Laptop", pane: "zz" }))).toBe("unknown_pane");
      // reading writes nothing
      expect(fx.calls.some((call) => call.method === "POST")).toBe(false);
    } finally { fx.done(); }
  });

  it("sends a message to an agent at rest, as a paste and Enter, and refuses a working agent, a shell and a task's pane", async () => {
    const fx = fixture();
    try {
      sessions(fx);
      expect(await fx.assistant.sendToSession({ machine: "Laptop", pane: "a1", message: "Also fix the footer.\nThanks" })).toEqual({ ok: true, machine: "Laptop", pane: "a1" });
      expect(fx.calls.map((call) => [call.path, call.body])).toEqual([
        ["pane/input", { pane_id: "a1", text: "\u001b[200~Also fix the footer.\rThanks\u001b[201~" }],
        ["pane/keys", { pane_id: "a1", keys: ["Enter"] }],
      ]);
      expect(await refusal(fx.assistant.sendToSession({ machine: "Laptop", pane: "a2", message: "hi" }))).toBe("pane_busy");
      expect(await refusal(fx.assistant.sendToSession({ machine: "Laptop", pane: "s1", message: "ls" }))).toBe("no_agent");
      expect(await refusal(fx.assistant.sendToSession({ machine: "Laptop", pane: "a1", message: " " }))).toBe("invalid_message");
      const task = await create(fx.assistant);
      fx.machine.snapshot!.panes.push({ ...fx.machine.snapshot!.panes[0]!, pane_id: task.paneId!, agent_status: "idle" });
      expect(await refusal(fx.assistant.sendToSession({ machine: "Laptop", pane: task.paneId, message: "hi" }))).toBe("task_pane");
    } finally { fx.done(); }
  });

  it("makes ovis-task's command lines for them", () => {
    expect(cliRequest(["sessions"])).toEqual({ path: "sessions" });
    expect(cliRequest(["sessions", "macbook pro"])).toEqual({ path: "sessions?machine=macbook%20pro" });
    expect(cliRequest(["peek", "Laptop", "a1"])).toEqual({ path: "peek", body: { machine: "Laptop", pane: "a1" } });
    expect(cliRequest(["send", "Laptop", "a1", "fix", "the", "footer"])).toEqual({ path: "send", body: { machine: "Laptop", pane: "a1", message: "fix the footer" } });
    expect("usage" in cliRequest(["send", "Laptop", "a1"])).toBe(true);
  });
});
