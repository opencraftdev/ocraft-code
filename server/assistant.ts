/**
 * The Assistant VM's machines and projects (docs/plan/20261111-2112-assistant.md, phase 2).
 *
 * Machines are the herdr saved machines Remote PCs already discovers (MachineManager); this module
 * adds a health watcher for each and the settings herdr does not hold. Projects are folders the
 * user registers in the UI. Both live in stateDir/assistant/, written atomically at 0600.
 * The watcher only reads: a fix runs only on the user's click, never --takeover, never herdr focus.
 * Tasks (phase 4) are server/assistant-tasks.ts; the watcher checks their panes too.
 */
import { join } from "node:path";
import { ASSISTANT_AGENTS, type AddProjectRequest, type AssistantAgent, type AssistantMachine, type AssistantProblem, type AssistantProject, type AssistantState, type AssistantTask, type MachineHealth, type MergeMode, type ProjectRefusal } from "../shared/assistant.ts";
import { LOCAL_MACHINE, type Machine, type MachineEvent } from "../shared/machines.ts";
import type { AssistantSessions } from "./assistant-sessions.ts";
import { AssistantTasks, pastedBrief, type TaskBridge } from "./assistant-tasks.ts";
import type { ConversationResponse, HerdrPane } from "../shared/protocol.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { shellQuote } from "./machine-security.ts";
import { MachineActionRequired } from "./machines.ts";
import { writePrivateState } from "./private-state.ts";
import { BUNDLE_DIR } from "./remote-host.ts";
import { readStateDocument, setAsideDamaged } from "./state-document.ts";

/** Runs a POSIX script on a machine and returns its output (MachineManager.runScript; tests run it locally). */
export type RunScript = (machine: Machine, script: string, timeoutMs?: number) => Promise<string>;
/** Calls `run` after `ms`; returns what cancels it. Tests pass their own clock. */
export type Timer = (run: () => void, ms: number) => () => void;
export interface AssistantMachines {
  list(): Machine[];
  subscribe(listener: (event: MachineEvent) => void): () => void;
  retryNow(id: string): void;
  /** whether the machine's last connection found Windows (MachineManager.windows) */
  windows?(id: string): boolean;
}

export const HEALTH_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_RUNNING = 3;
/** The delay before a machine's next check: its interval, or after failed ones a longer one, as herdr discovery backs off (MachineManager.watchHerdrProfiles). */
export const nextCheckDelay = (intervalMs: number, failures: number): number =>
  failures === 0 ? intervalMs : Math.min(300_000, intervalMs * 2 ** Math.min(failures, 10));

const defaultTimer: Timer = (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); };

export class AssistantError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

/** herdr on the machine: the one on PATH, else the bundled one the bridge installs. */
const HERDR = `h=$(command -v herdr || printf '%s' "$HOME/${BUNDLE_DIR}/bin/herdr")`;
const sessionArgs = (session: string | undefined) => session ? `--session ${shellQuote(session)} ` : "";
const herdrRunning = (session: string | undefined) => `"$h" ${sessionArgs(session)}status server --json 2>/dev/null | grep -Eq '"running": ?true'`;

export function healthScript(session: string | undefined, gh: boolean): string {
  return [
    HERDR,
    `if ${herdrRunning(session)}; then echo herdr; fi`,
    ...ASSISTANT_AGENTS.map((agent) => `if command -v ${agent} >/dev/null 2>&1; then echo ${agent}; fi`),
    ...(gh ? ["if gh auth status >/dev/null 2>&1; then echo gh; fi"] : []),
    "true",
  ].join("; ");
}

/** Starts herdr's server when none runs; a running one is never stopped or replaced. */
export function startHerdrScript(session: string | undefined): string {
  return [
    HERDR,
    `if ! ${herdrRunning(session)}; then log="$HOME/.config/herdr-web-ui/bridges"; mkdir -p "$log"; nohup "$h" ${sessionArgs(session)}server </dev/null >>"$log/herdr.log" 2>&1 & fi`,
    "true",
  ].join("; ");
}

