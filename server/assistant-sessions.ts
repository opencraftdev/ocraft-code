/**
 * The Assistant itself (docs/plan/20261112-1622-assistant-delegation.md): one long-lived Claude
 * Code or Codex agent in a herdr pane on the VM, started in stateDir/assistant/agent/, which holds
 * its instructions, its notes and its permission settings. The Assistant is not full auto: its
 * settings allow `ovis-task` and its own folder, and deny ssh, scp, herdr and curl.
 *
 * There is one session, forever (stateDir/assistant/session.json): no New chat, no archive. A
 * keep-alive checks it every minute, at this server's start and when the VM's herdr comes back:
 * a pane gone is opened again in the same folder and an agent that exited is started again in its
 * pane, both resuming the same conversation (`claude --continue`, `codex resume --last`); an agent
 * waiting on a prompt is left as it is. A compaction watchdog asks an idle agent whose context is
 * over 70% full to save lasting facts to notes.md, then sends `/compact`. Restart Assistant (the
 * user's only) starts a fresh conversation. herdr's focus is never moved and nothing takes over a pane.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_AGENTS, type AssistantAgent, type AssistantSessionInfo, type AssistantSessionState } from "../shared/assistant.ts";
import type { AgentStatus } from "../shared/protocol.ts";
import { freeAgentName } from "./agent-name.ts";
import type { Timer } from "./assistant.ts";
import { paneConversation } from "./conversation.ts";
import { agentPrompt, agentStart, HerdrError, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isJsonObject } from "./http.ts";
import { launchedAgents } from "./launched-agents.ts";
import { writePrivateState } from "./private-state.ts";
import { readStateDocument } from "./state-document.ts";
import { trustNewFolder } from "./trust-new-folder.ts";

/** where bin/ovis-task is: put first on the pane's PATH */
export const OVIS_TASK_BIN = join(import.meta.dir, "..", "bin");

export const INSTRUCTIONS = `# The Assistant

You are the Assistant: one long-lived coordinator for the herdr sessions on every machine in this
tailnet. The user messages you; you delegate their work to coding agents in those sessions, watch
them, and report back. You do not write code yourself.

## Start of every conversation, and after a compaction

1. Read \`notes.md\` in this folder.
2. Run \`ovis-task machines\` and \`ovis-task sessions\` to see what is open where.

## Rules

- The state lives in \`ovis-task\`, not in your memory. Ask it again rather than trust what you
  remember from earlier in this conversation.
- This conversation is long-lived and is compacted from time to time. Write lasting facts to
  \`notes.md\` as you learn them: the user's preferences, which folder on which machine holds which
  project, what you delegated where and why. It is the only file you edit.
- You reach machines only through \`ovis-task\`. Never try ssh, scp, herdr, curl or any other way to
  another machine: they are denied.
- Send or open only what the user asked for or agreed to. Say in your reply what you sent or opened,
  on which machine and pane, and check back with \`peek\`.
- A delegated agent sees nothing of this chat and has no \`ovis-task\`. Write each brief and message
  so it stands alone: the goal, the folder's context that matters, what done looks like. The agent
  does its own branching, commits and PRs; never tell it to call \`ovis-task\` or to report back.
- Asked what is on a machine, run \`ovis-task machines\`: it shows the folders its herdr workspaces
  have open.

## ovis-task

- \`ovis-task machines\`: the machines, whether each is connected, its agent CLIs, and the folders
  its herdr workspaces have open
- \`ovis-task sessions [machine]\`: every herdr workspace and pane on the machines: its pane id,
  agent, state (working, idle, done, blocked), title and folder; \`assistant: true\` marks a session
  you opened
- \`ovis-task peek <machine> <pane>\`: an agent's last turns, or a shell's last screen lines
- \`ovis-task send <machine> <pane> <message>\`: sends the message to that pane's agent, as if the
  user typed it. Refused for a shell and for a working agent: wait until it is idle or done
- \`ovis-task open <machine> <folder> [--agent claude|codex] [--create] <brief>\`: opens a new
  session in that folder (absolute, or \`~/...\`; under the machine's home, not home itself) with an
  agent running full auto, and sends the brief as its first message. \`--create\` makes the folder
  and runs \`git init\` there when it is not a repository yet. At most a few sessions you opened
  work at once on one machine (its Max running setting); past that it is refused until one is idle.
`;


/**
 * Claude Code's project settings. `dontAsk` refuses every tool the allow list does not name, so
 * nothing outside it runs, asked or not; the deny list says the important refusals out loud and
 * wins over any allow rule the user's own settings add.
 */
