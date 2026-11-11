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
 * connect to it yet; `unreachable`: SSH failed; the rest come from a check that ran there.
 */
export type AssistantProblem = "not_connected" | "unreachable" | "herdr_stopped" | "no_agent" | "gh_signed_out";
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
export type ProjectRefusal = "invalid_path" | "missing" | "not_git" | "root" | "home" | "home_parent" | "duplicate" | "unknown_machine";