export function readHealth(output: string, gh: boolean, now: number): MachineHealth {
  const found = new Set(output.split("\n").map((line) => line.trim()));
  const agents = ASSISTANT_AGENTS.filter((agent) => found.has(agent));
  const problems: AssistantProblem[] = [];
  if (!found.has("herdr")) problems.push("herdr_stopped");
  if (agents.length === 0) problems.push("no_agent");
  if (gh && !found.has("gh")) problems.push("gh_signed_out");
  // the task panes are checked beside this, against Remote PCs' snapshot (AssistantTasks.checkPanes)
  return { checked_at: now, problems, agents };
}

/** Resolves a folder on the machine (`~` is its home) and says what it is, one `key=value` per line. */
export function projectScript(path: string): string {
  return [
    `p=${shellQuote(path)}`,
    `case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/\${p#??}";; esac`,
    `home=$(cd -P "$HOME" 2>/dev/null && pwd -P)`,
    `if ! real=$(cd -P -- "$p" 2>/dev/null && pwd -P); then echo missing; exit 0; fi`,
    `printf 'home=%s\\nreal=%s\\n' "$home" "$real"`,
    `if top=$(git -C "$real" rev-parse --show-toplevel 2>/dev/null); then printf 'top=%s\\n' "$top"; fi`,
    `git -C "$real" remote -v 2>/dev/null | sed 's/^/remote=/'`,
    "true",
  ].join("; ");
}

export function judgeProject(output: string): { path: string; mergeMode: MergeMode } | { refusal: ProjectRefusal } {
  const lines = output.split("\n");
  if (lines[0]?.trim() === "missing") return { refusal: "missing" };
  const value = (key: string) => lines.find((line) => line.startsWith(key + "="))?.slice(key.length + 1);
  const real = value("real");
  const home = value("home");
  if (!real || !home) return { refusal: "missing" };
  if (real === "/") return { refusal: "root" };
  if (real === home) return { refusal: "home" };
  if (home.startsWith(real + "/")) return { refusal: "home_parent" };
  if (value("top") !== real) return { refusal: "not_git" };
  const github = lines.some((line) => line.startsWith("remote=") && /github\.com[:/]/i.test(line));
  return { path: real, mergeMode: github ? "pr" : "local" };
}

const REFUSALS: Record<ProjectRefusal, string> = {
  invalid_path: "Enter an absolute folder path, or one that starts with ~/",
  missing: "That folder does not exist on the machine",
  not_git: "That folder is not the top folder of a git repository",
  root: "The root folder cannot be a project",
  home: "The home folder cannot be a project",
  home_parent: "A folder that holds the home folder cannot be a project",
  duplicate: "That folder is already a project",
  unknown_machine: "That machine is not one of herdr's saved machines",
  windows: "Windows isn't supported by the Assistant yet",
};
/** what ovis-task peek shows of a session: its last turns, each cut to its end */
const PEEK_TURNS = 12;
const PEEK_TEXT = 8000;
/** the longest message ovis-task send hands an agent */
const SEND_LIMIT = 20_000;
const refuse = (refusal: ProjectRefusal, status = 400) => new AssistantError(refusal, REFUSALS[refusal], status);

const validAgent = (value: unknown): value is AssistantAgent => (ASSISTANT_AGENTS as readonly unknown[]).includes(value);
const validProject = (item: unknown): item is AssistantProject => isJsonObject(item) && typeof item.id === "string" && item.id !== ""
  && typeof item.machine === "string" && typeof item.path === "string" && item.path.startsWith("/")
  && (item.mergeMode === "pr" || item.mergeMode === "local") && validAgent(item.defaultAgent);
const validMaxRunning = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20;

/** A JSON document of stateDir/assistant/: absent is empty, not JSON is set aside (as herdr-profile-state.json is), another shape stops the start. */
export function readDocument<T>(path: string, valid: (value: unknown) => value is T, empty: T): T {
  const read = readStateDocument(path);
  if (read.kind === "missing") return empty;
  if (read.kind === "malformed") {
    console.error(`${path} is not JSON; it was set aside as ${setAsideDamaged(path)}`);
    return empty;
  }
  if (!valid(read.value)) throw new Error(`Invalid ${path}; it was left as it is`);
  return read.value;
}

