/**
 * The Assistant VM's machines and delegation (docs/plan/20261112-1622-assistant-delegation.md).
 *
 * Machines are the herdr saved machines Remote PCs already discovers (MachineManager); this module
 * adds a health watcher for each and the settings herdr does not hold, in stateDir/assistant/,
 * written atomically at 0600. Delegation is herdr-native: `ovis-task sessions`/`peek` read the
 * sessions on every machine, `send` messages one, `open` starts one. There is no project registry
 * and no task engine: projects.json and tasks.json of earlier builds stay on disk, unread.
 * The watcher only reads: a fix runs only on the user's click, never --takeover, never herdr focus.
 */
import { join } from "node:path";
import { ASSISTANT_AGENTS, type AssistantMachine, type AssistantProblem, type AssistantState, type MachineHealth } from "../shared/assistant.ts";
import { firstMessageFault, MAX_FIRST_MESSAGE_CHARS } from "../shared/launch-rules.ts";
import { MAX_LABEL_CHARS } from "../shared/labels.ts";
import { LOCAL_MACHINE, type Machine, type MachineEvent } from "../shared/machines.ts";
import type { AssistantSession } from "./assistant-sessions.ts";
import type { ConversationResponse, HerdrPane } from "../shared/protocol.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { slowMachinePath } from "./machine-api.ts";
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

/** One call to a machine's bridge: its JSON answer, or a thrown AssistantError. Tests pass their own. */
export type MachineBridge = (machineId: string, path: string, request?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> }) => Promise<unknown>;

export const HEALTH_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_RUNNING = 3;
/** The delay before a machine's next check: its interval, or after failed ones a longer one, as herdr discovery backs off (MachineManager.watchHerdrProfiles). */
export const nextCheckDelay = (intervalMs: number, failures: number): number =>
  failures === 0 ? intervalMs : Math.min(300_000, intervalMs * 2 ** Math.min(failures, 10));

const defaultTimer: Timer = (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); };

export class AssistantError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

