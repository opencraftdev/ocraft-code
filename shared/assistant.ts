import type { MachineState } from "./machines.ts";

/** The agent CLIs a task can run with (and the Assistant itself). */
export const ASSISTANT_AGENTS = ["claude", "codex"] as const;
export type AssistantAgent = (typeof ASSISTANT_AGENTS)[number];
/** "pr": the task's branch lands as a GitHub PR; "local": it merges into the checkout's base branch */
export type MergeMode = "pr" | "local";

/** One registered project folder (stateDir/assistant/projects.json). Only the UI adds one. */
export interface AssistantProject {
  id: string;
  /** the Remote PCs machine id (a herdr saved machine's stable id) */
  machine: string;
  /** the folder, resolved on that machine (symlinks followed): a git repository's top folder */
  path: string;
  mergeMode: MergeMode;
  defaultAgent: AssistantAgent;
}

/**
 * What the watcher found wrong on a machine. `not_connected`: Remote PCs has not been allowed to
 * connect to it yet; `unreachable`: SSH failed; `windows`: a Windows PC, which the Assistant leaves
 * out (no checks, projects or tasks there yet); the rest come from a check that ran there.
 */
export type AssistantProblem = "not_connected" | "unreachable" | "windows" | "herdr_stopped" | "no_agent" | "gh_signed_out";
/** A fix runs only on the user's click (POST /api/assistant/machines/:id/fix), never by itself. */
export type AssistantFix = "start_herdr";

export interface MachineHealth {
  /** ms since the epoch */
  checked_at: number;
  problems: AssistantProblem[];
  /** the agent CLIs found on the machine; empty when it could not be checked */
  agents: AssistantAgent[];
  /** SSH's own words when the machine was unreachable */
  error?: string;
}

export interface AssistantMachine {
  id: string;
  name: string;
  state: MachineState;
  /** null until its first check finished */
  health: MachineHealth | null;
  maxRunning: number;
}

/** GET /api/assistant */
export interface AssistantState {
  machines: AssistantMachine[];
  projects: AssistantProject[];
  /** newest first; the first one without `archived_at` is the current session */
  sessions: AssistantSession[];
  /** newest first */
  tasks: AssistantTask[];
}

/**
 * A task's place in its lifecycle (docs/plan/20261111-2112-assistant.md, Task statuses):
 * (Scheduled ->) Queued -> Working -> (Needs you <-> Working) -> Ready -> (Reviewing) -> Merging ->
 * Done, and Cancelled or Failed at any point. To do is only a phase 4 task that never started.
 */