type MachineSettings = Record<string, { maxRunning: number }>;
interface Watch { failures: number; health: MachineHealth | null; cancel?: () => void; busy?: Promise<void> }

export class Assistant {
  private projects: AssistantProject[];
  private settings: MachineSettings;
  private projectsPath: string;
  private settingsPath: string;
  private watched = new Map<string, Watch>();
  private stopped = false;
  private unsubscribe: () => void;
  private intervalMs: number;
  private timer: Timer;
  private now: () => number;

  readonly sessions: AssistantSessions | null;
  readonly tasks: AssistantTasks;
  private bridge: TaskBridge;

  constructor(stateDir: string, private machines: AssistantMachines, private run: RunScript, options: { intervalMs?: number; timer?: Timer; now?: () => number; sessions?: AssistantSessions; bridge?: TaskBridge } = {}) {
    this.sessions = options.sessions ?? null;
    this.intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;
    this.timer = options.timer ?? defaultTimer;
    this.now = options.now ?? Date.now;
    const directory = join(stateDir, "assistant");
    this.projectsPath = join(directory, "projects.json");
    this.settingsPath = join(directory, "machines.json");
    this.projects = readDocument(this.projectsPath, (value): value is AssistantProject[] => Array.isArray(value) && value.every(validProject), []);
    this.settings = readDocument(this.settingsPath, (value): value is MachineSettings => isJsonObject(value)
      && Object.values(value).every((entry) => isJsonObject(entry) && validMaxRunning(entry.maxRunning)), {});
    this.bridge = options.bridge ?? (() => Promise.reject(new AssistantError("machine_offline", "This server reaches no machines", 503)));
    this.tasks = new AssistantTasks(join(directory, "tasks.json"), {
      project: (id) => this.projects.find((project) => project.id === id),
      // a Windows machine is none the queue can start a task on: its tasks stay Queued
      machine: (id) => this.isWindows(id) ? undefined : this.watchable().find((machine) => machine.id === id),
      maxRunning: (id) => this.settings[id]?.maxRunning ?? DEFAULT_MAX_RUNNING,
      bridge: this.bridge,
      run: (machine, script, timeoutMs) => this.run(machine, script, timeoutMs),
      now: this.now,
    });
    this.unsubscribe = machines.subscribe((event) => {
      // a machine connected again resumes its queue by itself (decision 16)
      if (event.type === "machines") {
        this.sync(); void this.tasks.runQueue();
        // herdr here came back (or this server started): an Assistant pane it lost is started again
        const local = event.machines.find((machine) => machine.id === LOCAL_MACHINE);
        if (local?.state === "connected" && local.snapshot) void this.sessions?.revive(new Set(local.snapshot.panes.map((pane) => pane.pane_id)));
      }
      if (event.type === "machine-message") this.tasks.heard(event.machine_id, event.message);
    });
    // a restart catches up at once: a cron slot missed while down fires once
    void this.tasks.runQueue();
  }

  /** herdr's saved machines, the only ones the Assistant runs tasks on */
  private watchable(): Machine[] { return this.machines.list().filter((machine) => machine.herdr_profile_id && machine.enabled); }
  private machine(id: string): Machine {
    const machine = this.watchable().find((candidate) => candidate.id === id);
    if (!machine) throw refuse("unknown_machine", 404);
    return machine;
  }
  // ponytail: Windows is left out (its checks are POSIX sh); PowerShell variants when the Assistant supports it
  private isWindows(id: string): boolean { return this.machines.windows?.(id) === true; }
  private windowsHealth(): MachineHealth { return { checked_at: this.now(), problems: ["windows"], agents: [] }; }
  /** a project on a Windows machine is refused before anything runs there */
  private refuseWindows(projectId: unknown): void {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (project && this.isWindows(project.machine)) throw refuse("windows");
  }

  /** ovis-task create */
  async createTask(body: unknown): Promise<AssistantTask> {
    if (isJsonObject(body)) this.refuseWindows(body.project);
    return this.tasks.create(body);
  }