/** The bridge as the PC proxy reaches it (server/machine-api.ts), with the PC's own token, from this server. */
export function machineBridge(manager: { endpoint(id: string): { url: string; token: string } | undefined; retryNow(id: string): void }): MachineBridge {
  return async (machineId, path, { method = "GET", body, query } = {}) => {
    const endpoint = manager.endpoint(machineId);
    if (!endpoint) {
      manager.retryNow(machineId);
      throw new AssistantError("machine_offline", "That machine is not connected", 503);
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

/**
 * A message as the chat's composer types a multi-line one (src/lib/compose.ts composerPayload): each
 * line break a CR, inside one bracketed-paste pair, so Claude Code and Codex take it as one message and
 * the Enter after it sends it. A message holds no control character (firstMessageFault), so no paste marker.
 */
export const pastedBrief = (text: string): string => `\u001b[200~${text.trim().replace(/\r\n?/g, "\n").replace(/\n/g, "\r")}\u001b[201~`;

/** herdr on the machine: the one on PATH, else the bundled one the bridge installs. */
const HERDR = `h=$(command -v herdr || printf '%s' "$HOME/${BUNDLE_DIR}/bin/herdr")`;
const sessionArgs = (session: string | undefined) => session ? `--session ${shellQuote(session)} ` : "";
const herdrRunning = (session: string | undefined) => `"$h" ${sessionArgs(session)}status server --json 2>/dev/null | grep -Eq '"running": ?true'`;

export function healthScript(session: string | undefined): string {
  return [
    HERDR,
    `if ${herdrRunning(session)}; then echo herdr; fi`,
    ...ASSISTANT_AGENTS.map((agent) => `if command -v ${agent} >/dev/null 2>&1; then echo ${agent}; fi`),
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

export function readHealth(output: string, now: number): MachineHealth {
  const found = new Set(output.split("\n").map((line) => line.trim()));
  const agents = ASSISTANT_AGENTS.filter((agent) => found.has(agent));
  const problems: AssistantProblem[] = [];
  if (!found.has("herdr")) problems.push("herdr_stopped");
  if (agents.length === 0) problems.push("no_agent");
  return { checked_at: now, problems, agents };
}

/**
 * `ovis-task open`'s folder, resolved on the machine (`~` is its home): it prints `refused:<code>`
 * and stops, or `ok` and the folder (symlinks followed). The folder is under the machine's home and
 * not home itself. With `create`, a missing one is made (only below a folder already under home)
 * and a folder that is no git repository gets `git init`. Every run exits 0; the first line says how it went.
 */
export function openFolderScript(path: string, create: boolean): string {
  return [
    `p=${shellQuote(path)}`,
    `case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/\${p#??}";; esac`,
    `home=$(cd -P "$HOME" 2>/dev/null && pwd -P) || { echo refused:missing; exit 0; }`,
    ...(create ? [
      `a="$p"; while [ ! -e "$a" ]; do a=$(dirname -- "$a"); done`,
      `ra=$(cd -P -- "$a" 2>/dev/null && pwd -P) || { echo refused:missing; exit 0; }`,
      `case "$ra/" in "$home"/*) ;; *) echo refused:outside_home; exit 0;; esac`,
      `mkdir -p -- "$p" 2>/dev/null || { echo refused:not_created; exit 0; }`,
    ] : []),
    `real=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { echo refused:missing; exit 0; }`,
    `[ "$real" != "$home" ] || { echo refused:home; exit 0; }`,
    `case "$real" in "$home"/*) ;; *) echo refused:outside_home; exit 0;; esac`,
    ...(create ? [`git -C "$real" rev-parse --git-dir >/dev/null 2>&1 || git init -q -- "$real" >/dev/null 2>&1 || { echo refused:not_created; exit 0; }`] : []),
    `echo ok; printf '%s\\n' "$real"`,
  ].join("\n");
}

const OPEN_REFUSALS: Record<string, string> = {
  invalid_path: "Give the folder as an absolute path or one that starts with ~/, without .. or control characters",
  missing: "That folder does not exist on the machine: add --create to make it",
  outside_home: "The folder must be under the machine's home folder",
  home: "The home folder itself cannot be opened: name a folder under it",
  not_created: "The folder could not be made or git init failed there",
};
const refuseOpen = (code: string) => new AssistantError(code, OPEN_REFUSALS[code] ?? "That folder cannot be opened", code === "missing" ? 404 : 400);

/** the workspace's name: the brief's first words */
export function briefLabel(brief: string): string {
  const words = brief.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.length <= MAX_LABEL_CHARS ? words : `${words.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** what ovis-task peek shows of a session: its last turns, each cut to its end */
const PEEK_TURNS = 12;
const PEEK_TEXT = 8000;
/** the longest message ovis-task send hands an agent */
const SEND_LIMIT = 20_000;
/** how long `open` waits for the new agent to be up before its brief goes */
const AGENT_UP_MS = 60_000;

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
/** a session `ovis-task open` started: machine id and pane id (stateDir/assistant/opened.json) */
interface Opened { machine: string; pane: string; at: number }
interface Watch { failures: number; health: MachineHealth | null; cancel?: () => void; busy?: Promise<void> }

export class Assistant {
  private settings: MachineSettings;
  private settingsPath: string;
  private openedPath: string;
  private opened: Opened[];
  private watched = new Map<string, Watch>();
  private stopped = false;
  private unsubscribe: () => void;
  private intervalMs: number;
  private timer: Timer;
  private now: () => number;
  /** machines with an `open` in progress: their limit is counted one at a time */
  private opening = new Map<string, Promise<unknown>>();

  readonly session: AssistantSession | null;
  private bridge: MachineBridge;

  constructor(stateDir: string, private machines: AssistantMachines, private run: RunScript, options: { intervalMs?: number; timer?: Timer; now?: () => number; session?: AssistantSession; bridge?: MachineBridge } = {}) {
    this.session = options.session ?? null;
    this.intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;
    this.timer = options.timer ?? defaultTimer;
    this.now = options.now ?? Date.now;
    const directory = join(stateDir, "assistant");
    this.settingsPath = join(directory, "machines.json");
    this.openedPath = join(directory, "opened.json");
    this.settings = readDocument(this.settingsPath, (value): value is MachineSettings => isJsonObject(value)
      && Object.values(value).every((entry) => isJsonObject(entry) && validMaxRunning(entry.maxRunning)), {});
    this.opened = readDocument(this.openedPath, (value): value is Opened[] => Array.isArray(value)
      && value.every((item) => isJsonObject(item) && typeof item.machine === "string" && typeof item.pane === "string" && typeof item.at === "number"), []);
    this.bridge = options.bridge ?? (() => Promise.reject(new AssistantError("machine_offline", "This server reaches no machines", 503)));
    this.unsubscribe = machines.subscribe((event) => {
      if (event.type === "machines") {
        this.sync();
        // herdr here came back (or this server started): the Assistant's pane is checked at once
        const local = event.machines.find((machine) => machine.id === LOCAL_MACHINE);
        if (local?.state === "connected" && local.snapshot) void this.session?.check();
      }
      if (event.type === "machine-message" && event.machine_id === LOCAL_MACHINE && event.message.type === "pane-status") {
        this.session?.heard(event.message.pane_id, event.message.agent_status);
      }
    });
  }

  /** herdr's saved machines, the ones the Assistant delegates to */
  private watchable(): Machine[] { return this.machines.list().filter((machine) => machine.herdr_profile_id && machine.enabled); }
  private machine(id: string): Machine {
    const machine = this.watchable().find((candidate) => candidate.id === id);
    if (!machine) throw new AssistantError("unknown_machine", "That machine is not one of herdr's saved machines", 404);
    return machine;
  }
  // ponytail: Windows is left out (its checks are POSIX sh); PowerShell variants when the Assistant supports it
  private isWindows(id: string): boolean { return this.machines.windows?.(id) === true; }
  private windowsHealth(): MachineHealth { return { checked_at: this.now(), problems: ["windows"], agents: [] }; }
  private maxRunning(id: string): number { return this.settings[id]?.maxRunning ?? DEFAULT_MAX_RUNNING; }

  /**
   * ovis-task machines: each machine with the folders its herdr workspaces have open (the panes'
   * working directories, from the snapshot Remote PCs already holds). Nothing runs on the machine.
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
    if (!machine) throw new AssistantError("unknown_machine", "That machine is not one of herdr's saved machines: run ovis-task machines", 404);
    if (this.isWindows(machine.id)) throw new AssistantError("windows", "Windows isn't supported by the Assistant yet");
    if (machine.state !== "connected" || !machine.snapshot) throw new AssistantError("machine_offline", "That machine is not connected", 503);
    return machine;
  }
  private paneOn(machine: Machine, paneId: unknown): HerdrPane {
    const pane = typeof paneId === "string" ? machine.snapshot?.panes.find((candidate) => candidate.pane_id === paneId) : undefined;
    if (!pane) throw new AssistantError("unknown_pane", "That pane is not open on that machine: run ovis-task sessions", 404);
    return pane;
  }
  private openedHere(machineId: string, paneId: string): boolean { return this.opened.some((item) => item.machine === machineId && item.pane === paneId); }

  /**
   * ovis-task sessions [machine]: every herdr workspace and pane on the connected machines (one
   * machine when named), from the snapshot Remote PCs holds: its agent, state, title and folder,
   * and `assistant: true` on a session `ovis-task open` started.
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
          ...(this.openedHere(machine.id, pane.pane_id) ? { assistant: true } : {}),
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
    await this.bridge(machine.id, "pane/input", { method: "POST", body: { pane_id: pane.pane_id, text: pastedBrief(message) } });
    await this.bridge(machine.id, "pane/keys", { method: "POST", body: { pane_id: pane.pane_id, keys: ["Enter"] } });
    return { ok: true, machine: machine.name, pane: pane.pane_id };
  }

  /**
   * ovis-task open <machine> <folder> [--agent] [--create] <brief>: a new workspace in the folder with
   * an agent started full auto (the bridge adds agent-launch.ts SKIP_PERMISSIONS), named from the
   * brief's first words, and the brief as its first message once the agent is up. Refused past the
   * machine's Max running sessions the Assistant opened that work at once. One open per machine at a time.
   */
  openSession(body: unknown): Promise<unknown> {
    const machine = this.machineNamed(isJsonObject(body) ? body.machine : undefined);
    const run = (this.opening.get(machine.id) ?? Promise.resolve()).catch(() => undefined).then(() => this.openNow(machine.id, body));
    const settled = run.catch(() => undefined);
    this.opening.set(machine.id, settled);
    void settled.then(() => { if (this.opening.get(machine.id) === settled) this.opening.delete(machine.id); });
    return run;
  }

  private async openNow(machineId: string, body: unknown): Promise<unknown> {
    if (!isJsonObject(body)) throw new AssistantError("invalid_body", "Expected machine, folder and brief");
    const machine = this.machineNamed(machineId);
    const folder = typeof body.folder === "string" ? body.folder.trim() : "";
    if (!folder || folder.length > 4096 || /[\0\r\n]/.test(folder) || !(folder.startsWith("/") || folder.startsWith("~/")) || folder.split("/").some((part) => part === ".." || part === ".")) throw refuseOpen("invalid_path");
    const agent = body.agent ?? "claude";
    if (!(ASSISTANT_AGENTS as readonly unknown[]).includes(agent)) throw new AssistantError("invalid_agent", "--agent is claude or codex");
    const brief = body.brief;
    if (typeof brief !== "string" || firstMessageFault(brief, true) !== null) throw new AssistantError("invalid_brief", `A brief is text of at most ${MAX_FIRST_MESSAGE_CHARS} characters, without terminal control characters`);
    // one opened in the last minute counts as working: its brief may not show as work in the snapshot yet
    const recent = this.now() - AGENT_UP_MS;
    const working = this.opened.filter((item) => item.machine === machine.id && (item.at > recent
      || machine.snapshot?.panes.some((pane) => pane.pane_id === item.pane && pane.agent_status === "working"))).length;
    const limit = this.maxRunning(machine.id);
    if (working >= limit) throw new AssistantError("limit_reached", `${working} sessions you opened are working on ${machine.name}, its limit of ${limit}: wait until one is idle or done`, 409);

    const printed = (await this.run(machine, openFolderScript(folder, body.create === true))).trim();
    const [first, real] = printed.split("\n");
    if (first?.startsWith("refused:")) throw refuseOpen(first.slice("refused:".length));
    if (first !== "ok" || !real) throw new Error(`unexpected answer from the machine: ${printed.slice(0, 200)}`);

    // focus: false (workspace-routes.ts), never --takeover
    const created = await this.bridge(machine.id, "workspace/create", { method: "POST", body: { cwd: real, label: briefLabel(brief), agent: { kind: agent } } }) as
      { workspace_id: string; pane_id: string; agent_started?: boolean; error?: { message?: string } };
    if (created.agent_started === false) throw new AssistantError("agent_not_started", `The workspace is open, but the agent did not start: ${created.error?.message ?? "no reason given"}`, 502);
    this.saveOpened([...this.opened, { machine: machine.id, pane: created.pane_id, at: this.now() }]);

    // the brief goes once herdr shows the agent up and at rest, as a pasted message and Enter: a
    // message the server wrote for the session it started, not user input held after a disconnect
    const deadline = Date.now() + AGENT_UP_MS;
    for (;;) {
      const pane = this.watchable().find((candidate) => candidate.id === machine.id)?.snapshot?.panes.find((candidate) => candidate.pane_id === created.pane_id);
      if (pane?.agent && (pane.agent_status === "idle" || pane.agent_status === "done")) break;
      if (Date.now() > deadline) throw new AssistantError("agent_not_ready", `The session is open (pane ${created.pane_id}), but its agent was not ready within a minute: send the brief with ovis-task send`, 504);
      await Bun.sleep(250);
    }
    await this.bridge(machine.id, "pane/input", { method: "POST", body: { pane_id: created.pane_id, text: pastedBrief(brief) } });
    await this.bridge(machine.id, "pane/keys", { method: "POST", body: { pane_id: created.pane_id, keys: ["Enter"] } });
    return { ok: true, machine: machine.name, pane: created.pane_id, workspace: created.workspace_id, folder: real, agent };
  }

  /** the sessions `open` started, less those whose machine's snapshot no longer has the pane */
  private saveOpened(opened: Opened[]): void {
    const kept = opened.filter((item) => {
      const machine = this.watchable().find((candidate) => candidate.id === item.machine);
      return !machine?.snapshot || machine.state !== "connected" || machine.snapshot.panes.some((pane) => pane.pane_id === item.pane) || item.at > this.now() - 5 * 60_000;
    });
    writePrivateState(this.openedPath, kept);
    this.opened = kept;
  }

  state(): AssistantState {
    const machines: AssistantMachine[] = this.watchable().map((machine) => ({
      id: machine.id, name: machine.name, state: machine.state,
      health: this.isWindows(machine.id) ? this.windowsHealth() : this.watched.get(machine.id)?.health ?? null,
      maxRunning: this.maxRunning(machine.id),
    }));
    return { machines, session: this.session?.info() ?? null };
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
      watch.failures = health.problems.includes("unreachable") ? watch.failures + 1 : 0;
      watch.cancel = this.timer(() => void this.check(id), nextCheckDelay(this.intervalMs, watch.failures));
    })().finally(() => { watch.busy = undefined; });
    return watch.busy;
  }

  private async inspect(machine: Machine): Promise<MachineHealth> {
    if (this.isWindows(machine.id)) return this.windowsHealth();
    try {
      return readHealth(await this.run(machine, healthScript(machine.target?.session)), this.now());
    } catch (error) {
      if (error instanceof MachineActionRequired && error.action === "connect") return { checked_at: this.now(), problems: ["not_connected"], agents: [] };
      return { checked_at: this.now(), problems: ["unreachable"], agents: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  setMachine(id: string, body: unknown): void {
    this.machine(id);
    if (!isJsonObject(body) || !validMaxRunning(body.maxRunning)) throw new AssistantError("invalid_max_running", "Max running is a whole number from 1 to 20");
    const settings = { ...this.settings, [id]: { maxRunning: body.maxRunning } };
    writePrivateState(this.settingsPath, settings);
    this.settings = settings;
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

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const watch of this.watched.values()) watch.cancel?.();
    this.watched.clear();
    this.session?.stop();
  }
}

/**
 * The Assistant-mode routes (/api/assistant/...), for this app's own pages only. Fixes and Restart
 * Assistant run only on a click. A write here must carry a browser page's Origin (index.ts already
 * refused one that is not this app's), so a client that sends none (the ovis-task CLI) is refused.
 */
export async function handleAssistantRequest(request: Request, pathname: string, assistant: Assistant): Promise<Response> {
  const parts = pathname.slice("/api/assistant".length).split("/").filter(Boolean);
  const [collection, id, action] = parts;
  const route = parts.length === 0 ? ""
    : collection === "restart" && parts.length === 1 ? "/restart"
    : collection === "machines" && id && (parts.length === 2 || (parts.length === 3 && action === "fix")) ? (action ? "/machines/:id/fix" : "/machines/:id") : null;
  if (route === null) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  setRequestRoute(`/api/assistant${route}`);
  const allowed: Record<string, string[]> = { "": ["GET"], "/restart": ["POST"], "/machines/:id": ["PATCH"], "/machines/:id/fix": ["POST"] };
  if (!allowed[route]!.includes(request.method)) return jsonResponse({ error: { code: "method_not_allowed", message: `use ${allowed[route]!.join(" or ")}` } }, 405, { allow: allowed[route]!.join(", ") });
  if (request.method !== "GET" && !request.headers.get("origin")) return jsonResponse({ error: { code: "browser_only", message: "Use Assistant controls from this app" } }, 403);
  const body = request.method === "GET" ? null : await request.json().catch(() => null);
  try {
    switch (`${request.method} ${route}`) {
      case "GET ": return jsonResponse(assistant.state());
      // Restart Assistant: only on the user's click, in this app; ovis-task has no such route
      case "POST /restart": {
        if (!assistant.session) throw new AssistantError("not_found", "This server runs no Assistant session", 404);
        await assistant.session.restart();
        return jsonResponse(assistant.state());
      }
      case "PATCH /machines/:id": assistant.setMachine(id!, body); return jsonResponse({ ok: true });
      default: await assistant.fix(id!, body); return jsonResponse(assistant.state());
    }
  } catch (error) {
    if (error instanceof AssistantError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    // what SSH said on the machine: a fix that could not run there
    return jsonResponse({ error: { code: "machine_unavailable", message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }, 502);
  }
}