export const CLAUDE_SETTINGS = {
  permissions: {
    defaultMode: "dontAsk",
    allow: ["Bash(ovis-task:*)", "Bash(ovis-task)", "Read(./**)", "Edit(./notes.md)"],
    deny: [
      "Bash(ssh:*)", "Bash(scp:*)", "Bash(sftp:*)", "Bash(rsync:*)", "Bash(herdr:*)", "Bash(curl:*)", "Bash(wget:*)",
      // its own instructions and settings stay as this server writes them
      "Edit(./.claude/**)", "Edit(./.codex/**)", "Edit(./AGENTS.md)", "Edit(./CLAUDE.md)",
      "WebFetch",
    ],
  },
};

/**
 * Codex's nearest equivalent: the sandbox keeps writes inside this folder (its `.codex/` stays read
 * only there), and the rules allow ovis-task and forbid ssh, scp, herdr, curl and the like. Codex
 * runs with CODEX_HOME at this folder's `.codex/`, so the rules and config load as its user layer:
 * a project's own `.codex/` loads only once the user trusted that folder (the plan's open
 * questions). `on-request`: Codex 0.165 no longer takes `untrusted`. The network stays open to the
 * sandbox because ovis-task reaches this server on loopback. Codex has no read limit to one folder.
 */
export const CODEX_ARGS = ["--ask-for-approval", "on-request", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
export const CODEX_CONFIG = `approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
`;
export const CODEX_RULES = `prefix_rule(pattern=["ovis-task"], decision="allow")
prefix_rule(pattern=[["ssh", "scp", "sftp", "rsync", "herdr", "curl", "wget"]], decision="forbidden")
`;

/** the user's own Codex sign-in, where their Codex keeps it */
export const userCodexAuth = (): string => join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "auth.json");

/**
 * Writes the Assistant's folder. Its instructions and settings are rewritten each start; notes.md is the Assistant's own.
 * `codexAuth`: the sign-in the Assistant's Codex shares, linked as its CODEX_HOME's auth.json. Codex writes a
 * refreshed token through that link, so a rotated token does not sign the user's own Codex out.
 */
