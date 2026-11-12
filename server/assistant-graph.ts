/**
 * The session graph (docs/plan/20261112-1900-assistant-graph-and-profile.md, Decision 2): the agent
 * sessions open now on the Assistant's connected, non-Windows machines, with each one's repo,
 * branch, remote, PRs and files, written to stateDir/assistant/agent/graph.json for the Assistant
 * to read (its settings deny editing it) and printed by `ovis-task graph`.
 *
 * Cheap fields (open, closed, state, title) come from the machines' snapshots and are written at
 * most 3 s after a change. The detailed reads go through each machine's bridge (workspace/diff/files,
 * pane/prs, pane/conversation) and `git remote get-url origin` once per repo root: for a pane when
 * it opens, when its agent comes to rest after working, and every 5 min; one read at a time. A read
 * that fails keeps the pane's last values. Nothing is sent to any session.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { GraphSession, SessionGraph } from "../shared/assistant.ts";
import { LOCAL_MACHINE, sshHost, type Machine } from "../shared/machines.ts";
import { patchFiles, patchText } from "../shared/patch.ts";
import type { AgentStatus, ConversationResponse, HerdrPane, PanePullRequests } from "../shared/protocol.ts";
import type { RepoDiffFileList } from "../shared/repo-diff.ts";
import type { MachineBridge, RunScript, Timer } from "./assistant.ts";
import { isJsonObject } from "./http.ts";
import { shellQuote } from "./machine-security.ts";

export const GRAPH_WRITE_DELAY_MS = 3_000;
export const GRAPH_SWEEP_MS = 5 * 60_000;
const FILE_CAP = 50;
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch"]);
const AT_REST: readonly (AgentStatus | null | undefined)[] = ["idle", "done"];

/** the paths one tool call edits: a patch's files, or an edit tool's file_path/path/notebook_path; reads name none */
function editedPaths(name: string, input: string): string[] {
  const patch = patchText(input);
  if (patch !== null) return patchFiles(patch);
  if (!EDIT_TOOLS.has(name.toLowerCase())) return [];
  try {
    const value: unknown = JSON.parse(input);
    if (!isJsonObject(value)) return [];
    const path = value.file_path ?? value.path ?? value.notebook_path;
    return typeof path === "string" && path !== "" ? [path] : [];
  } catch { return []; }
}

/** the files a conversation's edits touched, newest first, at most 50 */
export function touchedFiles(conversation: ConversationResponse): string[] {
  const touched: string[] = [];
  for (const turn of [...conversation.turns].reverse()) {
    for (const part of [...turn.parts].reverse()) {
      if (part.kind !== "tool") continue;
      for (const path of editedPaths(part.name, part.input).reverse()) {
        if (!touched.includes(path)) touched.push(path);
        if (touched.length >= FILE_CAP) return touched;
      }
    }
  }
  return touched;
}

/** what the detailed reads found for a pane */
interface Detail {
  repo_root: string | null; branch: string | null; head: string | null; remote: string | null;
  prs: GraphSession["prs"]; changed: string[]; touched: string[]; seen_at: number | null;
}
const noDetail = (): Detail => ({ repo_root: null, branch: null, head: null, remote: null, prs: [], changed: [], touched: [], seen_at: null });

export interface GraphSources {
  /** the Assistant's machines (herdr's saved ones) */
  machines(): Machine[];
  windows(id: string): boolean;
  /** the Assistant's own pane on this VM, left out */
  ownPane(): string | null;
  /** a session `ovis-task open` started */
  opened(machineId: string, paneId: string): boolean;
  bridge: MachineBridge;
  run: RunScript;
  now?: () => number;
  timer?: Timer;
}

const defaultTimer: Timer = (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); };
const id = (machineId: string, paneId: string) => `${machineId}\0${paneId}`;