  /**
   * ovis-task machines: each machine with the folders its herdr workspaces have open (the panes'
   * working directories, from the snapshot Remote PCs already holds). Read from that snapshot only:
   * nothing runs on the machine, and it is how the Assistant tells the user which folder to add.
   */
  machineFolders(): { name: string; state: string; agents: string[]; folders: string[] }[] {
    return this.watchable().map((machine) => ({
      name: machine.name,
      state: machine.state,
      agents: [...(this.watched.get(machine.id)?.health?.agents ?? [])],
      folders: [...new Set((machine.snapshot?.panes ?? []).map((pane) => pane.cwd).filter((cwd): cwd is string => typeof cwd === "string" && cwd !== ""))].sort(),
    }));
  }

  /** a connected machine by its name (or id), for the herdr session commands */
  private machineNamed(name: unknown): Machine {
    const machine = typeof name === "string" ? this.watchable().find((candidate) => candidate.name === name || candidate.id === name) : undefined;
    if (!machine) throw refuse("unknown_machine", 404);
    if (this.isWindows(machine.id)) throw refuse("windows");
    if (machine.state !== "connected" || !machine.snapshot) throw new AssistantError("machine_offline", "That machine is not connected", 503);
    return machine;
  }
  private paneOn(machine: Machine, paneId: unknown): HerdrPane {
    const pane = typeof paneId === "string" ? machine.snapshot?.panes.find((candidate) => candidate.pane_id === paneId) : undefined;
    if (!pane) throw new AssistantError("unknown_pane", "That pane is not open on that machine: run ovis-task sessions", 404);
    return pane;
  }

  /**
   * ovis-task sessions [machine]: every herdr workspace and pane on the connected machines (one
   * machine when named), from the snapshot Remote PCs holds: its agent, state, title and folder.
   */
  herdrSessions(machineName?: unknown): unknown[] {
    const machines = machineName === undefined ? this.watchable().filter((machine) => !this.isWindows(machine.id)) : [this.machineNamed(machineName)];
    return machines.map((machine) => ({
      machine: machine.name,
      state: machine.state,
      workspaces: (machine.snapshot?.workspaces ?? []).map((workspace) => ({
        workspace: workspace.label ?? workspace.workspace_id,
        panes: (machine.snapshot?.panes ?? []).filter((pane) => pane.workspace_id === workspace.workspace_id).map((pane) => ({
          pane: pane.pane_id, agent: pane.agent ?? null, status: pane.agent_status ?? null,
          title: pane.terminal_title_stripped ?? pane.terminal_title ?? null, folder: pane.cwd ?? null,
        })),
      })),
    }));
  }

  /**
   * ovis-task peek <machine> <pane>: what a herdr session says. An agent's last turns from its
   * conversation, or the pane's last screen lines when it has none (a shell). Read only.
   */
  async peekSession(body: unknown): Promise<unknown> {
    const machine = this.machineNamed(isJsonObject(body) ? body.machine : undefined);
    const pane = this.paneOn(machine, isJsonObject(body) ? body.pane : undefined);
    const conversation = pane.agent ? await this.bridge(machine.id, "pane/conversation", { query: { pane_id: pane.pane_id } }).catch(() => null) as ConversationResponse | null : null;
    const turns = (conversation?.turns ?? []).slice(-PEEK_TURNS).map((turn) => ({
      role: turn.role,
      text: turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n").slice(-PEEK_TEXT),
    })).filter((turn) => turn.text !== "");
    if (turns.length > 0) return { machine: machine.name, pane: pane.pane_id, agent: pane.agent, status: pane.agent_status ?? null, turns };
    const read = await this.bridge(machine.id, "pane/read", { query: { pane_id: pane.pane_id, source: "recent", format: "text", lines: "200" } }) as { read?: { text?: string } };
    return { machine: machine.name, pane: pane.pane_id, agent: pane.agent ?? null, status: pane.agent_status ?? null, screen: (read.read?.text ?? "").slice(-PEEK_TEXT) };
  }

