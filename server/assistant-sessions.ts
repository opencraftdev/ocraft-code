/**
 * The Assistant itself (docs/plan/20261112-1622-assistant-delegation.md): one long-lived Claude
 * Code or Codex agent in a herdr pane on the VM, started in stateDir/assistant/agent/, which holds
 * its instructions, its profile (profiles/<session>/, docs/plan/20261112-1900-assistant-graph-and-profile.md),
 * the session graph the server keeps (graph.json, server/assistant-graph.ts) and its permission settings. The Assistant is not full auto: its
 * settings allow `ovis-task` and its own folder, and deny ssh, scp, herdr and curl.
 *
 * There is one session, forever (stateDir/assistant/session.json): no New chat, no archive. A
 * keep-alive checks it every minute, at this server's start and when the VM's herdr comes back:
 * a pane gone is opened again in the same folder and an agent that exited is started again in its
 * pane, both resuming the same conversation (`claude --continue`, `codex resume --last`); an agent
 * waiting on a prompt is left as it is. A compaction watchdog asks an idle agent whose context is
 * over 70% full to save lasting facts to its profile, then sends `/compact`. Restart Assistant (the
 * user's only) starts a fresh conversation. herdr's focus is never moved and nothing takes over a pane.
 */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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

/** the long-lived session's profile: stateDir/assistant/agent/profiles/assistant/ */
export const DEFAULT_PROFILE = "assistant";