export class AssistantGraph {
  private details = new Map<string, Detail>();
  /** `git remote get-url origin` per machine and repo root: null when it has none */
  private remotes = new Map<string, string | null>();
  /** each active pane's agent state as last seen, to tell a pane opened and an agent come to rest */
  private statuses = new Map<string, AgentStatus | null>();
  private pending = new Set<string>();
  private reading: Promise<void> = Promise.resolve();
  private cancelWrite: (() => void) | undefined;
  private cancelSweep: (() => void) | undefined;
  private stopped = false;
  private now: () => number;
  private timer: Timer;

  constructor(readonly path: string, private sources: GraphSources) {
    this.now = sources.now ?? Date.now;
    this.timer = sources.timer ?? defaultTimer;
  }

  /** the panes the graph lists: agent panes on connected, non-Windows machines, the Assistant's own left out */
  private active(): { machine: Machine; pane: HerdrPane }[] {
    const own = this.sources.ownPane();
    return this.sources.machines().filter((machine) => machine.state === "connected" && machine.snapshot && !this.sources.windows(machine.id))
      .flatMap((machine) => (machine.snapshot?.panes ?? []).filter((pane) => pane.agent && !(machine.id === LOCAL_MACHINE && pane.pane_id === own))
        .map((pane) => ({ machine, pane })));
  }

  /** the sweep: every pane read again each GRAPH_SWEEP_MS, until stop() */
  start(): void {
    if (this.stopped) return;
    this.changed();
    this.cancelSweep = this.timer(() => { this.sweep(); this.start(); }, GRAPH_SWEEP_MS);
  }

  stop(): void { this.stopped = true; this.cancelWrite?.(); this.cancelSweep?.(); }

  /** the machines changed: the file is written soon; a pane new to the graph, or whose agent came to rest, is read */
  changed(): void {
    if (this.stopped) return;
    const seen = new Set<string>();
    for (const { machine, pane } of this.active()) {
      const key = id(machine.id, pane.pane_id);
      seen.add(key);
      if (!this.statuses.has(key) || (this.statuses.get(key) === "working" && AT_REST.includes(pane.agent_status))) this.read(machine.id, pane.pane_id);
      this.statuses.set(key, pane.agent_status ?? null);
    }
    // a pane closed, or on a machine gone, is read again as new when it is back
    for (const key of this.statuses.keys()) if (!seen.has(key)) { this.statuses.delete(key); this.details.delete(key); }
    this.scheduleWrite();
  }

  /** a pane's agent state as its machine reported it between snapshots */
  heard(machineId: string, paneId: string, status: AgentStatus): void {
    const key = id(machineId, paneId);
    if (!this.statuses.has(key)) return;
    if (this.statuses.get(key) === "working" && AT_REST.includes(status)) this.read(machineId, paneId);
    this.statuses.set(key, status);
  }

  sweep(): void { for (const { machine, pane } of this.active()) this.read(machine.id, pane.pane_id); }

  /** resolves once the reads queued so far are done (tests) */
  settled(): Promise<void> { return this.reading; }

  private read(machineId: string, paneId: string): void {
    const key = id(machineId, paneId);
    if (this.stopped || this.pending.has(key)) return;
    this.pending.add(key);
    this.reading = this.reading.then(async () => {
      this.pending.delete(key);
      const found = this.active().find(({ machine, pane }) => machine.id === machineId && pane.pane_id === paneId);
      if (this.stopped || !found) return;
      await this.readPane(found.machine, paneId).catch(() => undefined);
      this.scheduleWrite();
    });
  }