  /**
   * ovis-task send <machine> <pane> <message>: hands work to the agent of a herdr session, pasted
   * as the user's own message would be, then Enter. Only to a pane with an agent at rest: a working
   * agent is never interrupted, and a shell never typed into.
   */
  async sendToSession(body: unknown): Promise<unknown> {
    const machine = this.machineNamed(isJsonObject(body) ? body.machine : undefined);
    const pane = this.paneOn(machine, isJsonObject(body) ? body.pane : undefined);
    const message = isJsonObject(body) ? body.message : undefined;
    if (typeof message !== "string" || message.trim() === "" || message.length > SEND_LIMIT) throw new AssistantError("invalid_message", `A message is 1 to ${SEND_LIMIT} characters`, 400);
    if (!pane.agent) throw new AssistantError("no_agent", "That pane runs no agent: send only to an agent's pane", 409);
    if (pane.agent_status === "working") throw new AssistantError("pane_busy", "That agent is working: wait until it is idle or done, then send", 409);
    if (this.tasks.list().some((task) => task.machine === machine.id && (task.paneId === pane.pane_id || task.reviewPaneId === pane.pane_id))) throw new AssistantError("task_pane", "That pane is a task's: use ovis-task answer or cancel for it", 409);
    await this.bridge(machine.id, "pane/input", { method: "POST", body: { pane_id: pane.pane_id, text: pastedBrief(message) } });
    await this.bridge(machine.id, "pane/keys", { method: "POST", body: { pane_id: pane.pane_id, keys: ["Enter"] } });
    return { ok: true, machine: machine.name, pane: pane.pane_id };
  }

  state(): AssistantState {
    const machines: AssistantMachine[] = this.watchable().map((machine) => ({
      id: machine.id, name: machine.name, state: machine.state,
      health: this.isWindows(machine.id) ? this.windowsHealth() : this.watched.get(machine.id)?.health ?? null,
      maxRunning: this.settings[machine.id]?.maxRunning ?? DEFAULT_MAX_RUNNING,
    }));
    return { machines, projects: [...this.projects], sessions: this.sessions?.list() ?? [], tasks: this.tasks.list() };
  }

  /**
   * Runs an ovis-task read in a project's folder on its machine (server/ovis-task.ts). A removed
   * project, or one whose machine left herdr's catalog, is refused before anything runs.
   */
  runInProject(id: string, script: (root: string) => string): Promise<string> {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (!project) return Promise.reject(new AssistantError("unknown_project", "No project has that name; `ovis-task projects` lists them", 404));
    const machine = this.watchable().find((candidate) => candidate.id === project.machine);
    if (!machine) return Promise.reject(new AssistantError("unknown_machine", "That project's machine is not one of herdr's saved machines", 404));
    if (this.isWindows(machine.id)) return Promise.reject(refuse("windows"));
    return this.run(machine, script(project.path));
  }

  private sync(): void {
    if (this.stopped) return;
    const ids = new Set(this.watchable().map((machine) => machine.id));
    for (const id of ids) if (!this.watched.has(id)) { this.watched.set(id, { failures: 0, health: null }); void this.check(id); }
    for (const [id, watch] of this.watched) if (!ids.has(id)) { watch.cancel?.(); this.watched.delete(id); }
  }

  /** One check of a machine now, then the next one scheduled; a check already running is the one asked for. */
  check(id: string): Promise<void> {
    const watch = this.watched.get(id);
    if (!watch || this.stopped) return Promise.resolve();
    if (watch.busy) return watch.busy;
    watch.cancel?.(); watch.cancel = undefined;
    watch.busy = (async () => {
      const machine = this.watchable().find((candidate) => candidate.id === id);
      if (!machine) return;
      const health = await this.inspect(machine);
      if (this.stopped || this.watched.get(id) !== watch) return;
      watch.health = health;
      this.tasks.checkPanes(this.watchable().find((candidate) => candidate.id === id) ?? machine, this.intervalMs);
      // the queue's clock is this check: `at` and cron times are seen within one interval of each machine's
      // ponytail: a template whose machine is down (backed off up to 5 min) or out of the catalog fires late; its task could not start sooner anyway
      void this.tasks.runQueue();
      watch.failures = health.problems.includes("unreachable") ? watch.failures + 1 : 0;
      watch.cancel = this.timer(() => void this.check(id), nextCheckDelay(this.intervalMs, watch.failures));
    })().finally(() => { watch.busy = undefined; });
    return watch.busy;
  }

