/**
 * The Assistant's voice call (docs/plan/20261115-1240-assistant-voice.md): one call at a time for
 * the page, kept here outside React so it goes on as audio while the user is in Chat or in another
 * pane. The audio runs between the browser and ElevenLabs (@elevenlabs/client, loaded on the first
 * Start); the persona's tools and the token go through the Assistant VM's Ovis (lib/api.ts).
 *
 * After VOICE_SILENCE_SECONDS with no one speaking and nothing waiting for the user's OK the call
 * ends; the tasks it sent keep being polled while one works, and a finished one chimes and opens a
 * result call when the user is on the Voice screen, or waits for a tap (the toast) when not.
 */
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { useAssistantView, type AssistantView } from "./assistantMode.ts";
import type { PartialOptions } from "@elevenlabs/client";
import { ApiError, fetchAssistantVoiceStatus, runAssistantVoiceTool, startAssistantVoiceSession } from "./api.ts";
import { playAlertSound, unlockAlertSound } from "./alertSound.ts";
import {
  VOICE_FOLLOW_UP_SECONDS,
  VOICE_SILENCE_SECONDS,
  VOICE_TOOLS,
  type VoiceSessionRequest,
  type VoiceSessionResponse,
  type VoiceStatus,
  type VoiceTask,
  type VoiceToolName,
  type VoiceToolRequest,
  type VoiceToolResponse,
} from "../../shared/assistant-voice.ts";

declare const __HERDR_TEST_HOOKS__: boolean;

export type CallPhase = "idle" | "connecting" | "listening" | "thinking" | "speaking";
/** why Voice cannot talk now: one line on the call screen each */
export type VoiceTrouble = "no_key" | "mic" | "offline" | "provider" | "provider_auth" | "minutes" | "failed";
export interface Caption { id: number; who: "user" | "agent"; text: string }
/** a task card: a sent task, or (`waiting`) a risky ask Nara read back and waits on the user's OK for */
export interface VoiceCard extends VoiceTask { waiting: boolean }

export interface VoiceState {
  /** the PC the Assistant's pane is on ("local" when this page is the VM's own) */
  machineId: string | null;
  status: VoiceStatus | null;
  persona: string;
  phase: CallPhase;
  muted: boolean;
  captions: readonly Caption[];
  tasks: readonly VoiceCard[];
  trouble: VoiceTrouble | null;
  /** a finished task whose summary waits for the user's tap (the toast) */
  result: VoiceTask | null;
}

/** what the page uses of a call (the SDK's VoiceConversation) */
export interface VoiceCall {
  endSession(): Promise<void>;
  setMicMuted(muted: boolean): void;
  getInputVolume(): number;
  getOutputVolume(): number;
  sendContextualUpdate(text: string): void;
}
export interface VoiceSdk { Conversation: { startSession(options: PartialOptions): Promise<VoiceCall> } }

export interface VoiceDeps {
  api: {
    status(machineId: string): Promise<VoiceStatus>;
    session(machineId: string, request: VoiceSessionRequest): Promise<VoiceSessionResponse>;
    tool(machineId: string, request: VoiceToolRequest): Promise<VoiceToolResponse>;
  };
  loadSdk(): Promise<VoiceSdk>;
  chime(): void;
  now(): number;
  /** runs `run` every `ms` until the returned stop is called */
  every(ms: number, run: () => void): () => void;
}

const CAPTIONS_KEPT = 4;
export const POLL_MS = 5000;
const TICK_MS = 500;
/** how long a read-back waiting for the user's yes keeps an open call from ending on silence */
export const READ_BACK_HOLD_MS = 45_000;
/** an input level above this is someone speaking, not the room */
const SPEECH_LEVEL = 0.08;

