/**
 * The Assistant itself (docs/plan/20261111-2112-assistant.md, phase 3): a Claude Code or Codex
 * agent in a herdr pane on the VM, started in stateDir/assistant/agent/, which holds its
 * instructions, its notes and its permission settings. The Assistant is not full auto: its
 * settings allow `ovis-task` and its own folder, and deny ssh, scp, herdr and curl (decision 11).
 *
 * Each session is stateDir/assistant/sessions/<YYYYMMDD-HHMM>/ (decision 18). New session opens a
 * fresh pane, then archives the one before: its conversation is saved there as it stands and its
 * pane closed. herdr's focus is never moved and nothing takes over a pane.
 *
 * A current session whose pane is gone (herdr or the VM restarted) gets a fresh pane under the same
 * name (revive). Its conversation before that cannot be read once the pane is gone (herdr reads it
 * through the pane), so nothing is archived: the agent starts again from ovis-task and notes.md.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_AGENTS, type AssistantAgent, type AssistantSession, type AssistantTranscript } from "../shared/assistant.ts";
import { freeAgentName } from "./agent-name.ts";
import { AssistantError } from "./assistant.ts";
import { paneConversation } from "./conversation.ts";
import { agentStart, HerdrError, paneGet, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isJsonObject } from "./http.ts";
import { launchedAgents } from "./launched-agents.ts";
import { writePrivateState } from "./private-state.ts";
import { readStateDocument } from "./state-document.ts";
import { trustNewFolder } from "./trust-new-folder.ts";

/** where bin/ovis-task is: put first on the pane's PATH */
export const OVIS_TASK_BIN = join(import.meta.dir, "..", "bin");

/** The session's name: its start in the VM's local time, `YYYYMMDD-HHMM`. */
export function sessionName(at: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
}
const NAME = /^\d{8}-\d{4}(-\d+)?$/;

