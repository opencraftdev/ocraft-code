/**
 * The Assistant's tasks (docs/plan/20261111-2112-assistant.md, phase 4). A task is a coding agent in
 * a git worktree of a project, on the project's machine, started full auto (decision 17) with the
 * brief as its first prompt. It runs through that machine's Remote PCs bridge (the routes
 * /api/machines/:id/... proxies), called from inside this server: never herdr's focus, never
 * --takeover. Its status comes only from herdr's agent state of its pane, as the bridge's observer
 * hears it (MachineManager.observe): a task agent has no `ovis-task` and no way back here.
 *
 * Kept in stateDir/assistant/tasks.json, written atomically at 0600. The queue and the clock (phase 5)
 * live here too: a task is made Queued (or Scheduled), and `runQueue` starts it once its machine is
 * connected with a free slot, its `after` task is Done and its `at` time has passed, oldest first per
 * machine. A cron template's next fire time is kept on it in the same file, written in the same write
 * as the task it fires, so a restart neither fires a slot twice nor loses the last one it missed.
 * Review and merge (phase 6) only have their fields stored yet.
 */
import { ASSISTANT_AGENTS, TASK_STATUSES, type AssistantAgent, type AssistantProject, type AssistantTask, type TaskStatus } from "../shared/assistant.ts";
import { argumentText, firstMessageFault, MAX_FIRST_MESSAGE_CHARS } from "../shared/launch-rules.ts";
import type { Machine } from "../shared/machines.ts";
import { alertStatus } from "../shared/notify-policy.ts";
import type { AgentStatus, InteractivePrompt, PromptAnswer, ServerMessage } from "../shared/protocol.ts";
import { AssistantError, readDocument } from "./assistant.ts";
import { isJsonObject } from "./http.ts";
import { slowMachinePath } from "./machine-api.ts";
import { nextFire, parseCron } from "./cron.ts";
import { writePrivateState } from "./private-state.ts";

/** One call to a machine's bridge: its JSON answer, or a thrown AssistantError. Tests pass their own. */
export type TaskBridge = (machineId: string, path: string, request?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> }) => Promise<unknown>;

/** The bridge as the PC proxy reaches it (server/machine-api.ts), with the PC's own token, from this server. */
export function machineBridge(manager: { endpoint(id: string): { url: string; token: string } | undefined; retryNow(id: string): void }): TaskBridge {
  return async (machineId, path, { method = "GET", body, query } = {}) => {
    const endpoint = manager.endpoint(machineId);
    if (!endpoint) {
      manager.retryNow(machineId);
      throw new AssistantError("machine_offline", "The task's machine is not connected", 503);
    }
    const url = new URL(`${endpoint.url}/api/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method, redirect: "error",
      headers: { authorization: `Bearer ${endpoint.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(slowMachinePath(path) ? 165_000 : 75_000),
    });
    const answer = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new AssistantError(answer?.error?.code ?? "machine_error", answer?.error?.message ?? `The machine answered HTTP ${response.status}`, response.status === 404 ? 404 : 502);
    return answer;
  };
}

/** what `ovis-task show` hands back of the pane at most: its end */
export const SHOW_CAP = 16 * 1024;
/** statuses herdr's agent state moves a task between */
const LIVE: readonly TaskStatus[] = ["working", "needs_you", "ready"];
/** a pane gone or an agent stopped in these is a failed task; a Ready one already did its work */
const RUNNING: readonly TaskStatus[] = ["working", "needs_you"];
const FINISHED: readonly TaskStatus[] = ["done", "cancelled"];

/** What herdr's agent state makes of a live task: working is Working, blocked Needs you, at rest after work Ready. */
export function statusAfter(task: Pick<AssistantTask, "status" | "worked">, agent: AgentStatus): Pick<AssistantTask, "status" | "worked"> | null {
  if (!LIVE.includes(task.status)) return null;
  const worked = task.worked || agent === "working" || agent === "blocked" ? true as const : undefined;
  const status: TaskStatus = agent === "working" ? "working" : agent === "blocked" ? "needs_you" : (agent === "done" || agent === "idle") && worked ? "ready" : task.status;
  return status === task.status && worked === task.worked ? null : { status, ...(worked ? { worked } : {}) };
}

/**
 * The brief as one command-line argument (the agent's first prompt, after `--`). An argument holds no
 * line break, so lines are joined with spaces.
 * ponytail: a multi-line brief loses its line breaks; send it through the bridge's pending path once it takes an unattended first message.
 */
