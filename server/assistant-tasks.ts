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
 *
 * Review and merge (phase 6): at Ready a task with `review` gets a fresh reviewer agent in its
 * worktree, whose verdict line passes it or sends its findings back to the task's agent. A `pr`
 * project's task then pushes its branch and opens a PR; the user's Approve (only in the app, never
 * `ovis-task`) or `autoMerge` merges it: `gh pr merge --squash`, or for a `local` project a
 * `git merge --no-ff` into the checkout's branch, which keeps the task's commits and a merge commit
 * naming it. A conflict is aborted, never forced. Done removes the worktree and the branch.
 */
import { ASSISTANT_AGENTS, TASK_STATUSES, type AssistantAgent, type AssistantProject, type AssistantTask, type TaskStatus } from "../shared/assistant.ts";
import { argumentText, firstMessageFault, MAX_FIRST_MESSAGE_CHARS } from "../shared/launch-rules.ts";
import type { Machine } from "../shared/machines.ts";
import { alertStatus } from "../shared/notify-policy.ts";
import type { AgentStatus, ConversationResponse, InteractivePrompt, PromptAnswer, ServerMessage } from "../shared/protocol.ts";
import { AssistantError, readDocument } from "./assistant.ts";
import { isJsonObject } from "./http.ts";
import { slowMachinePath } from "./machine-api.ts";
import { shellQuote } from "./machine-security.ts";
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
const AT_REST: readonly AgentStatus[] = ["done", "idle"];
/** herdr's agent state moves the task: not one the server moved to Needs you itself (a merge or review that needs the user) */
const agentLed = (task: AssistantTask): boolean => LIVE.includes(task.status) && task.reason === undefined;

/** What herdr's agent state makes of a live task: working is Working, blocked Needs you, at rest after work Ready. */
export function statusAfter(task: Pick<AssistantTask, "status" | "worked">, agent: AgentStatus): Pick<AssistantTask, "status" | "worked"> | null {
  if (!LIVE.includes(task.status)) return null;
  const worked = task.worked || agent === "working" || agent === "blocked" ? true as const : undefined;
  const status: TaskStatus = agent === "working" ? "working" : agent === "blocked" ? "needs_you" : (agent === "done" || agent === "idle") && worked ? "ready" : task.status;
  return status === task.status && worked === task.worked ? null : { status, ...(worked ? { worked } : {}) };
}

/**
 * The brief as one command-line argument (the agent's first prompt, after `--`). An argument holds no
 * line break, so lines are joined with spaces. A brief of several lines goes as a paste instead (pastedBrief).
 */
export const launchPrompt = (text: string): string => text.replace(/\s*[\r\n\t]+\s*/g, " ").trim();

/** a brief whose line breaks would be lost on the command line */
export const multiLine = (text: string): boolean => /[\r\n]/.test(text.trim());

/**
 * The brief as the chat's composer types a multi-line message (src/lib/compose.ts composerPayload): each
 * line break a CR, inside one bracketed-paste pair, so Claude Code and Codex take it as one message and
 * the Enter after it sends it. A brief holds no control character (firstMessageFault), so no paste marker.
 */
export const pastedBrief = (text: string): string => `\u001b[200~${text.trim().replace(/\r\n?/g, "\n").replace(/\n/g, "\r")}\u001b[201~`;

/** the reviewer's last reply ended without a verdict line: it is asked once more */
export const VERDICT_NUDGE = "End your reply with one line: REVIEW: PASS when the work is ready to merge, or REVIEW: FINDINGS followed by the findings, one per line.";