export const INSTRUCTIONS = `# The Assistant

You are the Assistant: one coordinator for every project on every machine in this tailnet. The
user messages you; you read their projects, turn what they write into tasks, and report back.

## Start of every session

1. Run \`ovis-task list\` to see the tasks, \`ovis-task projects\` to see the projects,
   \`ovis-task machines\` to see the machines, and \`ovis-task sessions\` to see every herdr
   session open on them.
2. Read \`notes.md\` in this folder.

## Rules

- The state lives in \`ovis-task\`, not in your memory of an earlier session. Ask it again rather
  than trust what you remember.
- Write lasting facts (preferences, how a project is built, who owns what) to \`notes.md\`. It is
  the only file you edit.
- You reach machines and projects only through \`ovis-task\`. Never try ssh, scp, herdr, curl or
  any other way to another machine: they are denied, and a task is how work gets done there.
- You read files only inside registered projects: \`ovis-task read <project> <path>\`,
  \`ovis-task grep <project> <pattern> [path]\` and \`ovis-task git <project> log|diff|status|show
  [args]\`. Paths are relative to the project folder.
- You coordinate every herdr session on the connected machines, not only your tasks:
  \`ovis-task sessions\` lists them, \`ovis-task peek <machine> <pane>\` reads one, and
  \`ovis-task send <machine> <pane> <message>\` hands work to the agent already open there. Send
  only what the user asked for or agreed to, say in your reply what you sent where, and check back
  with \`peek\`. New work in a registered project goes as a task instead.
- Only the user adds projects, in the app. You can list them, never add one. Asked what is on a
  machine, run \`ovis-task machines\`: it shows the folders open in that machine's herdr
  workspaces. Name the one that fits and ask the user to add it with Add project.
- All work on a project is a task. A task is queued and starts on the project's machine as soon as
  that machine is connected and runs fewer tasks than its Max running setting: a coding agent
  in a new git worktree (branch \`assistant/<id>-<slug>\`), running full auto, with the brief as its
  first prompt. Write the brief so it stands alone: the task's agent sees nothing of this chat,
  and it has no \`ovis-task\`, so never tell it to call \`ovis-task\` or to report back.
- A task's status comes from its agent: \`working\`, \`needs_you\` (it asks something), \`ready\`
  (it finished its turn), \`failed\` or \`cancelled\`. When one needs the user, say so; answer it
  only with what the user told you. After \`ready\` come \`reviewing\` (a second agent reviews the
  branch, when the task has review on), \`merging\` and \`done\`. A \`needs_you\` task with a
  \`reason\` (a merge that failed or conflicted, or a review that kept finding problems) waits for
  the user in the app, not for an answer from you; tell the user that reason.
- You never merge or approve a task, and \`ovis-task\` has no way to: only the user does, with
  Approve on the task's card in the app. When a task is \`ready\`, tell the user to approve it there
  (a \`pr\` project's task shows its PR, \`prUrl\`). Only a task created with \`--auto-merge\` merges
  without that, once its review passed.

## ovis-task

- \`ovis-task projects\`: the projects, their machine and folder
- \`ovis-task machines\`: the machines, whether each is connected, its agent CLIs, and the folders
  its herdr workspaces have open
- \`ovis-task sessions [machine]\`: every herdr workspace and pane on the machines: its pane id,
  agent, state (working, idle, done, blocked), title and folder
- \`ovis-task peek <machine> <pane>\`: an agent's last turns, or a shell's last screen lines
- \`ovis-task send <machine> <pane> <message>\`: sends the message to that pane's agent, as if the
  user typed it. Refused for a shell, a working agent, or a task's own pane
- \`ovis-task read <project> <path>\`
- \`ovis-task grep <project> <pattern> [path]\`
- \`ovis-task git <project> log|diff|status|show [args]\`
- \`ovis-task create <project> --title <title> --brief <brief> [--agent claude|codex]\`: queues a
  task (the project's default agent unless \`--agent\` says). A machine that is down keeps it
  \`queued\` until it comes back.
  - \`--review\`: at \`ready\`, a fresh agent reviews the branch; its findings go back to the task's
    agent, up to 3 rounds, then to the user.
  - \`--auto-merge\`: it merges without the user's Approve once it is \`ready\` (and its review
    passed). Use it only when the user asked for it.
  - \`--after <id>\`: it starts only once task \`<id>\` is \`done\`; it fails if that one fails or is
    cancelled.
  - \`--at <time>\`: \`scheduled\` until then. \`HH:MM\` is the next time the VM's clock shows it
    (today, or tomorrow when it has passed); or a date and time, such as \`2026-11-12T09:00\`.
  - \`--cron "<min> <hour> <day> <month> <weekday>"\`: a repeating task, in the VM's local time
    (\`*\`, lists \`1,15\`, ranges \`1-5\`, steps \`*/15\`; weekday 0 or 7 is Sunday). It stays
    \`scheduled\` as a template and queues a new task (\`fromCron\` its id) at each fire time;
    cancelling the template stops it. It takes neither \`--after\` nor \`--at\`.
- \`ovis-task list [--status <status>]\`: the tasks, newest first
- \`ovis-task show <id>\`: one task and the last lines of its agent's pane
- \`ovis-task answer <id> <choice>\`: answers the question a \`needs_you\` task shows, by the
  option's number or label (or the text, where the question takes typed text)
- \`ovis-task cancel <id>\`: stops the task and closes its agent's pane (its worktree stays), or
  takes a \`queued\` or \`scheduled\` task or a cron template off the queue
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

/** What the sessions ask of herdr; tests pass their own. */
export interface AssistantPanes {
  open(options: { cwd: string; label: string; env: Record<string, string>; agent: AssistantAgent; args: string[] }): Promise<{ paneId: string; workspaceId: string }>;
  /** the conversation as it stands, for the archive */
  read(paneId: string): Promise<Omit<AssistantTranscript, "name">>;
  close(workspaceId: string): Promise<void>;
  /** whether herdr still has the pane; rejects when herdr cannot be asked */
  alive(paneId: string): Promise<boolean>;
}

const textOf = (parts: readonly { kind: string; text?: string }[]) => parts.flatMap((part) => part.kind === "text" && part.text ? [part.text] : []).join("\n\n");

export const herdrPanes: AssistantPanes = {
  async open({ cwd, label, env, agent, args }) {
    // focus: false (workspaceCreate), so herdr's own focus stays where it is
    const created = await workspaceCreate({ cwd, label, env });
    const paneId = created.root_pane.pane_id;
    try {
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
    } catch (error) {
      await workspaceClose(created.tab.workspace_id).catch(() => undefined);
      throw error;
    }
    launchedAgents.launched(paneId, agent);
    if (agent === "claude") void trustNewFolder(paneId).catch(() => undefined);
    return { paneId, workspaceId: created.tab.workspace_id };
  },
  async read(paneId) {
    try {
      // every page, oldest first, up to a bound
      let page = await paneConversation(paneId);
      const turns = [...page.turns];
      for (let pages = 1; page.cursor !== null && pages < 50; pages += 1) {
        page = await paneConversation(paneId, undefined, { before: page.cursor });
        turns.unshift(...page.turns);
      }
      return { turns: turns.flatMap((turn) => { const text = textOf(turn.parts); return text ? [{ role: turn.role, text }] : []; }) };
    } catch {
      // no transcript recognized (or the read failed): what the pane shows
      const text = await paneRead({ paneId, source: "recent", format: "text", timeoutMs: 5_000 }).then((read) => read.text, () => "");
      return { turns: [], text };
    }
  },
  close: (workspaceId) => workspaceClose(workspaceId),
  alive: (paneId) => paneGet(paneId).then(() => true, (error: unknown) => {
    if (error instanceof HerdrError && error.code === "pane_not_found") return false;
    throw error;
  }),
};

type Stored = AssistantSession & { workspace_id: string | null };
const validStored = (value: unknown): value is Stored => isJsonObject(value) && typeof value.name === "string" && NAME.test(value.name)
  && (ASSISTANT_AGENTS as readonly unknown[]).includes(value.agent) && typeof value.started_at === "number"
  && (value.pane_id === null || typeof value.pane_id === "string");

export class AssistantSessions {
  private directory: string;
  readonly folder: string;
  private busy: Promise<unknown> = Promise.resolve();
  /** the current session as last read or saved; undefined until read */
  private current: Stored | null | undefined;
  private reviving = false;

  constructor(stateDir: string, private agent: AssistantAgent, private env: () => Record<string, string>, private panes: AssistantPanes = herdrPanes, private now: () => Date = () => new Date()) {
    this.directory = join(stateDir, "assistant", "sessions");
    this.folder = join(stateDir, "assistant", "agent");
  }

  private stored(): Stored[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((name) => NAME.test(name)).flatMap((name) => {
      const read = readStateDocument(join(this.directory, name, "session.json"));
      return read.kind === "json" && validStored(read.value) && read.value.name === name ? [read.value] : [];
    }).sort((a, b) => b.started_at - a.started_at || b.name.localeCompare(a.name));
  }

  list(): AssistantSession[] {
    return this.stored().map(({ workspace_id: _, ...session }) => session);
  }

  private save(session: Stored): void { writePrivateState(join(this.directory, session.name, "session.json"), session); this.current = undefined; }

  private currentSession(): Stored | null {
    return this.current ??= this.stored().find((session) => session.archived_at === undefined) ?? null;
  }

  private open(name: string): Promise<{ paneId: string; workspaceId: string }> {
    const codex = this.agent === "codex";
    writeAgentFolder(this.folder, codex ? userCodexAuth() : undefined);
    return this.panes.open({
      cwd: this.folder, label: `Assistant ${name}`, agent: this.agent, args: codex ? CODEX_ARGS : [],
      env: { ...this.env(), ...(codex ? { CODEX_HOME: join(this.folder, ".codex") } : {}) },
    });
  }

  /**
   * herdr's panes as it lists them now: a current session whose pane is not among them gets a fresh
   * one under the same name, once herdr itself says that pane is gone. herdr's focus never moves.
   */
  revive(live: ReadonlySet<string>): Promise<void> {
    const current = this.currentSession();
    if (this.reviving || current === null || current.pane_id === null || live.has(current.pane_id)) return this.busy.then(() => undefined);
    this.reviving = true;
    const run = this.busy.then(() => this.reviveNow()).finally(() => { this.reviving = false; });
    this.busy = run.catch(() => undefined);
    return this.busy.then(() => undefined);
  }

  private async reviveNow(): Promise<void> {
    const current = this.currentSession();
    // a New chat meanwhile, or a herdr that cannot say (alive rejects): left as it is
    if (current === null || current.pane_id === null || await this.panes.alive(current.pane_id)) return;
    // a workspace herdr restored without the pane goes, so the session keeps one
    if (current.workspace_id !== null) await this.panes.close(current.workspace_id).catch(() => undefined);
    const { paneId, workspaceId } = await this.open(current.name);
    this.save({ ...current, pane_id: paneId, workspace_id: workspaceId });
  }

  /** New session: a fresh pane first, then every session before it archived. One at a time. */
  start(): Promise<AssistantSession> {
    const run = this.busy.then(() => this.startNow());
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async startNow(): Promise<AssistantSession> {
    const at = this.now();
    const taken = new Set(this.stored().map((session) => session.name));
    let name = sessionName(at);
    for (let n = 2; taken.has(name); n += 1) name = `${sessionName(at)}-${n}`;
    const { paneId, workspaceId } = await this.open(name);
    for (const previous of this.stored()) if (previous.archived_at === undefined) await this.archive(previous);
    const session: Stored = { name, agent: this.agent, started_at: at.getTime(), pane_id: paneId, workspace_id: workspaceId };
    this.save(session);
    const { workspace_id: _, ...shown } = session;
    return shown;
  }

  private async archive(session: Stored): Promise<void> {
    const transcript = session.pane_id === null ? { turns: [] } : await this.panes.read(session.pane_id).catch(() => ({ turns: [] }));
    writePrivateState(join(this.directory, session.name, "transcript.json"), { name: session.name, ...transcript } satisfies AssistantTranscript);
    // a pane already gone is archived all the same
    if (session.workspace_id !== null) await this.panes.close(session.workspace_id).catch(() => undefined);
    this.save({ ...session, pane_id: null, workspace_id: null, archived_at: this.now().getTime() });
  }

  /** An archived session's saved conversation; the current one is read live in the chat. */
  transcript(name: string): AssistantTranscript {
    if (!NAME.test(name)) throw new AssistantError("not_found", "No session has that name", 404);
    const read = readStateDocument(join(this.directory, name, "transcript.json"));
    if (read.kind !== "json" || !isJsonObject(read.value) || !Array.isArray(read.value.turns)) throw new AssistantError("not_found", "That session is not archived", 404);
    return read.value as unknown as AssistantTranscript;
  }
}