  private async inspect(machine: Machine): Promise<MachineHealth> {
    if (this.isWindows(machine.id)) return this.windowsHealth();
    const gh = this.projects.some((project) => project.machine === machine.id && project.mergeMode === "pr");
    try {
      return readHealth(await this.run(machine, healthScript(machine.target?.session, gh)), gh, this.now());
    } catch (error) {
      if (error instanceof MachineActionRequired && error.action === "connect") return { checked_at: this.now(), problems: ["not_connected"], agents: [] };
      return { checked_at: this.now(), problems: ["unreachable"], agents: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  async addProject(body: unknown): Promise<AssistantProject> {
    if (!isJsonObject(body) || typeof body.machine !== "string") throw refuse("unknown_machine", 404);
    const request = body as Partial<AddProjectRequest>;
    const path = typeof request.path === "string" ? request.path.trim() : "";
    if (!path || path.length > 4096 || /[\0\r\n]/.test(path) || !(path.startsWith("/") || path === "~" || path.startsWith("~/"))) throw refuse("invalid_path");
    if (request.defaultAgent !== undefined && !validAgent(request.defaultAgent)) throw new AssistantError("invalid_agent", "Choose Claude Code or Codex");
    const machine = this.machine(body.machine);
    if (this.isWindows(machine.id)) throw refuse("windows");
    const judged =judgeProject(await this.run(machine, projectScript(path)));
    if ("refusal" in judged) throw refuse(judged.refusal);
    if (this.projects.some((project) => project.machine === machine.id && project.path === judged.path)) throw refuse("duplicate", 409);
    const project: AssistantProject = { id: this.newId(judged.path), machine: machine.id, path: judged.path, mergeMode: judged.mergeMode, defaultAgent: request.defaultAgent ?? "claude" };
    this.saveProjects([...this.projects, project]);
    if (project.mergeMode === "pr") void this.check(machine.id);
    return project;
  }

  /** the folder's name, made unique: what the Assistant will call the project (ovis-task <project>) */
  private newId(path: string): string {
    const base = (path.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "project";
    let id = base;
    for (let n = 2; this.projects.some((project) => project.id === id); n += 1) id = `${base}-${n}`;
    return id;
  }

  updateProject(id: string, body: unknown): AssistantProject {
    const index = this.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new AssistantError("not_found", "That project is gone", 404);
    if (!isJsonObject(body)) throw new AssistantError("invalid_body", "Expected a project change");
    const next = { ...this.projects[index]! };
    if (body.mergeMode !== undefined) {
      if (body.mergeMode !== "pr" && body.mergeMode !== "local") throw new AssistantError("invalid_merge_mode", "Choose pull request or local merge");
      next.mergeMode = body.mergeMode;
    }
    if (body.defaultAgent !== undefined) {
      if (!validAgent(body.defaultAgent)) throw new AssistantError("invalid_agent", "Choose Claude Code or Codex");
      next.defaultAgent = body.defaultAgent;
    }
    this.saveProjects(this.projects.map((project, at) => at === index ? next : project));
    return next;
  }

  removeProject(id: string): void {
    if (!this.projects.some((project) => project.id === id)) throw new AssistantError("not_found", "That project is gone", 404);
    this.saveProjects(this.projects.filter((project) => project.id !== id));
  }

  setMachine(id: string, body: unknown): void {
    this.machine(id);
    if (!isJsonObject(body) || !validMaxRunning(body.maxRunning)) throw new AssistantError("invalid_max_running", "Max running tasks is a whole number from 1 to 20");
    const settings = { ...this.settings, [id]: { maxRunning: body.maxRunning } };
    writePrivateState(this.settingsPath, settings);
    this.settings = settings;
    void this.tasks.runQueue();
  }

  /** Only on the user's click: starts herdr there when it is not running, then checks again. */
  async fix(id: string, body: unknown): Promise<void> {
    const machine = this.machine(id);
    if (!isJsonObject(body) || body.fix !== "start_herdr") throw new AssistantError("invalid_fix", "Unknown fix");
    await this.run(machine, startHerdrScript(machine.target?.session));
    // Remote PCs reconnects at once instead of after its back-off
    this.machines.retryNow(id);
    await this.check(id);
  }

  private saveProjects(projects: AssistantProject[]): void {
    writePrivateState(this.projectsPath, projects);
    this.projects = projects;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const watch of this.watched.values()) watch.cancel?.();
    this.watched.clear();
  }
}

/**
 * The Assistant-mode routes (/api/assistant/...), for this app's own pages only. Projects are added,
 * changed and removed only here, by the user (plan decision 14), and fixes run only on a click
 * (decision 16). The ovis-task CLI (phase 3) must never get a route that adds a project: it lists
 * projects through read-only routes of its own. A write here must carry a browser page's Origin
 * (index.ts already refused one that is not this app's), so a client that sends none is refused.
 */
export async function handleAssistantRequest(request: Request, pathname: string, assistant: Assistant): Promise<Response> {
  const parts = pathname.slice("/api/assistant".length).split("/").filter(Boolean);
  const [collection, id, action] = parts;
  const route = parts.length === 0 ? "" : collection === "projects" && parts.length <= 2 ? (id ? "/projects/:id" : "/projects")
    : collection === "machines" && id && (parts.length === 2 || (parts.length === 3 && action === "fix")) ? (action ? "/machines/:id/fix" : "/machines/:id")
    : collection === "sessions" && parts.length <= 2 ? (id ? "/sessions/:name" : "/sessions")
    : collection === "tasks" && id && parts.length === 3 && ["restart", "cancel", "approve", "dismiss"].includes(action!) ? `/tasks/:id/${action}` : null;
  if (route === null) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  setRequestRoute(`/api/assistant${route}`);
  const allowed: Record<string, string[]> = { "": ["GET"], "/projects": ["POST"], "/projects/:id": ["PATCH", "DELETE"], "/machines/:id": ["PATCH"], "/machines/:id/fix": ["POST"], "/sessions": ["POST"], "/sessions/:name": ["GET"], "/tasks/:id/restart": ["POST"], "/tasks/:id/cancel": ["POST"], "/tasks/:id/approve": ["POST"], "/tasks/:id/dismiss": ["POST"] };
  if (!allowed[route]!.includes(request.method)) return jsonResponse({ error: { code: "method_not_allowed", message: `use ${allowed[route]!.join(" or ")}` } }, 405, { allow: allowed[route]!.join(", ") });
  if (request.method !== "GET" && !request.headers.get("origin")) return jsonResponse({ error: { code: "browser_only", message: "Use Assistant controls from this app" } }, 403);
  const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => null);
  const sessions = () => {
    if (!assistant.sessions) throw new AssistantError("not_found", "This server runs no Assistant sessions", 404);
    return assistant.sessions;
  };
  try {
    switch (`${request.method} ${route}`) {
      case "GET ": return jsonResponse(assistant.state());
      case "POST /projects": return jsonResponse(await assistant.addProject(body), 201);
      case "PATCH /projects/:id": return jsonResponse(assistant.updateProject(id!, body));
      case "DELETE /projects/:id": assistant.removeProject(id!); return jsonResponse({ ok: true });
      case "PATCH /machines/:id": assistant.setMachine(id!, body); return jsonResponse({ ok: true });
      // New session: only on the user's click, in this app
      case "POST /sessions": await sessions().start(); return jsonResponse(assistant.state(), 201);
      case "GET /sessions/:name": return jsonResponse(sessions().transcript(id!));
      // Restart agent: only on the user's click, in this app (decision 16); ovis-task has no such route
      case "POST /tasks/:id/restart": await assistant.tasks.restart(id!); return jsonResponse(assistant.state());
      case "POST /tasks/:id/cancel": await assistant.tasks.cancel(id!); return jsonResponse(assistant.state());
      // Approve merges: only the user, in this app. ovis-task has no such route, so the Assistant never merges
      case "POST /tasks/:id/approve": await assistant.tasks.approve(id!); return jsonResponse(assistant.state());
      case "POST /tasks/:id/dismiss": await assistant.tasks.dismiss(id!); return jsonResponse(assistant.state());
      default: await assistant.fix(id!, body); return jsonResponse(assistant.state());
    }
  } catch (error) {
    if (error instanceof AssistantError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    // what SSH said on the machine: a fix or a folder check that could not run there
    return jsonResponse({ error: { code: "machine_unavailable", message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }, 502);
  }
}