/** the title as a branch name's tail: lowercase ASCII words joined by hyphens */
export function taskSlug(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

/** review rounds before the findings go to the user. ponytail: fixed at the plan's 3; a per-task setting when one is asked for */
export const REVIEW_ROUNDS = 3;
/** a push, `gh pr create`, `gh pr merge` or a merge can take longer than a health check */
const MERGE_TIMEOUT_MS = 120_000;
const q = shellQuote;
/** a failed step's own words as the script's answer; every script exits 0 and says how it went on its first line */
const failed = (variable: string) => `{ echo failed; printf '%s\\n' "$${variable}"; exit 0; }`;

/** the checkout's branch: what a task's branch was made from and merges back into */
export const baseScript = (path: string): string => `cd -- ${q(path)} && git symbolic-ref --short HEAD`;

/** pushes the task's branch and opens its PR, in its worktree; `nothing` when it has no commits ahead of the base */
export function prScript(task: Pick<AssistantTask, "branch" | "title"> & { worktree: string }, base: string, body: string): string {
  return [
    `cd -- ${q(task.worktree)} 2>/dev/null || { echo failed; echo "The task's worktree is gone"; exit 0; }`,
    `n=$(git rev-list --count ${q(`${base}..HEAD`)} 2>&1) || ${failed("n")}`,
    `[ "$n" != 0 ] || { echo nothing; exit 0; }`,
    `out=$(git push -u origin ${q(task.branch)} 2>&1) || ${failed("out")}`,
    // a PR already open for the branch is named in gh's refusal, which is as good
    `out=$(gh pr create --head ${q(task.branch)} --base ${q(base)} --title ${q(task.title)} --body ${q(body)} 2>&1)`,
    `echo ok; printf '%s\\n' "$out"`,
  ].join("\n");
}

/** the PR a task opened, from gh's output */
export const prUrlOf = (output: string): string | null => output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)?.pop() ?? null;

/**
 * Pushes what the task added since (when its worktree is there), then squash-merges its PR. `--repo`
 * keeps gh from switching or deleting a local branch, which another worktree holds: the cleanup does that.
 */
export function prMergeScript(task: Pick<AssistantTask, "worktree" | "branch">, prUrl: string): string {
  const [, repo, number] = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(prUrl) ?? [];
  if (!repo || !number) throw new AssistantError("invalid_pr", "The task's PR address is not a GitHub PR");
  return [
    ...(task.worktree === null ? [] : [`if cd -- ${q(task.worktree)} 2>/dev/null; then out=$(git push origin ${q(task.branch)} 2>&1) || ${failed("out")}; fi`]),
    `out=$(gh pr merge ${q(number)} --repo ${q(repo)} --squash --delete-branch 2>&1) || ${failed("out")}`,
    "echo ok",
  ].join("\n");
}

/**
 * Merges the task's branch into the checkout's base branch with `--no-ff`. Refused (`dirty`) when the
 * checkout has uncommitted changes; `nothing` when the branch has no commits ahead; a conflict is
 * aborted and answered `conflict` with the conflicting files. Never forced.
 */
export function localMergeScript(path: string, base: string, task: Pick<AssistantTask, "id" | "branch" | "title">): string {
  return [
    `cd -- ${q(path)} 2>/dev/null || { echo failed; echo "The project's folder is gone"; exit 0; }`,
    `cur=$(git symbolic-ref --short HEAD 2>&1) || ${failed("cur")}`,
    `[ "$cur" = ${q(base)} ] || { echo failed; printf 'The checkout is on %s, not %s\\n' "$cur" ${q(base)}; exit 0; }`,
    `[ -z "$(git status --porcelain)" ] || { echo dirty; exit 0; }`,
    `n=$(git rev-list --count ${q(`${base}..${task.branch}`)} 2>&1) || ${failed("n")}`,
    `[ "$n" != 0 ] || { echo nothing; exit 0; }`,
    `if out=$(git merge --no-ff --no-edit -m ${q(`Merge task #${task.id}: ${task.title}`)} ${q(task.branch)} 2>&1); then echo ok; exit 0; fi`,
    `files=$(git diff --name-only --diff-filter=U)`,
    `git merge --abort >/dev/null 2>&1`,
    `if [ -n "$files" ]; then echo conflict; printf '%s\\n' "$files"; else echo failed; printf '%s\\n' "$out"; fi`,
  ].join("\n");
}

/** git's way to remove a worktree herdr no longer has a workspace for, and the task's branch (herdr keeps it); a dirty worktree stays */
export function cleanupScript(path: string, worktree: string | null, branch: string): string {
  return [
    `cd -- ${q(path)} 2>/dev/null || { echo failed; echo "The project's folder is gone"; exit 0; }`,
    ...(worktree === null ? [] : [`if [ -e ${q(worktree)} ]; then out=$(git worktree remove ${q(worktree)} 2>&1) || ${failed("out")}; fi`]),
    "git worktree prune",
    `if git show-ref --verify --quiet ${q(`refs/heads/${branch}`)}; then out=$(git branch -D ${q(branch)} 2>&1) || ${failed("out")}; fi`,
    "echo ok",
  ].join("\n");
}

