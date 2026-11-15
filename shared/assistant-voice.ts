/**
 * The wire contract of the Assistant's voice mode (docs/plan/20261115-1240-assistant-voice.md):
 * the routes the Assistant VM's Ovis answers under /api/assistant/voice/, reached from another
 * Ovis through its machine proxy (/api/machines/<vm>/assistant/voice/...). The ElevenLabs key
 * stays on the VM: no answer here ever carries it.
 */

/** The persona's client tools, as the ElevenLabs agent declares them and the page runs them */
export const VOICE_TOOLS = ["ask_assistant", "sessions", "last_result"] as const;
export type VoiceToolName = (typeof VOICE_TOOLS)[number];

/** The marker a voice request carries in the Assistant's chat, before its text */
export const VOICE_MARKER = "[voice]";

/** Seconds of silence, with nothing waiting for the user's OK, before an open call ends */
export const VOICE_SILENCE_SECONDS = 10;
/** Seconds the result call listens for a follow-up after its summary */
export const VOICE_FOLLOW_UP_SECONDS = 10;

/** GET /api/assistant/voice/status */
export interface VoiceStatus {
  /** an ElevenLabs key is set on the VM */
  configured: boolean;
  /** the persona's name, from VOICE.md (Nara by default) */
  persona: string;
  /** agent minutes this month, from the ElevenLabs API; null when it did not answer */
  minutes: { used: number; limit: number } | null;
  /** the Assistant's pane state, so the page knows when a voice request is done; `pending`: the tasks
   * still working, and the newest few finished ones with their replies */
  assistant: { state: "idle" | "working" | "blocked" | "done" | "unknown"; pending: VoiceTask[] };
}

/** One request the persona sent to the Assistant (a task card in the call) */
export interface VoiceTask {
  id: string;
  text: string;
  /** ms since the epoch */
  sent_at: number;
  state: "working" | "done";
  /** the Assistant's finished reply, once done (plain text, at most 4000 characters) */
  result: string | null;
}

/** POST /api/assistant/voice/session: a short-lived token for one call, and the brief the persona starts with */
export interface VoiceSessionResponse {
  /** an ElevenLabs WebRTC conversation token (Conversation.startSession({ conversationToken })) */
  conversation_token: string;
  agent_id: string;
  persona: string;
  /** a few lines for sendContextualUpdate: the user, the machines, the Assistant's state */
  brief: string;
  /** set when this call reports a finished task: the reply Nara summarizes */
  result?: { task_id: string; text: string };
}

/** POST /api/assistant/voice/session body */
export interface VoiceSessionRequest {
  /** open the call for a finished task's summary */
  result_task_id?: string;
}

/** POST /api/assistant/voice/tool body */
export type VoiceToolRequest =
  /** `confirmed`: the user said yes to a risky ask that Nara read back; a risky ask without it is refused */
  | { tool: "ask_assistant"; text: string; confirmed?: boolean }
  | { tool: "sessions"; machine?: string }
  | { tool: "last_result" };

/** POST /api/assistant/voice/tool answer: the text the tool returns to the persona, and for ask_assistant the task */
export interface VoiceToolResponse {
  /** what the persona reads (ElevenLabs passes a client tool's string result to the LLM) */
  result: string;
  task?: VoiceTask;
  /** ask_assistant refused a risky ask without `confirmed`: Nara must read it back and ask */
  needs_confirmation?: boolean;
}