  private async readPane(machine: Machine, paneId: string): Promise<void> {
    const key = id(machine.id, paneId);
    const detail = { ...(this.details.get(key) ?? noDetail()) };
    const query = { pane_id: paneId };
    let read = false;
    const diff = await this.sources.bridge(machine.id, "workspace/diff/files", { query }).catch(() => null) as RepoDiffFileList | null;
    if (diff?.repository && Array.isArray(diff.files)) {
      read = true;
      detail.repo_root = diff.repository.root;
      detail.branch = diff.repository.branch;
      detail.head = diff.repository.head;
      detail.changed = diff.files.slice(0, FILE_CAP).map((file) => file.path);
    }
    const prs = await this.sources.bridge(machine.id, "pane/prs", { query }).catch(() => null) as PanePullRequests | null;
    if (Array.isArray(prs?.prs)) {
      read = true;
      detail.prs = prs.prs.map(({ number, url, title, state }) => ({ number, url, title, state }));
    }
    const conversation = await this.sources.bridge(machine.id, "pane/conversation", { query }).catch(() => null) as ConversationResponse | null;
    if (Array.isArray(conversation?.turns)) {
      read = true;
      detail.touched = touchedFiles(conversation);
    }
    if (detail.repo_root !== null) detail.remote = await this.remote(machine, detail.repo_root, detail.remote);
    if (read) detail.seen_at = this.now();
    // a pane closed while it was read stays out
    if (this.statuses.has(key)) this.details.set(key, detail);
  }

  private async remote(machine: Machine, root: string, last: string | null): Promise<string | null> {
    const key = id(machine.id, root);
    if (this.remotes.has(key)) return this.remotes.get(key)!;
    try {
      const output = (await this.sources.run(machine, `git -C ${shellQuote(root)} remote get-url origin 2>/dev/null || true`)).trim();
      const remote = output === "" ? null : output.split("\n")[0]!;
      this.remotes.set(key, remote);
      return remote;
    } catch { return last; }
  }

  /** the graph as it is now; one machine's part when `machineId` is given */
  build(machineId?: string): SessionGraph {
    const machines = this.sources.machines().filter((machine) => machineId === undefined || machine.id === machineId);
    const sessions: GraphSession[] = this.active().filter(({ machine }) => machineId === undefined || machine.id === machineId).map(({ machine, pane }) => {
      const detail = this.details.get(id(machine.id, pane.pane_id)) ?? noDetail();
      const workspace = machine.snapshot?.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id);
      return {
        key: `${machine.name}/${pane.pane_id}`, machine: machine.name, host: machine.target?.destination ? sshHost(machine.target.destination) : null,
        workspace: workspace?.label ?? pane.workspace_id, pane: pane.pane_id, agent: pane.agent!, state: pane.agent_status ?? null,
        title: pane.terminal_title_stripped ?? pane.terminal_title ?? null, folder: pane.cwd ?? null,
        repo_root: detail.repo_root, branch: detail.branch, head: detail.head, remote: detail.remote, prs: detail.prs,
        files: { changed: detail.changed, touched: detail.touched },
        assistant_opened: this.sources.opened(machine.id, pane.pane_id), seen_at: detail.seen_at,
      };
    });
    const projects = new Map<string, SessionGraph["projects"][number]>();
    for (const session of sessions) {
      if (session.repo_root === null) continue;
      const group = session.remote ?? `${session.machine}:${session.repo_root}`;
      const project = projects.get(group) ?? { repo: basename(session.remote ?? session.repo_root).replace(/\.git$/, ""), remote: session.remote, roots: {}, sessions: [] };
      // ponytail: one root per machine (the first); two worktrees of a repo on one machine show their own root on each session
      project.roots[session.machine] ??= session.repo_root;
      project.sessions.push(session.key);
      projects.set(group, project);
    }
    return {
      updated_at: this.now(),
      machines: machines.map((machine) => ({ name: machine.name, id: machine.id, host: machine.target?.destination ? sshHost(machine.target.destination) : null, state: machine.state })),
      projects: [...projects.values()],
      sessions,
    };
  }

  private scheduleWrite(): void {
    if (this.stopped || this.cancelWrite) return;
    this.cancelWrite = this.timer(() => { this.cancelWrite = undefined; this.write(); }, GRAPH_WRITE_DELAY_MS);
  }

  /** graph.json replaced atomically: a reader sees the old file or the new one, never half of one */
  write(): void {
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(this.build(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* never written */ }
      console.error(`Assistant graph: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