/** what a script printed: the word on its first line and the rest */
function outcome(printed: string): { word: string; rest: string } {
  const text = printed.trim();
  const at = text.indexOf("\n");
  return { word: at < 0 ? text : text.slice(0, at).trim(), rest: (at < 0 ? "" : text.slice(at + 1).trim()).slice(-2000) };
}

/** The reviewer's first prompt: the branch against its base, and the verdict line it must end with. */
export function reviewPrompt(task: Pick<AssistantTask, "title" | "brief" | "branch">, base: string): string {
  const ask = (brief: string) => launchPrompt(`Review another agent's work with fresh eyes, and change no file. Its task: ${task.title}.${brief} `
    + `Its changes are on branch ${task.branch}, made from ${base}: read \`git diff ${base}...HEAD\` and \`git log ${base}..HEAD\`, and the code around them. `
    + "Look for bugs, parts of the task that are missing, and broken tests. End your reply with one line: REVIEW: PASS when it is ready to merge, "
    + "or REVIEW: FINDINGS followed by the findings, one per line.");
  const full = ask(` ${task.brief}`);
  return full.length <= MAX_FIRST_MESSAGE_CHARS ? full : ask("");
}

/** The verdict a reviewer's reply ends with: its last `REVIEW:` line, and for findings what follows it. null: none yet. */
export function parseVerdict(reply: string): { pass: true } | { pass: false; findings: string } | null {
  const lines = reply.split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const match = /^[\s*_`>#-]*REVIEW:\s*(PASS|FINDINGS)\b[\s*_`:]*(.*)$/.exec(lines[at]!);
    if (!match) continue;
    if (match[1] === "PASS") return { pass: true };
    return { pass: false, findings: [match[2]!, ...lines.slice(at + 1)].join("\n").trim().slice(0, 8000) || "The reviewer named no findings" };
  }
  return null;
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
  /** a POSIX script on a machine (MachineManager.runScript): the merge and cleanup steps */
  run(machine: Machine, script: string, timeoutMs?: number): Promise<string>;
  now(): number;
}

export class AssistantTasks {
  private tasks: AssistantTask[];

  constructor(private path: string, private deps: TaskDeps) {
    this.tasks = readDocument(path, (value): value is AssistantTask[] => Array.isArray(value) && value.every(validTask), []);
  }