export function voiceTrouble(error: unknown): VoiceTrouble {
  if (error instanceof ApiError) {
    if (error.code === "machine_offline" || (error.status === 503 && error.code === null)) return "offline";
    if (error.code === "voice_provider_auth") return "provider_auth";
    if (error.code === "voice_provider") return "provider";
    if (error.code === "voice_not_configured") return "no_key";
    // voice_failed, and the tool route's assistant_not_running, assistant_prompt, invalid_text, unknown_tool
    return "failed";
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError" ? "mic" : "failed";
}

/** The tool call the persona made, as the VM's tool route takes it. */
export function toolRequest(tool: VoiceToolName, parameters: unknown): VoiceToolRequest {
  const given = (parameters ?? {}) as Record<string, unknown>;
  if (tool === "ask_assistant") return { tool, text: String(given["text"] ?? ""), ...(given["confirmed"] === true ? { confirmed: true } : {}) };
  if (tool === "sessions") return typeof given["machine"] === "string" && given["machine"] !== "" ? { tool, machine: given["machine"] } : { tool };
  return { tool };
}

/** The persona's cue to tell a finished task, spoken from the reply the VM sent. */
export function resultCue(text: string): string {
  return `The Assistant just finished a task you sent. Its reply:\n${text}\n\nSummarize that result for the user now in 1 to 3 sentences, in the language they last spoke. Do not read code, paths or logs aloud.`;
}

export function minutesLeft(status: VoiceStatus | null): number | null {
  return status?.minutes ? Math.max(0, Math.floor(status.minutes.limit - status.minutes.used)) : null;
}

export function createVoiceController(deps: VoiceDeps) {
  let state: VoiceState = { machineId: null, status: null, persona: "Nara", phase: "idle", muted: false, captions: [], tasks: [], trouble: null, result: null };
  const listeners = new Set<() => void>();
  let call: VoiceCall | null = null;
  /** each start's number: an answer for an earlier start that ended meanwhile is dropped */
  let attempt = 0;
  let lastHeard = 0;
  let silenceLimit = VOICE_SILENCE_SECONDS;
  let toolsRunning = 0;
  let captionId = 0;
  let cardId = 0;
  let stopTick: (() => void) | null = null;
  let stopPoll: (() => void) | null = null;
  let voiceShown = false;

  const set = (next: Partial<VoiceState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const heard = () => { lastHeard = deps.now(); };
  const caption = (who: Caption["who"], text: string) => {
    if (text.trim() === "") return;
    set({ captions: [...state.captions, { id: ++captionId, who, text }].slice(-CAPTIONS_KEPT) });
  };
  const working = () => state.tasks.filter((task) => task.state === "working" && !task.waiting);

  /** polls the status only while a task works */
  const syncPolling = () => {
    const wanted = state.machineId !== null && working().length > 0;
    if (wanted && stopPoll === null) stopPoll = deps.every(POLL_MS, () => void poll());
    if (!wanted && stopPoll !== null) { stopPoll(); stopPoll = null; }
  };

  const takeStatus = (status: VoiceStatus) => {
    // a reload finds the tasks still working: their cards come back, so the result still reaches the user
    const adopted = state.tasks.length === 0 ? status.assistant.pending.filter((task) => task.state === "working").map((task) => ({ ...task, waiting: false })) : state.tasks;
    set({ status, persona: status.persona || state.persona, tasks: adopted, ...(status.configured ? {} : { trouble: "no_key" as const }) });
    syncPolling();
  };

  async function poll(): Promise<void> {
    const machineId = state.machineId;
    if (machineId === null) return;
    let status: VoiceStatus;
    try { status = await deps.api.status(machineId); } catch { return; }
    if (machineId !== state.machineId) return;
    const latest = new Map(status.assistant.pending.map((task) => [task.id, task]));
    const done: VoiceTask[] = [];
    const tasks = state.tasks.map((card) => {
      if (card.waiting || card.state === "done") return card;
      const now = latest.get(card.id);
      // a task the VM no longer lists while the Assistant rests is done; while it works, maybe not listed yet
      if (now?.state === "done" || (now === undefined && status.assistant.state !== "working")) {
        const finished: VoiceCard = { ...card, ...now, state: "done", waiting: false };
        done.push(finished);
        return finished;
      }
      return now ? { ...card, ...now, waiting: false } : card;
    });
    set({ status, persona: status.persona || state.persona, tasks });
    syncPolling();
    for (const task of done) resultReady(task);
  }

  /** a task came to rest: Nara tells it in an open call or on the Voice screen; elsewhere the toast waits for a tap */
  function resultReady(task: VoiceTask): void {
    deps.chime();
    if (call !== null) { call.sendContextualUpdate(resultCue(task.result ?? "")); heard(); return; }
    if (voiceShown && state.phase === "idle") { void start(task.id); return; }
    set({ result: task });
  }

  function finish(trouble: VoiceTrouble | null): void {
    attempt += 1;
    const ending = call;
    call = null;
    stopTick?.();
    stopTick = null;
    toolsRunning = 0;
    // a read-back the user never answered goes with the call
    set({ phase: "idle", trouble, tasks: state.tasks.filter((task) => !task.waiting) });
    syncPolling();
    if (ending !== null) void ending.endSession().catch(() => {});
  }

  async function runTool(tool: VoiceToolName, parameters: unknown, machineId: string): Promise<string> {
    if (machineId !== state.machineId) return "The Assistant is not reachable from this page.";
    const request = toolRequest(tool, parameters);
    toolsRunning += 1;
    if (state.phase === "listening") set({ phase: "thinking" });
    try {
      const answer = await deps.api.tool(machineId, request);
      if (request.tool === "ask_assistant") {
        const others = state.tasks.filter((task) => !task.waiting);
        if (answer.needs_confirmation) {
          set({ tasks: [...others, { id: `ok-${++cardId}`, text: request.text, sent_at: deps.now(), state: "working", result: null, waiting: true }] });
        } else if (answer.task) {
          const card: VoiceCard = { ...answer.task, waiting: false };
          set({ tasks: [...others.filter((task) => task.id !== card.id), card] });
        } else {
          set({ tasks: others });
        }
        syncPolling();
      }
      return answer.result;
    } catch (error) {
      return `The tool failed: ${error instanceof ApiError ? error.detail : "no answer"}. Tell the user briefly.`;
    } finally {
      toolsRunning = Math.max(0, toolsRunning - 1);
      heard();
    }
  }

  /** ends the call after its silence, unless someone talks, a tool runs or a read-back waits */
  function tick(): void {
    if (call === null) return;
    if (state.phase === "speaking" || call.getInputVolume() > SPEECH_LEVEL || call.getOutputVolume() > SPEECH_LEVEL) heard();
    // a read-back holds the call open only for a while: a "no" that leads to no tool call must not keep it forever
    if (toolsRunning > 0 || state.tasks.some((task) => task.waiting && deps.now() - task.sent_at < READ_BACK_HOLD_MS)) { heard(); return; }
    if (deps.now() - lastHeard >= silenceLimit * 1000) finish(null);
  }

  /** reads the status (configured, persona, minutes); a retry clears the trouble line */
  async function refresh(): Promise<void> {
    const machineId = state.machineId;
    if (machineId === null) return;
    if (state.phase === "idle") set({ trouble: null });
    try {
      const status = await deps.api.status(machineId);
      if (machineId === state.machineId) takeStatus(status);
    } catch (error) {
      if (machineId === state.machineId && state.phase === "idle") set({ trouble: voiceTrouble(error) });
    }
  }

  async function start(resultTaskId?: string): Promise<void> {
    const machineId = state.machineId;
    if (machineId === null || state.phase !== "idle") return;
    if (state.status?.configured === false) { set({ trouble: "no_key" }); return; }
    if (minutesLeft(state.status) === 0) { set({ trouble: "minutes" }); return; }
    const mine = ++attempt;
    set({ phase: "connecting", trouble: null, captions: [], result: null });
    try {
      const [sdk, session] = await Promise.all([deps.loadSdk(), deps.api.session(machineId, resultTaskId ? { result_task_id: resultTaskId } : {})]);
      if (mine !== attempt) return;
      silenceLimit = session.result ? VOICE_FOLLOW_UP_SECONDS : VOICE_SILENCE_SECONDS;
      heard();
      const clientTools = Object.fromEntries(VOICE_TOOLS.map((tool) => [tool, (parameters: unknown) => runTool(tool, parameters, machineId)]));
      const opened = await sdk.Conversation.startSession({
        conversationToken: session.conversation_token,
        connectionType: "webrtc",
        clientTools,
        onMessage: ({ message, source }) => {
          heard();
          caption(source === "user" ? "user" : "agent", message);
          if (source === "user" && state.phase === "listening") set({ phase: "thinking" });
        },
        onModeChange: ({ mode }) => {
          heard();
          if (call !== null) set({ phase: mode === "speaking" ? "speaking" : "listening" });
        },
        onStatusChange: ({ status }) => { if (status === "disconnected" && call !== null && mine === attempt) finish(null); },
        onError: (message) => { console.warn("assistant voice:", message); },
        onDisconnect: (details) => { if (mine === attempt) finish(details.reason === "error" ? "provider" : null); },
      });
      if (mine !== attempt) { void opened.endSession().catch(() => {}); return; }
      call = opened;
      if (state.muted) opened.setMicMuted(true);
      opened.sendContextualUpdate(session.brief);
      if (session.result) opened.sendContextualUpdate(resultCue(session.result.text));
      set({ phase: (state.phase as CallPhase) === "connecting" ? "listening" : state.phase, persona: session.persona || state.persona });
      heard();
      stopTick = deps.every(TICK_MS, tick);
    } catch (error) {
      if (mine === attempt) finish(voiceTrouble(error));
    }
  }

  return {
    getState: (): VoiceState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** the Assistant pane's PC: its routes, its tasks */
    bind(machineId: string | null): void {
      if (machineId === state.machineId) return;
      if (state.phase !== "idle") finish(null);
      set({ machineId, status: null, tasks: [], captions: [], trouble: null, result: null });
      syncPolling();
      // the minutes, the persona, and the tasks a reload left working
      if (machineId !== null) void refresh();
    },
    /** whether the Voice screen is in front of the user: only there may a result call open by itself */
    setVoiceShown(shown: boolean): void { voiceShown = shown; },
    refresh,
    start,
    end(): void { if (state.phase !== "idle") finish(null); },
    toggleMute(): void {
      const muted = !state.muted;
      call?.setMicMuted(muted);
      set({ muted });
    },
    /** the toast's tap: the waiting result's call */
    hear(): void {
      const task = state.result;
      set({ result: null });
      if (task !== null) void start(task.id);
    },
    dismissResult(): void { set({ result: null }); },
    /** the orb's levels, read each frame */
    levels(): { input: number; output: number } {
      return call === null ? { input: 0, output: 0 } : { input: call.getInputVolume(), output: call.getOutputVolume() };
    },
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;

function loadSdk(): Promise<VoiceSdk> {
  // the browser scripts' stand-in (scripts/assistant-voice-demo-regression.ts); a release build drops the check
  if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__) {
    const fake = (window as { __ovisVoiceSdk?: VoiceSdk }).__ovisVoiceSdk;
    if (fake) return Promise.resolve(fake);
  }
  return import("@elevenlabs/client");
}

/** The page's one call. */
export const assistantVoice = createVoiceController({
  api: { status: fetchAssistantVoiceStatus, session: startAssistantVoiceSession, tool: runAssistantVoiceTool },
  loadSdk,
  // the alert sound's chime (lib/alertSound.ts): a WebAudio tone, unlocked by the Start tap
  chime: () => { void unlockAlertSound().then((ok) => { if (ok) playAlertSound("done"); }); },
  now: () => Date.now(),
  every: (ms, run) => { const timer = setInterval(run, ms); return () => clearInterval(timer); },
});

export function useAssistantVoice(): VoiceState {
  return useSyncExternalStore(assistantVoice.subscribe, assistantVoice.getState, assistantVoice.getState);
}

/**
 * App's side of the Assistant pane's voice mode: Chat or Voice on this device, the pane the toast
 * goes back to, and the call bound to the Assistant's PC. The binding stays when the user moves on,
 * so a task's result still reaches them in another pane.
 */
export function useAssistantVoicePane(assistantChat: boolean, machineId: string, paneId: string | null): {
  view: AssistantView; setView: (view: AssistantView) => void; target: RefObject<{ machineId: string; paneId: string } | null>;
} {
  const [view, setView] = useAssistantView();
  const target = useRef<{ machineId: string; paneId: string } | null>(null);
  if (assistantChat && paneId !== null) target.current = { machineId, paneId };
  useEffect(() => { if (assistantChat) assistantVoice.bind(machineId); }, [assistantChat, machineId]);
  return { view, setView, target };
}
