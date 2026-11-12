import type { MachineState } from "./machines.ts";

/** The agent CLIs the Assistant and the sessions it opens run. */
export const ASSISTANT_AGENTS = ["claude", "codex"] as const;
export type AssistantAgent = (typeof ASSISTANT_AGENTS)[number];

/**
 * What the watcher found wrong on a machine. `not_connected`: Remote PCs has not been allowed to
 * connect to it yet; `unreachable`: SSH failed; `windows`: a Windows PC, which the Assistant leaves
 * out (no checks or sessions there yet); the rest come from a check that ran there.
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
  /** at most this many sessions the Assistant opened (`ovis-task open`) work there at once */
  maxRunning: number;
}

/**
 * The long-lived Assistant session's state: `running` (its agent is up), `prompt` (its agent waits
 * on a question or a permission; the keep-alive leaves it so), `restarting` (its pane or agent is
 * being brought back, resuming the same conversation).
 */
export type AssistantSessionState = "running" | "prompt" | "restarting";

/** The one Assistant session (stateDir/assistant/session.json). */
export interface AssistantSessionInfo {
  agent: AssistantAgent;
  /** the agent pane on the VM's own herdr; null before the first one opened */
  pane_id: string | null;
  /** ms since the epoch: when this conversation started (Restart Assistant starts a new one) */
  started_at: number;
  /** ms since the epoch of the last /compact the server sent; null when none yet */
  last_compaction: number | null;
  state: AssistantSessionState;
}

/** GET /api/assistant */
export interface AssistantState {
  machines: AssistantMachine[];
  /** null until the first session opened */
  session: AssistantSessionInfo | null;
}

/** POST /api/assistant-setup: set up a VM as the Assistant over SSH, from any Ovis but the VM itself */
export interface AssistantSetupRequest {
  /** an SSH alias or user@host, as Add PC takes it; or, in its place, `machineId` */
  destination?: string;
  port?: number;
  /** one of GET /api/assistant-setup's `machines`: set up over that machine's own SSH, resolved by the server */
  machineId?: string;
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

/** A connected Linux machine of this Ovis that GET /api/assistant-setup offers to set up */
export interface AssistantSetupMachine {
  id: string;
  name: string;
  destination: string;
}

/** One event of GET /api/assistant-setup/stream: the terminal's output, or the setup's state */
export type AssistantSetupEvent = { type: "output"; data: string } | { type: "job"; job: AssistantSetupJob };