export const TASK_STATUSES = ["todo", "scheduled", "queued", "working", "needs_you", "ready", "reviewing", "merging", "done", "cancelled", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** One task (stateDir/assistant/tasks.json): a coding agent in a worktree of a project, on the project's machine. */
export interface AssistantTask {
  id: string;
  title: string;
  brief: string;
  project: string;
  /** the Remote PCs machine id the task runs on */
  machine: string;
  agent: AssistantAgent;
  status: TaskStatus;
  /** the agent's pane on that machine's herdr; null before it started */
  paneId: string | null;
  /** the worktree's checkout on that machine (absolute), and its herdr workspace */
  worktree: string | null;
  workspaceId: string | null;
  /** `assistant/<id>-<slug>` */
  branch: string;
  /**
   * The queue (phase 5): a Queued task starts once the task `after` names is Done (it fails when that
   * one fails or is cancelled), and a Scheduled one becomes Queued at `at` (an ISO time). A task with
   * `cron` (five fields, the VM's local time) is a template that never runs itself: it stays
   * Scheduled, and at each fire time (`next`, ms since the epoch) a copy of it, `fromCron` its id, is
   * queued.
   */
  after?: string;
  at?: string;
  cron?: string;
  next?: number;
  fromCron?: string;
  /**
   * Review and merge (phase 6). `review`: a fresh agent reviews the branch at Ready, up to
   * REVIEW_ROUNDS rounds (server/assistant-tasks.ts); `autoMerge`: it merges without the user's
   * Approve once the review passed (or at Ready, without review).
   */
  review: boolean;
  autoMerge: boolean;
  /** the PR a `pr` project's task opened at Ready */
  prUrl?: string;
  /** the branch the task merges into: the project checkout's branch, read when first needed */
  base?: string;
  /** review rounds started, the last round's findings, the reviewer's pane while it runs, and a passed review */
  reviewRounds?: number;
  findings?: string;
  reviewPaneId?: string;
  reviewed?: true;
  /** the reviewer worked since it started (or since its nudge), and was asked once more for its verdict line */
  reviewWorked?: true;
  reviewNudged?: true;
  /** the branch has no commits ahead of `base`: Approve marks it Done with nothing merged */
  nothingToMerge?: true;
  /**
   * Why a task the server moved to Needs you waits for the user: a merge that failed or conflicted,
   * or a review that kept finding problems. herdr's agent state leaves such a task alone; Approve
   * tries again.
   */
  reason?: string;
  /** what the merge or the cleanup after it left to say (nothing merged, a worktree that stayed) */
  note?: string;
  /** Dismiss: off the board, its worktree and branch removed */
  dismissed?: true;
  /** ms since the epoch */
  createdAt: number;
  startedAt?: number;
  /** herdr reported the agent at work at least once since it started: at rest after that is Ready */
  worked?: true;
  /** a brief of several lines, not yet sent: it goes into the agent's input as a paste once the agent is up */
  briefPending?: true;
  /** why it failed */
  error?: string;
}

/** POST /api/ovis-task/create (`ovis-task create`) */
export interface CreateTaskRequest {
  project: string;
  title: string;
  brief: string;
  agent?: AssistantAgent;
  review?: boolean;
  autoMerge?: boolean;
  after?: string;
  at?: string;
  cron?: string;
}

/**
 * One Assistant session (stateDir/assistant/sessions/<name>/), named by its start in the VM's local
 * time, `YYYYMMDD-HHMM`. The current one has a live agent pane; an archived one keeps only the
 * transcript saved as it was archived.
 */
export interface AssistantSession {
  name: string;
  agent: AssistantAgent;
  /** ms since the epoch */
  started_at: number;
  /** the agent pane on the VM's herdr; null once archived */
  pane_id: string | null;
  archived_at?: number;
}

/** GET /api/assistant/sessions/:name: an archived session's conversation, read only */
export interface AssistantTranscript {
  name: string;
  /** the turns the chat read of the pane as it was archived (text parts only) */
  turns: { role: "user" | "assistant"; text: string }[];
  /** the pane's screen, when no transcript was recognized */
  text?: string;
}

/** Why an `ovis-task` read was refused (the error code of /api/ovis-task/*). */
export type OvisTaskRefusal = "unknown_project" | "unknown_machine" | "invalid_path" | "absolute_path" | "outside_project" | "not_found" | "not_a_file"
  | "project_missing" | "invalid_pattern" | "invalid_git_command" | "invalid_git_argument";

/** POST /api/assistant/projects */
export interface AddProjectRequest { machine: string; path: string; defaultAgent?: AssistantAgent }
/** PATCH /api/assistant/projects/:id */
export interface ProjectChange { mergeMode?: MergeMode; defaultAgent?: AssistantAgent }

/** Why a folder was refused as a project (the error code of POST /api/assistant/projects). */
export type ProjectRefusal = "invalid_path" | "missing" | "not_git" | "root" | "home" | "home_parent" | "duplicate" | "unknown_machine" | "windows";

/** POST /api/assistant-setup: set up a VM as the Assistant over SSH, from any Ovis but the VM itself */
export interface AssistantSetupRequest {
  /** an SSH alias or user@host, as Add PC takes it */
  destination: string;
  port?: number;
  /** the VM's Tailscale machine name (ASSISTANT_NAME) */
  name: string;
  agent: AssistantAgent;
  /** the page's terminal size, for the first frame */
  cols?: number;
  rows?: number;
}

/**
 * A setup's state (GET /api/assistant-setup, and each `job` event of its stream).
 * `unsupported`: this server has no PTY host, so `command` is to be pasted on the VM instead.
 */
export interface AssistantSetupJob {
  id: string;
  phase: "connecting" | "authentication" | "running" | "done" | "failed" | "stopped" | "unsupported";
  destination: string;
  /** what SSH asks before the install runs: a new host's fingerprint, or a password or key passphrase */
  challenge: { id: string; kind: "host_key" | "secret"; prompt: string } | null;
  /** the command the VM runs, to paste in its own terminal where this server cannot run it */
  command: string;
  /** the https://….ts.net address the install printed */
  address: string | null;
  error: string | null;
}

/** One event of GET /api/assistant-setup/stream: the terminal's output, or the setup's state */
export type AssistantSetupEvent = { type: "output"; data: string } | { type: "job"; job: AssistantSetupJob };