  list(status?: string): AssistantTask[] {
    if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) throw new AssistantError("invalid_status", `A status is one of ${TASK_STATUSES.join(", ")}`);
    return this.tasks.filter((task) => !task.dismissed && (status === undefined || task.status === status)).sort((a, b) => b.createdAt - a.createdAt || Number(b.id) - Number(a.id));
  }

  /** the live task whose own agent runs in that pane (not its reviewer): its alerts carry the task's title */
  paneTask(machineId: string, paneId: string): AssistantTask | undefined {
    return this.tasks.find((task) => task.machine === machineId && task.paneId === paneId && !FINISHED.includes(task.status) && task.status !== "failed");
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
    // Ready leads on to review, the PR and an automatic merge
    // (a step after the one that moved it has let go of the task)
    if (moved && next!.status === "ready") this.track(Promise.resolve().then(() => this.afterReady(id)));
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
      if (this.tasks.filter((other) => other.machine === task.machine && (other.status === "reviewing" || (RUNNING.includes(other.status) && other.reason === undefined))).length >= this.deps.maxRunning(task.machine)) continue;
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
      // a brief of several lines waits for the agent to be up and goes as a paste (sendBrief): an argument is one line
      const pasted = multiLine(task.brief);
      const opened = await this.deps.bridge(machine.id, "worktree/create", { method: "POST", body: {
        workspace_id: source, branch: task.branch, label: task.title, agent: { kind: task.agent, ...(pasted ? {} : { args: ["--", launchPrompt(task.brief)] }) },
      } }) as { workspace_id: string; pane_id: string; path: string; agent_started?: boolean; error?: { message?: string } };
      const started = { paneId: opened.pane_id, workspaceId: opened.workspace_id, worktree: opened.path, startedAt: this.deps.now() };
      if (opened.agent_started === false) {
        this.update(task.id, { ...started, status: "failed", error: opened.error?.message ?? "The agent did not start" });
        throw new AssistantError("agent_not_started", `The worktree is there, but the agent did not start: ${opened.error?.message ?? "no reason given"}`, 502);
      }
      return this.update(task.id, { ...started, status: "working", ...(pasted ? { briefPending: true as const } : {}) });
    } catch (error) {
      if (!(error instanceof AssistantError && error.code === "agent_not_started")) this.update(task.id, { status: "failed", error: message(error) });
      throw error;
    }
  }

  /** a frame of a machine's observer (MachineManager.observe): a task pane's agent state, or its end */
  heard(machineId: string, frame: ServerMessage): void {
    if (frame.type !== "pane-status" && frame.type !== "pane-exited") return;
    const reviewing = this.tasks.find((candidate) => candidate.machine === machineId && candidate.status === "reviewing" && candidate.reviewPaneId === frame.pane_id);
    if (reviewing) {
      if (frame.type === "pane-exited") this.needsYou(reviewing.id, "The reviewer's pane closed before it gave a verdict");
      else this.reviewerAt(reviewing, alertStatus(frame.agent_status, frame.background_wait));
      return;
    }
    const task = this.tasks.find((candidate) => candidate.machine === machineId && candidate.paneId === frame.pane_id && agentLed(candidate));
    if (!task) return;
    if (frame.type === "pane-exited") {
      if (RUNNING.includes(task.status)) this.update(task.id, { status: "failed", error: "The agent's pane closed" });
      return;
    }
    // at rest before its brief went, the agent is up and waits for it: that rest is not Ready
    if (task.briefPending && AT_REST.includes(alertStatus(frame.agent_status, frame.background_wait))) { this.track(this.sendBrief(task.id)); return; }
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
      if (task.machine !== machine.id) continue;
      if (task.status === "reviewing" && task.reviewPaneId !== undefined) {
        // a verdict a lost frame missed; a reviewer's pane gone is caught by its pane-exited frame
        const reviewer = machine.snapshot.panes.find((candidate) => candidate.pane_id === task.reviewPaneId);
        if (reviewer) this.reviewerAt(task, alertStatus(reviewer.agent_status, reviewer.background_wait));
        continue;
      }
      if (task.paneId === null || !agentLed(task)) continue;
      const pane = machine.snapshot.panes.find((candidate) => candidate.pane_id === task.paneId);
      const old = (task.startedAt ?? task.createdAt) < settled;
      if (!pane) {
        if (old && RUNNING.includes(task.status)) this.update(task.id, { status: "failed", error: "The agent's pane is gone" });
        continue;
      }
      if (task.briefPending && AT_REST.includes(alertStatus(pane.agent_status, pane.background_wait))) {
        if (pane.agent) this.track(this.sendBrief(task.id));
        else if (old) this.update(task.id, { status: "failed", error: "The agent stopped before its brief was sent" }, ["briefPending"]);
        continue;
      }
      const next = statusAfter(task, alertStatus(pane.agent_status, pane.background_wait));
      const now = next ? this.update(task.id, next) : task;
      if (old && now.worked && !pane.agent && RUNNING.includes(now.status)) this.update(task.id, { status: "failed", error: "The agent stopped" });
    }
  }

  /**
   * A brief of several lines, into the task's own agent once herdr shows it up and at rest: pasted as the
   * composer frames a multi-line message, then Enter as its own key. This is not held user input sent
   * after a disconnect (AGENTS.md): the server wrote this input for the task it started, and sends it
   * once, to that task's fresh pane, as it would have gone on the command line.
   */
  private async sendBrief(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const task = this.get(id);
      if (!task.briefPending || task.paneId === null) return;
      // up: the agent is in front of its pane (a frame can come before the snapshot knows it; the next one tries again)
      if (!this.deps.machine(task.machine)?.snapshot?.panes.some((pane) => pane.pane_id === task.paneId && pane.agent)) return;
      // marked sent first, so the work it starts is heard as work; a rest seen before it (a question at start) is not
      this.update(id, { status: "working" }, ["briefPending", "worked"]);
      await this.deps.bridge(task.machine, "pane/input", { method: "POST", body: { pane_id: task.paneId, text: pastedBrief(task.brief) } });
      await this.deps.bridge(task.machine, "pane/keys", { method: "POST", body: { pane_id: task.paneId, keys: ["Enter"] } });
    } catch (error) {
      this.update(id, { status: "failed", error: `The brief could not be sent: ${message(error)}` });
    } finally { this.busy.delete(id); }
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
   * (Dismiss removes them). A Queued or Scheduled task never starts, and a cron template
   * fires no more.
   */
  async cancel(id: unknown): Promise<AssistantTask> {
    const task = this.get(id);
    if (FINISHED.includes(task.status)) throw new AssistantError("finished", "That task has already ended", 409);
    if (this.starting === task.id) throw new AssistantError("starting", "That task is starting; cancel it again in a moment", 409);
    if (this.busy.has(task.id)) throw new AssistantError("busy", "That task is being reviewed or merged right now; cancel it again in a moment", 409);
    for (const pane of task.status === "failed" ? [] : [task.paneId, task.reviewPaneId]) {
      if (pane === null || pane === undefined) continue;
      await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: pane } }).catch((error: unknown) => {
        // a pane already gone is closed
        if (!(error instanceof AssistantError && error.status === 404)) throw error;
      });
    }
    return this.update(task.id, { status: "cancelled" }, ["reviewPaneId"]);
  }

  private pending = new Set<Promise<unknown>>();
  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  /** waits for the review, PR, merge and cleanup steps started so far (tests, and a clean stop) */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** a task the review, PR or merge steps are working on: one step at a time per task */
  private busy = new Set<string>();

  /** the server moves a task to Needs you itself: herdr's agent state leaves it there until the user acts */
  private needsYou(id: string, reason: string, drop: (keyof AssistantTask)[] = []): AssistantTask {
    return this.update(id, { status: "needs_you", reason: reason.slice(0, 2000) }, ["reviewPaneId", "reviewWorked", "reviewNudged", ...drop]);
  }

  /** the reviewer's agent state: at work is noted, at rest after work is read for its verdict */
  private reviewerAt(task: AssistantTask, agent: AgentStatus): void {
    if (agent === "working" || agent === "blocked") { if (!task.reviewWorked) this.update(task.id, { reviewWorked: true }); return; }
    if (AT_REST.includes(agent)) this.track(this.readReview(task.id));
  }

  private where(task: AssistantTask): { machine: Machine; project: AssistantProject } {
    const project = this.deps.project(task.project);
    if (!project) throw new AssistantError("unknown_project", "The task's project was removed", 404);
    const machine = this.deps.machine(task.machine);
    if (machine?.state !== "connected") throw new AssistantError("machine_offline", "The task's machine is not connected", 503);
    return { machine, project };
  }

  /** the branch the task merges into, read once from the project's checkout */
  private async baseOf(task: AssistantTask): Promise<string> {
    if (task.base !== undefined) return task.base;
    const { machine, project } = this.where(task);
    const base = (await this.deps.run(machine, baseScript(project.path))).trim();
    if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new AssistantError("no_base", `The project's checkout is on no branch to merge into (${base.slice(0, 200)})`);
    this.update(task.id, { base });
    return base;
  }

  /** At Ready: the review when it is on and has not passed, then a `pr` project's PR, then autoMerge's merge. */
  private async afterReady(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const task = this.get(id);
      if (task.status !== "ready") return;
      if (task.review && !task.reviewed) { await this.startReview(task); return; }
      // the card says what it merges into
      await this.baseOf(task).catch(() => undefined);
      const project = this.deps.project(task.project);
      if (project?.mergeMode === "pr" && task.prUrl === undefined && !task.nothingToMerge) await this.openPr(this.get(id));
      if (task.autoMerge && this.get(id).status === "ready") await this.merge(id);
    } catch (error) {
      this.needsYou(id, message(error));
    } finally { this.busy.delete(id); }
  }

  /** a fresh agent in the task's worktree, in a workspace of its own, that reviews the branch and ends with a verdict line */
  private async startReview(task: AssistantTask): Promise<void> {
    if (task.worktree === null) throw new AssistantError("no_worktree", "The task has no worktree to review");
    const base = await this.baseOf(task);
    const opened = await this.deps.bridge(task.machine, "workspace/create", { method: "POST", body: {
      cwd: task.worktree, label: task.title, agent: { kind: task.agent, args: ["--", reviewPrompt(task, base)] },
    } }) as { workspace_id: string; pane_id: string; agent_started?: boolean; error?: { message?: string } };
    if (opened.agent_started === false) {
      await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: opened.pane_id } }).catch(() => undefined);
      throw new AssistantError("agent_not_started", `The reviewer did not start: ${opened.error?.message ?? "no reason given"}`, 502);
    }
    this.update(task.id, { status: "reviewing", reviewPaneId: opened.pane_id, reviewRounds: (task.reviewRounds ?? 0) + 1 }, ["reviewWorked", "reviewNudged"]);
  }

  /**
   * The reviewer at rest: its last reply's verdict line. PASS closes it and makes the task Ready
   * (reviewed); FINDINGS go to the task's agent, which works again, until REVIEW_ROUNDS rounds found
   * some: then they go to the user. No verdict before it worked waits; at rest after work without one,
   * it is asked once for its verdict line, and at rest again without one the task goes to the user.
   */
  private async readReview(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const task = this.get(id);
      if (task.status !== "reviewing" || task.reviewPaneId === undefined) return;
      const conversation = await this.deps.bridge(task.machine, "pane/conversation", { query: { pane_id: task.reviewPaneId } }) as ConversationResponse;
      const reply = [...conversation.turns].reverse().find((turn) => turn.role === "assistant");
      const verdict = reply ? parseVerdict(reply.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n")) : null;
      if (verdict === null && !task.reviewWorked) return;
      if (verdict === null && !task.reviewNudged) {
        // first, so its work on the nudge is heard as such; its rest before it takes the nudge is not its answer
        this.update(id, { reviewNudged: true }, ["reviewWorked"]);
        await this.deps.bridge(task.machine, "pane/input", { method: "POST", body: { pane_id: task.reviewPaneId, text: VERDICT_NUDGE } });
        await this.deps.bridge(task.machine, "pane/keys", { method: "POST", body: { pane_id: task.reviewPaneId, keys: ["Enter"] } });
        return;
      }
      await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: task.reviewPaneId } }).catch(() => undefined);
      if (verdict === null) { this.needsYou(id, "Reviewer gave no verdict"); return; }
      if (verdict.pass) { this.update(id, { status: "ready", reviewed: true }, ["reviewPaneId", "findings", "reviewWorked", "reviewNudged"]); return; }
      const rounds = task.reviewRounds ?? 1;
      this.update(id, { findings: verdict.findings }, ["reviewPaneId", "reviewWorked", "reviewNudged"]);
      if (rounds >= REVIEW_ROUNDS) { this.needsYou(id, `The review still found problems after ${rounds} rounds`); return; }
      if (task.paneId === null) { this.needsYou(id, "The review found problems, and the task's agent is gone"); return; }
      // typed, then Enter as its own key: an agent's input box takes a pasted line and its Enter apart
      await this.deps.bridge(task.machine, "pane/input", { method: "POST", body: { pane_id: task.paneId, text: launchPrompt(`A reviewer found problems in your changes. Fix them and commit: ${verdict.findings}`) } });
      await this.deps.bridge(task.machine, "pane/keys", { method: "POST", body: { pane_id: task.paneId, keys: ["Enter"] } });
      this.update(id, { status: "working" });
    } catch (error) {
      this.needsYou(id, `The review could not go on: ${message(error)}`);
    } finally { this.busy.delete(id); }
  }

  /** pushes the branch and opens the PR; a branch with nothing ahead of its base is marked so instead */
  private async openPr(task: AssistantTask): Promise<AssistantTask> {
    if (task.worktree === null) throw new AssistantError("no_worktree", "The task has no worktree to push from");
    const base = await this.baseOf(task);
    const { machine } = this.where(task);
    const body = `${task.brief}\n\n${task.reviewed ? `Reviewed by a second agent: passed after ${task.reviewRounds ?? 1} round(s).` : "Not reviewed."}\n\nOpened by the Ovis Assistant (task #${task.id}).`;
    const { word, rest } = outcome(await this.deps.run(machine, prScript({ ...task, worktree: task.worktree }, base, body), MERGE_TIMEOUT_MS));
    if (word === "nothing") return this.update(task.id, { nothingToMerge: true });
    const prUrl = word === "ok" ? prUrlOf(rest) : null;
    if (prUrl === null) throw new AssistantError("pr_failed", `The PR could not be opened: ${rest || word}`, 502);
    return this.update(task.id, { prUrl });
  }

  /** Done, then its worktree and branch go; a cleanup that cannot run now leaves a note and Dismiss for later */
  private async finish(id: string, note?: string): Promise<AssistantTask> {
    const done = this.update(id, { status: "done", ...(note === undefined ? {} : { note }) }, ["reason"]);
    await this.cleanup(done).catch((error: unknown) => {
      this.update(id, { note: `${note === undefined ? "" : `${note}. `}The worktree stays: ${message(error)}` });
    });
    return this.get(id);
  }

  /** Approve's merge (or autoMerge's): the PR on GitHub, or the branch into the checkout's base branch. A failure is Needs you. */
  private async merge(id: string): Promise<AssistantTask> {
    let task = this.get(id);
    try {
      const { machine, project } = this.where(task);
      const base = await this.baseOf(task);
      task = this.update(id, { status: "merging" }, ["reason"]);
      const nothing = `Nothing merged: ${task.branch} has no commits ahead of ${base}`;
      if (project.mergeMode === "pr") {
        if (task.prUrl === undefined && !task.nothingToMerge) task = await this.openPr(task);
        if (task.nothingToMerge) return await this.finish(id, nothing);
        const { word, rest } = outcome(await this.deps.run(machine, prMergeScript(task, task.prUrl!), MERGE_TIMEOUT_MS));
        if (word !== "ok") return this.needsYou(id, `The PR could not be merged: ${rest || word}`);
        return await this.finish(id);
      }
      const { word, rest } = outcome(await this.deps.run(machine, localMergeScript(project.path, base, task), MERGE_TIMEOUT_MS));
      switch (word) {
        case "ok": return await this.finish(id);
        case "nothing": return await this.finish(id, nothing);
        case "dirty": return this.needsYou(id, `The checkout at ${project.path} has uncommitted changes. Commit or stash them there, then approve again`);
        case "conflict": return this.needsYou(id, `Merging into ${base} conflicts in: ${rest.split("\n").join(", ")}. The merge was aborted and nothing changed. Resolve it on the branch, then approve again`);
        default: return this.needsYou(id, `The merge failed: ${rest || word}`);
      }
    } catch (error) {
      return this.needsYou(id, message(error));
    }
  }

  /** Approve, only on the user's click in the app (no ovis-task route reaches it): merges a Ready task, or tries again one a merge or review left in Needs you. */
  async approve(id: unknown): Promise<AssistantTask> {
    const task = this.get(id);
    if (task.status !== "ready" && !(task.status === "needs_you" && task.reason !== undefined)) throw new AssistantError("not_ready", "Only a Ready task can be approved", 409);
    if (this.busy.has(task.id)) throw new AssistantError("busy", "That task is being reviewed or merged right now", 409);
    this.busy.add(task.id);
    try { return await this.merge(task.id); } finally { this.busy.delete(task.id); }
  }

  /**
   * Removes a task's worktree on its machine (herdr's way first, so its workspace goes with it; git's
   * when that workspace is gone) and its branch. Refused while an agent works in it.
   */
  private async cleanup(task: AssistantTask): Promise<AssistantTask> {
    if (task.worktree === null) return task;
    const { machine, project } = this.where(task);
    const working = machine.snapshot?.panes.some((pane) => pane.agent_status === "working"
      && (pane.pane_id === task.paneId || pane.pane_id === task.reviewPaneId || pane.workspace_id === task.workspaceId));
    if (working) throw new AssistantError("agent_working", "An agent is working in the task's worktree; it stays until that agent stops", 409);
    if (task.reviewPaneId !== undefined) await this.deps.bridge(task.machine, "pane/close", { method: "POST", body: { pane_id: task.reviewPaneId } }).catch(() => undefined);
    const removed = task.workspaceId !== null && await this.deps.bridge(task.machine, "worktree/remove", { method: "POST", body: { workspace_id: task.workspaceId } }).then(() => true, () => false);
    const { word, rest } = outcome(await this.deps.run(machine, cleanupScript(project.path, removed ? null : task.worktree, task.branch)));
    if (word !== "ok") throw new AssistantError("cleanup_failed", rest || word, 502);
    return this.update(task.id, { worktree: null, workspaceId: null, paneId: null }, ["reviewPaneId"]);
  }

  /** Dismiss, on the user's click: an ended task leaves the board, its worktree and branch removed first. */
  async dismiss(id: unknown): Promise<AssistantTask> {
    const task = this.get(id);
    if (!["done", "cancelled", "failed"].includes(task.status)) throw new AssistantError("not_finished", "Only a done, cancelled or failed task can be dismissed", 409);
    if (this.busy.has(task.id)) throw new AssistantError("busy", "That task is being merged right now", 409);
    // a project removed since leaves no folder to clean up in
    if (this.deps.project(task.project)) await this.cleanup(task);
    return this.update(task.id, { dismissed: true });
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