/** The Assistant's instructions (AGENTS.md); `profile` names its folder under profiles/. */
export const instructions = (profile: string): string => `# The Assistant

You are the Assistant: one long-lived coordinator for the herdr sessions on every machine in this
tailnet. The user messages you; you delegate their work to coding agents in those sessions, watch
them, and report back. You do not write code yourself.

## Start of every conversation, and after a compaction

1. Read your profile in \`profiles/${profile}/\`: \`SOUL.md\`, \`PROFILE.md\`, the names of the files in
   \`projects/\` (open the ones this message touches), and today's and yesterday's
   \`logs/YYYY-MM-DD.md\`.
2. Run \`ovis-task graph\`, \`ovis-task machines\` and \`ovis-task sessions\` to see what is open where.

## Your profile: profiles/${profile}/

- \`SOUL.md\`: who you are and how you work. You may refine it.
- \`PROFILE.md\`: the user, their preferences, their machines and what each one holds.
- \`projects/<project>.md\`: one per project: its folder on each machine, repo and remote, people,
  open work, history.
- \`logs/YYYY-MM-DD.md\`: the day's log, append only. Append to today's as you work: every send and
  open (machine, pane, folder, what was asked) and every outcome you see.
- Before a compaction, and in the first turn of a new day, distill the lasting facts from the logs
  into \`PROFILE.md\` and \`projects/\`. Keep PROFILE.md and each project file short: rewrite them
  rather than append. Never delete a log.
- These are the only files you edit.

## Rules

- The state lives in \`ovis-task\`, not in your memory. Ask it again rather than trust what you
  remember from earlier in this conversation.
- This conversation is long-lived and is compacted from time to time: what is not in your profile
  is lost then.
- You reach machines only through \`ovis-task\`. Never try ssh, scp, herdr, curl or any other way to
  another machine: they are denied.
- Send or open only what the user asked for or agreed to. Say in your reply what you sent or opened,
  on which machine and pane, and check back with \`peek\`.
- A delegated agent sees nothing of this chat and has no \`ovis-task\`. Write each brief and message
  so it stands alone: the goal, the folder's context that matters, what done looks like. The agent
  does its own branching, commits and PRs; never tell it to call \`ovis-task\` or to report back.
- Asked what is on a machine, run \`ovis-task machines\`: it shows the folders its herdr workspaces
  have open.
- A message may tag sessions as \`@session(machine="…" host="…" pane="…" folder="…" agent="…" title="…")\`:
  that is an exact session, the user picked it. Use its \`host\` (or \`machine\`) and \`pane\` with
  \`peek\` and \`send\` as they are; do not look it up again. Act on the tagged sessions only as the
  message asks. A tag followed by \`(closed)\` names a session that is no longer open.

## The session graph: graph.json

\`graph.json\` in this folder (read only: the server rewrites it) lists every active agent session
on the connected machines: its machine, workspace, pane, agent, state, title and folder, its repo
root, branch, head and remote, its PRs, and its files (\`changed\`: uncommitted; \`touched\`: the
files its agent edited lately). \`projects\` groups the sessions by remote (or by repo root), with
the folder on each machine. Use it to go from a file to its session and project.
\`ovis-task graph\` prints it as it is now.

## ovis-task

- \`ovis-task graph [machine]\`: the session graph above, or one machine's part of it
- \`ovis-task machines\`: the machines, whether each is connected, its agent CLIs, and the folders
  its herdr workspaces have open
- \`ovis-task sessions [machine]\`: every herdr workspace and pane on the machines: its pane id,
  agent, state (working, idle, done, blocked), title and folder; \`assistant: true\` marks a session
  you opened. Wherever a command takes \`<machine>\`, the machine's name, its id or its SSH host
  (with or without the tailnet suffix) all work
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
 * wins over any allow rule the user's own settings add. It edits its own profile only.
 */
export const claudeSettings = (profile: string) => ({
  permissions: {
    defaultMode: "dontAsk",
    allow: ["Bash(ovis-task:*)", "Bash(ovis-task)", "Read(./**)", /* Edit rules cover Write too; Claude Code warns on a Write(path) rule */ `Edit(./profiles/${profile}/**)`],
    deny: [
      "Bash(ssh:*)", "Bash(scp:*)", "Bash(sftp:*)", "Bash(rsync:*)", "Bash(herdr:*)", "Bash(curl:*)", "Bash(wget:*)",
      // its own instructions and settings stay as this server writes them; the graph is the server's
      "Edit(./.claude/**)", "Edit(./.codex/**)", "Edit(./AGENTS.md)", "Edit(./CLAUDE.md)", "Edit(./graph.json)",
      "WebFetch",
    ],
  },
});

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

const SOUL = `# Soul

I am the Assistant: one long-lived coordinator for the user's herdr sessions on every machine. I
delegate their work to coding agents, watch it, and report back plainly. I do not write code myself.
I keep this profile so that nothing lasting is lost when my conversation is compacted.
`;
const PROFILE = "# Profile\n\nThe user, their preferences, their machines and what each one holds.\n";

/** a day as the profile's logs name it, in this server's time zone */
export const logDay = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** the notes.md an earlier build kept, as the profile's logs hold it since its migration; null when there is none */
export function notesImport(folder: string, profile: string): string | null {
  const logs = join(folder, "profiles", profile, "logs");
  return existsSync(logs) ? readdirSync(logs).find((name) => name.endsWith("-notes-import.md")) ?? null : null;
}

/**
 * Writes the Assistant's folder. Its instructions and settings are rewritten each start; its profile
 * (profiles/<profile>/) is the Assistant's own: only missing files are seeded. A notes.md of an
 * earlier build moves, byte for byte, to the profile's logs/<today>-notes-import.md once, and is
 * kept beside as notes.md.migrated.
 * `codexAuth`: the sign-in the Assistant's Codex shares, linked as its CODEX_HOME's auth.json. Codex writes a
 * refreshed token through that link, so a rotated token does not sign the user's own Codex out.
 */
export function writeAgentFolder(folder: string, codexAuth?: string, profile = DEFAULT_PROFILE, now = Date.now()): void {
  mkdirSync(join(folder, ".claude"), { recursive: true, mode: 0o700 });
  mkdirSync(join(folder, ".codex", "rules"), { recursive: true, mode: 0o700 });
  const own = join(folder, "profiles", profile);
  for (const directory of ["projects", "logs"]) mkdirSync(join(own, directory), { recursive: true, mode: 0o700 });
  for (const [name, text] of [["SOUL.md", SOUL], ["PROFILE.md", PROFILE]] as const) {
    if (!existsSync(join(own, name))) writeFileSync(join(own, name), text);
  }
  const notes = join(folder, "notes.md");
  if (existsSync(notes) && notesImport(folder, profile) === null) {
    copyFileSync(notes, join(own, "logs", `${logDay(now)}-notes-import.md`), constants.COPYFILE_EXCL);
    renameSync(notes, `${notes}.migrated`);
  }
  writeFileSync(join(folder, "AGENTS.md"), instructions(profile));
  writeFileSync(join(folder, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify(claudeSettings(profile), null, 2) + "\n");
  writeFileSync(join(folder, ".codex", "config.toml"), CODEX_CONFIG);
  writeFileSync(join(folder, ".codex", "rules", "ovis-task.rules"), CODEX_RULES);
  const auth = join(folder, ".codex", "auth.json");
  if (codexAuth !== undefined && !lstatSync(auth, { throwIfNoEntry: false })) {
    try { symlinkSync(codexAuth, auth); } catch (error) { console.error(`The Assistant's Codex cannot share your Codex sign-in: ${error instanceof Error ? error.message : String(error)}`); }
  }
}


/** the keep-alive's interval */
export const KEEP_ALIVE_MS = 60_000;
/** the share of the context window past which an idle Assistant is compacted */
export const COMPACT_AT = 0.7;
/** ponytail: a fixed pause between compactions, so a usage figure not yet updated after /compact cannot fire another; read the post-compact usage if it ever matters */
export const COMPACT_COOLDOWN_MS = 30 * 60_000;
/** the notes request before /compact: how long an agent that was never seen working is waited for */
const NOTES_WAIT_MS = 2 * KEEP_ALIVE_MS;
export const notesRequest = (profile: string): string => `Your context is nearly full and will be compacted next. First bring your profile in profiles/${profile}/ up to date with every lasting fact from this conversation that is not there yet: append open delegations (machine, pane, what was asked) and what each session is doing to today's log in logs/, and distill the user's preferences into PROFILE.md and each project's facts into projects/. Reply with one line when done.`;
/** the one-time request after notes.md moved into the profile's logs */
export const distillRequest = (profile: string, file: string): string => `Your old notes.md is now profiles/${profile}/logs/${file}. Distill its lasting facts into profiles/${profile}/PROFILE.md and one projects/<project>.md file per project, short, and keep the import file as it is. Reply with one line when done.`;
/** what the agent is told to keep through a compaction (Claude Code's /compact takes it; Codex's takes none) */
export const compactCommand = (agent: AssistantAgent, profile = DEFAULT_PROFILE): string =>
  agent === "claude" ? `/compact keep: open delegations, user preferences, what each session is doing; then reread profiles/${profile}/ (SOUL.md, PROFILE.md, projects/, today's log)` : "/compact";

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

/**
 * `profile`: its folder under profiles/ (absent in an earlier build's file: "assistant");
 * `profile_migrated_asked`: the one request to distill the notes.md import was sent.
 */
interface Stored { agent: AssistantAgent; started_at: number; pane_id: string | null; workspace_id: string | null; last_compaction: number | null; profile?: string; profile_migrated_asked?: boolean }
const validStored = (value: unknown): value is Stored => isJsonObject(value) && (ASSISTANT_AGENTS as readonly unknown[]).includes(value.agent)
  && typeof value.started_at === "number" && (value.pane_id === null || typeof value.pane_id === "string")
  && (value.workspace_id === null || typeof value.workspace_id === "string") && (value.last_compaction === null || typeof value.last_compaction === "number")
  && (value.profile === undefined || (typeof value.profile === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value.profile)))
  && (value.profile_migrated_asked === undefined || typeof value.profile_migrated_asked === "boolean");
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
  private folderWritten = false;
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

  /** its folder under profiles/ */
  get profile(): string { return this.stored?.profile ?? DEFAULT_PROFILE; }

  /** the folder as this build writes it: at each pane opened, and once at this server's first check (a running pane is kept) */
  private writeFolder(): void {
    writeAgentFolder(this.folder, this.agent === "codex" ? userCodexAuth() : undefined, this.profile, this.now());
    this.folderWritten = true;
  }

  private save(stored: Stored): void { writePrivateState(this.path, stored); this.stored = stored; }

  /** one at a time, after a restart in progress; a check asked for while one waits or runs is that one */
  check(): Promise<void> {
    this.checking ??= this.queue = this.queue.then(() => this.checkNow()).catch((error: unknown) => {
      console.error(`Assistant keep-alive: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.checking = null; });
    return this.checking;
  }

  private async openPane(resume: boolean, startedAt: number): Promise<void> {
    const codex = this.agent === "codex";
    this.writeFolder();
    const { paneId, workspaceId } = await this.panes.open({
      cwd: this.folder, label: "Assistant", agent: this.agent, args: agentArgs(this.agent, resume),
      env: { ...this.env(), ...(codex ? { CODEX_HOME: join(this.folder, ".codex") } : {}) },
    });
    this.save({ agent: this.agent, started_at: startedAt, pane_id: paneId, workspace_id: workspaceId, last_compaction: resume ? this.stored?.last_compaction ?? null : null, profile: this.profile, ...(this.stored?.profile_migrated_asked ? { profile_migrated_asked: true } : {}) });
  }

  private async checkNow(): Promise<void> {
    const stored = this.stored;
    if (stored !== null && stored.pane_id !== null && !this.folderWritten) this.writeFolder();
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
      await this.panes.send(paneId, compactCommand(this.agent, this.profile));
      this.save({ ...this.stored!, last_compaction: now });
      return;
    }
    // once, at rest: the notes.md import distilled into the profile
    const imported = this.stored?.profile_migrated_asked ? null : notesImport(this.folder, this.profile);
    if (imported !== null) {
      await this.panes.send(paneId, distillRequest(this.profile, imported));
      this.save({ ...this.stored!, profile: this.profile, profile_migrated_asked: true });
      return;
    }
    const last = this.stored?.last_compaction;
    if (last != null && now - last < COMPACT_COOLDOWN_MS) return;
    const context = await this.panes.context(paneId, this.agent === "codex" ? join(this.folder, ".codex") : undefined).catch(() => null);
    if (!context?.window || context.used / context.window <= COMPACT_AT) return;
    await this.panes.send(paneId, notesRequest(this.profile));
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