export const launchPrompt = (text: string): string => text.replace(/\s*[\r\n\t]+\s*/g, " ").trim();

/** the title as a branch name's tail: lowercase ASCII words joined by hyphens */
export function taskSlug(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

const validTask = (item: unknown): item is AssistantTask => isJsonObject(item) && typeof item.id === "string" && typeof item.title === "string"
  && typeof item.project === "string" && typeof item.machine === "string" && (TASK_STATUSES as readonly unknown[]).includes(item.status)
  && (item.paneId === null || typeof item.paneId === "string") && typeof item.branch === "string" && typeof item.createdAt === "number";
const agentOf = (value: unknown): value is AssistantAgent => (ASSISTANT_AGENTS as readonly unknown[]).includes(value);
const line = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max && argumentText(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * `--at`: an ISO date and time (without a zone it is the VM's local time), or `HH:MM`, the next time
 * the VM's clock shows it (today, or tomorrow when that has passed). ms since the epoch, or null.
 */
export function parseAt(text: string, now: number): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!clock) {
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : at;
  }
  const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export interface TaskDeps {
  project(id: string): AssistantProject | undefined;
  /** herdr's saved machine with that id, as Remote PCs holds it (its state and snapshot) */
  machine(id: string): Machine | undefined;
  /** the machine's Max running tasks */
  maxRunning(id: string): number;
  bridge: TaskBridge;
  now(): number;
}

export class AssistantTasks {
  private tasks: AssistantTask[];

  constructor(private path: string, private deps: TaskDeps) {
    this.tasks = readDocument(path, (value): value is AssistantTask[] => Array.isArray(value) && value.every(validTask), []);
  }


  list(status?: string): AssistantTask[] {
    if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) throw new AssistantError("invalid_status", `A status is one of ${TASK_STATUSES.join(", ")}`);
    return this.tasks.filter((task) => status === undefined || task.status === status).sort((a, b) => b.createdAt - a.createdAt || Number(b.id) - Number(a.id));
  }

  get(id: unknown): AssistantTask {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new AssistantError("unknown_task", "No task has that id; `ovis-task list` lists them", 404);
    return task;
  }

  private write(tasks: AssistantTask[]): void {
    writePrivateState(this.path, tasks);
    this.tasks = tasks;
  }

  /** a status change runs the queue: a slot freed, or an `after` task ended */
  private update(id: string, change: Partial<AssistantTask>, drop: (keyof AssistantTask)[] = []): AssistantTask {
    let next: AssistantTask | undefined;
    let moved = false;
    this.write(this.tasks.map((task) => {
      if (task.id !== id) return task;
      next = { ...task, ...change };
      moved = next.status !== task.status;
      for (const key of drop) delete next[key];
      return next;
    }));
    if (moved) void this.runQueue();
    return next!;
  }

  private newId(): string {
    return String(this.tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1);
  }

  /**
   * `ovis-task create`: checked, then Queued, or Scheduled when it has a future `at` or a `cron`, and
   * the queue runs. `after` names a task that already exists, so no chain of them can loop.
   */
  async create(body: unknown): Promise<AssistantTask> {
    if (!isJsonObject(body)) throw new AssistantError("invalid_body", "Expected a task");
    const project = typeof body.project === "string" ? this.deps.project(body.project) : undefined;
    if (!project) throw new AssistantError("unknown_project", "No project has that name; `ovis-task projects` lists them", 404);
    if (!line(body.title, 200)) throw new AssistantError("invalid_title", "A title is one line of at most 200 characters");
    const fault = firstMessageFault(body.brief, true);
    if (typeof body.brief !== "string" || fault !== null || !argumentText(launchPrompt(body.brief))) throw new AssistantError("invalid_brief", `A brief is text of at most ${MAX_FIRST_MESSAGE_CHARS} characters, without terminal control characters`);
    if (body.agent !== undefined && !agentOf(body.agent)) throw new AssistantError("invalid_agent", "--agent is claude or codex");
    for (const flag of ["review", "autoMerge"] as const) if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new AssistantError("invalid_flag", `${flag} is true or false`);
    const now = this.deps.now();
    if (body.after !== undefined && this.get(body.after).cron !== undefined) throw new AssistantError("invalid_after", "--after names a task, not a cron template");
    const at = body.at === undefined ? undefined : line(body.at, 100) ? parseAt(body.at, now) : null;
    if (at === null) throw new AssistantError("invalid_at", "--at is HH:MM (the next time the clock shows it) or a date and time, such as 2026-11-12T09:00");
    let next: number | undefined;
    if (body.cron !== undefined) {
      const cron = line(body.cron, 200) ? parseCron(body.cron) : null;
      const first = cron ? nextFire(cron, now) : null;
      if (first === null) throw new AssistantError("invalid_cron", "--cron is five fields: minute hour day month weekday, such as \"0 9 * * 1-5\"");
      if (body.after !== undefined || at !== undefined) throw new AssistantError("invalid_cron", "--cron takes neither --after nor --at");
      next = first;
    }
    const machine = this.deps.machine(project.machine);
    if (!machine) throw new AssistantError("unknown_machine", "That project's machine is not one of herdr's saved machines", 404);
    const id = this.newId();
    const task: AssistantTask = {
      id, title: body.title.trim(), brief: body.brief, project: project.id, machine: machine.id, agent: (body.agent as AssistantAgent | undefined) ?? project.defaultAgent,
      status: next !== undefined || (at !== undefined && at > now) ? "scheduled" : "queued", paneId: null, worktree: null, workspaceId: null, branch: `assistant/${id}-${taskSlug(body.title)}`,
      ...(body.after === undefined ? {} : { after: body.after as string }), ...(at === undefined ? {} : { at: new Date(at).toISOString() }),
      ...(next === undefined ? {} : { cron: (body.cron as string).trim().split(/\s+/).join(" "), next }),
      review: body.review === true, autoMerge: body.autoMerge === true, createdAt: now,
    };
    this.write([...this.tasks, task]);
    await this.runQueue();
    return this.get(id);
  }

  private queue: Promise<void> | null = null;
  private again = false;
  /** the task the queue is starting: cancel waits until it has a pane to close */
  private starting: string | null = null;

  /**
   * Runs the queue: on a status change, a machine's change, the user's Max running, the
   * watcher's 30 s check of each machine (server/assistant.ts) and the server's start. One run at a time; asked during one, it runs once more after it.
   */
  runQueue(): Promise<void> {
    if (this.queue) { this.again = true; return this.queue; }
    this.queue = (async () => { do { this.again = false; await this.step(); } while (this.again); })()
      .finally(() => { this.queue = null; });
    return this.queue;
  }

  private async step(): Promise<void> {
    const now = this.deps.now();
    // the clock: a template due fires once, however many of its slots passed (a restart, a sleep)
    for (const template of this.tasks.filter((task) => task.status === "scheduled" && task.next !== undefined && task.next <= now)) {
      const cron = parseCron(template.cron ?? "");
      const next = cron ? nextFire(cron, now) : null;
      const id = this.newId();
      const copy: AssistantTask = {
        id, title: template.title, brief: template.brief, project: template.project, machine: template.machine, agent: template.agent,
        status: "queued", paneId: null, worktree: null, workspaceId: null, branch: `assistant/${id}-${taskSlug(template.title)}`,
        review: template.review, autoMerge: template.autoMerge, fromCron: template.id, createdAt: now,
      };
      // the copy and the template's next fire time in one write: a restart sees both or neither
      this.write([...this.tasks.map((task) => {
        if (task.id !== template.id) return task;
        const { next: _fired, ...rest } = task;
        return next === null ? rest : { ...rest, next };
      }), copy]);
    }
    for (const task of this.tasks) {
      if (task.status === "scheduled" && task.cron === undefined && (task.at === undefined || Date.parse(task.at) <= now)) this.update(task.id, { status: "queued" });
    }
    for (const task of this.tasks) {
      if (task.status !== "queued" || task.after === undefined) continue;
      const after = this.tasks.find((candidate) => candidate.id === task.after);
      if (!after || after.status === "failed" || after.status === "cancelled") {
        this.update(task.id, { status: "failed", error: `Task #${task.after}, which it waited for, ${!after ? "is gone" : after.status === "failed" ? "failed" : "was cancelled"}` });
      }
    }
    const waiting = this.tasks.filter((task) => task.status === "queued" && (task.after === undefined || this.tasks.some((after) => after.id === task.after && after.status === "done")))
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));
    for (const { id } of waiting) {
      const task = this.get(id);
      if (task.status !== "queued") continue;
      const project = this.deps.project(task.project);
      if (!project) { this.update(id, { status: "failed", error: "Its project was removed" }); continue; }
      // a machine that is down keeps its tasks Queued; it coming back runs the queue again
      const machine = this.deps.machine(task.machine);
      if (machine?.state !== "connected") continue;
      if (this.tasks.filter((other) => other.machine === task.machine && RUNNING.includes(other.status)).length >= this.deps.maxRunning(task.machine)) continue;
      this.starting = id;
      // a start that failed marked the task Failed
      await this.start(task, project, machine).catch(() => undefined).finally(() => { this.starting = null; });
    }
  }

  private async start(task: AssistantTask, project: AssistantProject, machine: Machine): Promise<AssistantTask> {
    try {
      // the workspace on the project's main checkout, which herdr makes worktrees from; one is opened there when none is
      const open = machine.snapshot?.workspaces.find((workspace) => workspace.worktree && !workspace.worktree.is_linked_worktree && workspace.worktree.checkout_path === project.path);
      const source = open?.workspace_id ?? (await this.deps.bridge(machine.id, "workspace/create", { method: "POST", body: { cwd: project.path, label: project.id } }) as { workspace_id: string }).workspace_id;
      // focus: false (workspace-routes.ts); the bridge adds the full-auto flag (agent-launch.ts SKIP_PERMISSIONS)
      const opened = await this.deps.bridge(machine.id, "worktree/create", { method: "POST", body: {
        workspace_id: source, branch: task.branch, label: task.title, agent: { kind: task.agent, args: ["--", launchPrompt(task.brief)] },
      } }) as { workspace_id: string; pane_id: string; path: string; agent_started?: boolean; error?: { message?: string } };
      const started = { paneId: opened.pane_id, workspaceId: opened.workspace_id, worktree: opened.path, startedAt: this.deps.now() };
      if (opened.agent_started === false) {
        this.update(task.id, { ...started, status: "failed", error: opened.error?.message ?? "The agent did not start" });
        throw new AssistantError("agent_not_started", `The worktree is there, but the agent did not start: ${opened.error?.message ?? "no reason given"}`, 502);
      }
      return this.update(task.id, { ...started, status: "working" });
    } catch (error) {
      if (!(error instanceof AssistantError && error.code === "agent_not_started")) this.update(task.id, { status: "failed", error: message(error) });
      throw error;
    }
  }

  /** a frame of a machine's observer (MachineManager.observe): a task pane's agent state, or its end */
  heard(machineId: string, frame: ServerMessage): void {
    if (frame.type !== "pane-status" && frame.type !== "pane-exited") return;
    const task = this.tasks.find((candidate) => candidate.machine === machineId && candidate.paneId === frame.pane_id && LIVE.includes(candidate.status));
    if (!task) return;
    if (frame.type === "pane-exited") {
      if (RUNNING.includes(task.status)) this.update(task.id, { status: "failed", error: "The agent's pane closed" });
      return;
    }
    const next = statusAfter(task, alertStatus(frame.agent_status, frame.background_wait));
    if (next) this.update(task.id, next);
  }

  /**
   * The watcher's check of a machine's task panes (server/assistant.ts), against Remote PCs' snapshot
   * of it: a status a lost frame missed is caught up, and a running task whose pane is gone, or whose
   * agent stopped, fails. One started less than `graceMs` ago may not be in the snapshot yet.
   */
  checkPanes(machine: Machine, graceMs: number): void {
    if (machine.state !== "connected" || !machine.snapshot) return;
    const settled = this.deps.now() - graceMs;
    for (const task of this.tasks) {
      if (task.machine !== machine.id || task.paneId === null || !LIVE.includes(task.status)) continue;
      const pane = machine.snapshot.panes.find((candidate) => candidate.pane_id === task.paneId);
      const old = (task.startedAt ?? task.createdAt) < settled;
      if (!pane) {
        if (old && RUNNING.includes(task.status)) this.update(task.id, { status: "failed", error: "The agent's pane is gone" });
        continue;
      }
      const next = statusAfter(task, alertStatus(pane.agent_status, pane.background_wait));
      const now = next ? this.update(task.id, next) : task;
      if (old && now.worked && !pane.agent && RUNNING.includes(now.status)) this.update(task.id, { status: "failed", error: "The agent stopped" });
    }
  }

  /** `ovis-task show`: the task and the end of what its pane shows */
  async show(id: unknown): Promise<AssistantTask & { output: string | null; note?: string }> {
    const task = this.get(id);
    if (task.paneId === null || FINISHED.includes(task.status)) return { ...task, output: null };
    try {
      const read = await this.deps.bridge(task.machine, "pane/read", { query: { pane_id: task.paneId, source: "recent", format: "text", lines: "200" } }) as { read?: { text?: string } };
      const text = read.read?.text ?? "";
      return { ...task, output: text.length > SHOW_CAP ? text.slice(-SHOW_CAP) : text };
    } catch (error) {
      return { ...task, output: null, note: `The pane could not be read: ${message(error)}` };
    }
  }

  /** `ovis-task answer`: the question on the task's pane, answered through the prompt-answer route, never guessed keys */
  async answer(id: unknown, choice: unknown): Promise<{ answered: string }> {
    const task = this.get(id);
    if (task.status !== "needs_you" || task.paneId === null) throw new AssistantError("not_waiting", "That task is not waiting for an answer", 409);
    if (!line(choice, 2000)) throw new AssistantError("invalid_choice", "Give an option's number or label, or the text to answer with");
    const { prompt } = await this.deps.bridge(task.machine, "pane/prompt", { query: { pane_id: task.paneId } }) as { prompt: InteractivePrompt | null };
    if (!prompt) throw new AssistantError("no_prompt", "The agent shows no question right now; `ovis-task show` reads its pane", 409);
    const options = prompt.options.map((option, at) => `${at + 1}. ${option.label}`).join("; ");
    const wanted = choice.trim();
    const number = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
    const index = number >= 0 && number < prompt.options.length ? number : prompt.options.findIndex((option) => option.label.trim().toLowerCase() === wanted.toLowerCase());
    let answer: PromptAnswer;
    if (index >= 0 && index !== prompt.custom_option_index) answer = { pane_id: task.paneId, prompt_id: prompt.id, option_index: index };
    else if (prompt.custom_option_index !== null && index < 0) answer = { pane_id: task.paneId, prompt_id: prompt.id, custom_text: wanted };
    else throw new AssistantError("invalid_choice", `Choose one of: ${options}`);
    await this.deps.bridge(task.machine, "pane/prompt/answer", { method: "POST", body: answer });
    return { answered: answer.custom_text ?? prompt.options[index]!.label };
  }

  /**
   * `ovis-task cancel` and the card's Cancel: the task's pane is closed; its worktree and branch stay
   * (merge and cleanup are phase 6). A Queued or Scheduled task never starts, and a cron template
   * fires no more.
   */
  async cancel(id: unknown): Promise<AssistantTask> {
    const task = this.get(id);
    if (FINISHED.includes(task.status)) throw new AssistantError("finished", "That task has already ended", 409);
    if (this.starting === task.id) throw new AssistantError("starting", "That task is starting; cancel it again in a moment", 409);
    if (task.paneId !== null && task.status !== "failed") {
      await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: task.paneId } }).catch((error: unknown) => {
        // a pane already gone is closed
        if (!(error instanceof AssistantError && error.status === 404)) throw error;
      });
    }
    return this.update(task.id, { status: "cancelled" });
  }

  /**
   * Restart agent, only on the user's click (decision 16): a failed task's agent starts again in its
   * worktree, in a workspace of its own, with the brief again. What is left of its old pane is closed.
   */
  async restart(id: string): Promise<AssistantTask> {
    const task = this.get(id);
    if (task.status !== "failed" || task.worktree === null || !(task.worktree.startsWith("/") || task.worktree.startsWith("~"))) throw new AssistantError("not_restartable", "Only a failed task whose worktree was made can restart", 409);
    const machine = this.deps.machine(task.machine);
    if (task.paneId !== null && machine?.snapshot?.panes.some((pane) => pane.pane_id === task.paneId)) {
      await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: task.paneId } }).catch(() => undefined);
    }
    const again = launchPrompt(`Continue this task; earlier work may already be in this worktree. ${task.brief}`);
    const opened = await this.deps.bridge(task.machine, "workspace/create", { method: "POST", body: {
      cwd: task.worktree, label: task.title, agent: { kind: task.agent, args: ["--", again.length <= MAX_FIRST_MESSAGE_CHARS ? again : launchPrompt(task.brief)] },
    } }) as { workspace_id: string; pane_id: string; agent_started?: boolean; error?: { message?: string } };
    if (opened.agent_started === false) throw new AssistantError("agent_not_started", `The agent did not start: ${opened.error?.message ?? "no reason given"}`, 502);
    return this.update(task.id, { status: "working", paneId: opened.pane_id, workspaceId: opened.workspace_id, startedAt: this.deps.now() }, ["worked", "error"]);
  }
}