export function writeAgentFolder(folder: string, codexAuth?: string): void {
  mkdirSync(join(folder, ".claude"), { recursive: true, mode: 0o700 });
  mkdirSync(join(folder, ".codex", "rules"), { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "AGENTS.md"), INSTRUCTIONS);
  writeFileSync(join(folder, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n");
  writeFileSync(join(folder, ".codex", "config.toml"), CODEX_CONFIG);
  writeFileSync(join(folder, ".codex", "rules", "ovis-task.rules"), CODEX_RULES);
  const auth = join(folder, ".codex", "auth.json");
  if (codexAuth !== undefined && !lstatSync(auth, { throwIfNoEntry: false })) {
    try { symlinkSync(codexAuth, auth); } catch (error) { console.error(`The Assistant's Codex cannot share your Codex sign-in: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!existsSync(join(folder, "notes.md"))) writeFileSync(join(folder, "notes.md"), "# Notes\n\nLasting facts about the user and their projects.\n");
}


/** the keep-alive's interval */
export const KEEP_ALIVE_MS = 60_000;
/** the share of the context window past which an idle Assistant is compacted */
export const COMPACT_AT = 0.7;
/** ponytail: a fixed pause between compactions, so a usage figure not yet updated after /compact cannot fire another; read the post-compact usage if it ever matters */
export const COMPACT_COOLDOWN_MS = 30 * 60_000;
/** the notes request before /compact: how long an agent that was never seen working is waited for */
const NOTES_WAIT_MS = 2 * KEEP_ALIVE_MS;
export const NOTES_REQUEST = "Your context is nearly full and will be compacted next. First write to notes.md every lasting fact from this conversation that is not there yet: the user's preferences, open delegations (machine, pane, what was asked), and what each session is doing. Reply with one line when done.";
/** what the agent is told to keep through a compaction (Claude Code's /compact takes it; Codex's takes none) */
export const compactCommand = (agent: AssistantAgent): string =>
  agent === "claude" ? "/compact keep: open delegations, user preferences, what each session is doing" : "/compact";

/** The agent's arguments: its permission settings, and with `resume` the conversation it had in this folder. */
export function agentArgs(agent: AssistantAgent, resume: boolean): string[] {
  if (agent === "codex") return resume ? ["resume", "--last", ...CODEX_ARGS] : [...CODEX_ARGS];
  return resume ? ["--continue"] : [];
}

/** What the session asks of the VM's herdr; tests pass their own. */
export interface AssistantPanes {
  /** a new workspace in `cwd` with the agent started in its pane */
  open(options: { cwd: string; label: string; env: Record<string, string>; agent: AssistantAgent; args: string[] }): Promise<{ paneId: string; workspaceId: string }>;
  /** starts the agent again in a pane whose agent exited (its shell keeps the workspace's environment) */
  start(paneId: string, agent: AssistantAgent, args: string[]): Promise<void>;
  /** the pane as herdr has it now: null when it is gone; rejects when herdr cannot be asked */
  pane(paneId: string): Promise<{ agent: string | null; status: AgentStatus | null } | null>;
  /** how much of its context the agent's last request filled; null when its transcript does not say */
  context(paneId: string, codexHome?: string): Promise<{ used: number; window: number | null } | null>;
  /** types a message into the agent and sends it (herdr's agent.prompt, refused while it waits on a prompt) */
  send(paneId: string, text: string): Promise<void>;
  close(workspaceId: string): Promise<void>;
}

async function startAgent(paneId: string, agent: AssistantAgent, args: string[]): Promise<void> {
  // a pane made a moment ago can still be starting its shell (agent_pane_busy), as agent-launch.ts waits for
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const name = freeAgentName("assistant", (await sessionSnapshot()).agents.map((running) => running.name));
      await agentStart({ name, kind: agent, paneId, args, timeoutMs: 60_000 });
      break;
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy" || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
  launchedAgents.launched(paneId, agent);
  if (agent === "claude") void trustNewFolder(paneId).catch(() => undefined);
}

export const herdrPanes: AssistantPanes = {
  async open({ cwd, label, env, agent, args }) {
    // focus: false (workspaceCreate), so herdr's own focus stays where it is
    const created = await workspaceCreate({ cwd, label, env });
    try { await startAgent(created.root_pane.pane_id, agent, args); } catch (error) {
      await workspaceClose(created.tab.workspace_id).catch(() => undefined);
      throw error;
    }
    return { paneId: created.root_pane.pane_id, workspaceId: created.tab.workspace_id };
  },
  start: startAgent,
  async pane(paneId) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    return pane ? { agent: pane.agent ?? null, status: pane.agent_status ?? null } : null;
  },
  context: (paneId, codexHome) => paneConversation(paneId, codexHome).then((read) => read.metadata?.context ?? null),
  send: (paneId, text) => agentPrompt(paneId, text),
  close: (workspaceId) => workspaceClose(workspaceId),
};

interface Stored { agent: AssistantAgent; started_at: number; pane_id: string | null; workspace_id: string | null; last_compaction: number | null }
const validStored = (value: unknown): value is Stored => isJsonObject(value) && (ASSISTANT_AGENTS as readonly unknown[]).includes(value.agent)
  && typeof value.started_at === "number" && (value.pane_id === null || typeof value.pane_id === "string")
  && (value.workspace_id === null || typeof value.workspace_id === "string") && (value.last_compaction === null || typeof value.last_compaction === "number");
const AT_REST: readonly (AgentStatus | null)[] = ["idle", "done"];
const defaultTimer: Timer = (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); };

export class AssistantSession {
  private path: string;
  readonly folder: string;
  private stored: Stored | null;
  private state: AssistantSessionState = "restarting";
  private queue: Promise<void> = Promise.resolve();
  private checking: Promise<void> | null = null;
  private cancel: (() => void) | undefined;
  private stopped = false;
  /** the last start of the agent the keep-alive made: a resume whose agent is gone again at the next check starts fresh */
  private launched: "resume" | "fresh" | null = null;
  /** a notes request sent, waiting for the agent to work on it and come to rest */
  private compaction: { notesAt: number; worked: boolean } | null = null;
  private now: () => number;
  private timer: Timer;

  constructor(stateDir: string, private agent: AssistantAgent, private env: () => Record<string, string>, private panes: AssistantPanes = herdrPanes, options: { now?: () => number; timer?: Timer } = {}) {
    this.path = join(stateDir, "assistant", "session.json");
    this.folder = join(stateDir, "assistant", "agent");
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? defaultTimer;
    const read = readStateDocument(this.path);
    this.stored = read.kind === "json" && validStored(read.value) ? read.value : earlierSession(join(stateDir, "assistant", "sessions"));
  }

  info(): AssistantSessionInfo | null {
    const stored = this.stored;
    return stored && { agent: stored.agent, pane_id: stored.pane_id, started_at: stored.started_at, last_compaction: stored.last_compaction, state: this.state };
  }

  /** the keep-alive: a check now, then one every KEEP_ALIVE_MS until stop() */
  start(): void {
    if (this.stopped) return;
    this.cancel?.();
    void this.check().finally(() => { if (!this.stopped) this.cancel = this.timer(() => this.start(), KEEP_ALIVE_MS); });
  }

  stop(): void { this.stopped = true; this.cancel?.(); }

  private save(stored: Stored): void { writePrivateState(this.path, stored); this.stored = stored; }

  /** one at a time, after a restart in progress; a check asked for while one waits or runs is that one */
  check(): Promise<void> {
    this.checking ??= this.queue = this.queue.then(() => this.checkNow()).catch((error: unknown) => {
      console.error(`Assistant keep-alive: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.checking = null; });
    return this.checking;
  }

  /** Restart Assistant, only on the user's click: the pane closed and a fresh conversation opened. */
  restart(): Promise<void> {
    const run = this.queue.then(() => this.restartNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async restartNow(): Promise<void> {
    const old = this.stored;
    this.state = "restarting";
    this.compaction = null;
    this.launched = null;
    if (old?.workspace_id) await this.panes.close(old.workspace_id).catch(() => undefined);
    await this.openPane(false, this.now());
    this.state = "running";
  }

  private async openPane(resume: boolean, startedAt: number): Promise<void> {
    const codex = this.agent === "codex";
    writeAgentFolder(this.folder, codex ? userCodexAuth() : undefined);
    const { paneId, workspaceId } = await this.panes.open({
      cwd: this.folder, label: "Assistant", agent: this.agent, args: agentArgs(this.agent, resume),
      env: { ...this.env(), ...(codex ? { CODEX_HOME: join(this.folder, ".codex") } : {}) },
    });
    this.save({ agent: this.agent, started_at: startedAt, pane_id: paneId, workspace_id: workspaceId, last_compaction: resume ? this.stored?.last_compaction ?? null : null });
  }

  private async checkNow(): Promise<void> {
    const stored = this.stored;
    if (stored === null || stored.pane_id === null) {
      // the first session ever: a fresh conversation
      this.state = "restarting";
      await this.openPane(false, this.now());
      this.state = "running";
      return;
    }
    // herdr that cannot be asked: left as it is until it answers
    const pane = await this.panes.pane(stored.pane_id);
    const resume = this.launched !== "resume";
    if (pane === null) {
      this.state = "restarting";
      this.compaction = null;
      // a workspace herdr restored without the pane goes, so the session keeps one
      if (stored.workspace_id !== null) await this.panes.close(stored.workspace_id).catch(() => undefined);
      this.launched = resume ? "resume" : "fresh";
      await this.openPane(resume, resume ? stored.started_at : this.now());
      // started: the next check says whether it stayed up
      this.state = "running";
      return;
    }
    if (!pane.agent) {
      // the agent exited to the pane's shell
      this.state = "restarting";
      this.compaction = null;
      this.launched = resume ? "resume" : "fresh";
      await this.panes.start(stored.pane_id, this.agent, agentArgs(this.agent, resume));
      if (!resume) this.save({ ...stored, started_at: this.now(), last_compaction: null });
      this.state = "running";
      return;
    }
    this.launched = null;
    if (pane.status === "blocked") { this.state = "prompt"; return; }
    this.state = "running";
    await this.watchContext(stored.pane_id, pane.status);
  }

  /** a pane's agent state as herdr reports it between checks: a notes request worked on and done goes on to /compact */
  heard(paneId: string, status: AgentStatus): void {
    if (paneId !== this.stored?.pane_id || !this.compaction) return;
    if (status === "working") this.compaction.worked = true;
    else if (AT_REST.includes(status) && this.compaction.worked) void this.check();
  }

  /** The compaction watchdog: never while the agent works; the notes request first, /compact once it is at rest again. */
  private async watchContext(paneId: string, status: AgentStatus | null): Promise<void> {
    if (status === "working") { if (this.compaction) this.compaction.worked = true; return; }
    if (!AT_REST.includes(status)) return;
    const now = this.now();
    if (this.compaction) {
      if (!this.compaction.worked && now - this.compaction.notesAt < NOTES_WAIT_MS) return;
      this.compaction = null;
      await this.panes.send(paneId, compactCommand(this.agent));
      this.save({ ...this.stored!, last_compaction: now });
      return;
    }
    const last = this.stored?.last_compaction;
    if (last != null && now - last < COMPACT_COOLDOWN_MS) return;
    const context = await this.panes.context(paneId, this.agent === "codex" ? join(this.folder, ".codex") : undefined).catch(() => null);
    if (!context?.window || context.used / context.window <= COMPACT_AT) return;
    await this.panes.send(paneId, NOTES_REQUEST);
    this.compaction = { notesAt: now, worked: false };
  }
}

/**
 * The session an earlier build kept as stateDir/assistant/sessions/<YYYYMMDD-HHMM>/session.json:
 * its current one (not archived) is taken over, so its pane and conversation carry on.
 */
function earlierSession(directory: string): Stored | null {
  if (!existsSync(directory)) return null;
  for (const name of readdirSync(directory).sort().reverse()) {
    const read = readStateDocument(join(directory, name, "session.json"));
    if (read.kind !== "json" || !isJsonObject(read.value) || read.value.archived_at !== undefined) continue;
    const { agent, started_at, pane_id, workspace_id } = read.value;
    const stored = { agent, started_at, pane_id: pane_id ?? null, workspace_id: workspace_id ?? null, last_compaction: null };
    if (validStored(stored)) return stored;
  }
  return null;
}
