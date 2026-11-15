import { afterEach, describe, expect, it } from "bun:test";

import { VOICE_FOLLOW_UP_SECONDS, VOICE_SILENCE_SECONDS, VOICE_TOOLS, type VoiceSessionRequest, type VoiceStatus, type VoiceTask, type VoiceToolRequest, type VoiceToolResponse } from "../../shared/assistant-voice.ts";
import { ApiError, fetchAssistantVoiceStatus, runAssistantVoiceTool, startAssistantVoiceSession } from "./api.ts";
import { createVoiceController, POLL_MS, toolRequest, voiceTrouble, type VoiceCall } from "./assistantVoice.ts";

const status = (extra: Partial<VoiceStatus> = {}, pending: VoiceTask[] = [], state: VoiceStatus["assistant"]["state"] = "idle"): VoiceStatus =>
  ({ configured: true, persona: "Nara", minutes: { used: 3, limit: 15 }, assistant: { state, pending }, ...extra });
const task = (id: string, state: VoiceTask["state"] = "working", result: string | null = null): VoiceTask => ({ id, text: `do ${id}`, sent_at: 1, state, result });

/** a controller over fakes: the SDK, the routes, the clock and the timers, each run by hand */
function harness(start: { status?: VoiceStatus; result?: { task_id: string; text: string }; sdkError?: unknown } = {}) {
  let now = 1_000;
  const timers = new Map<number, { ms: number; run: () => void }>();
  let timerId = 0;
  const sessions: VoiceSessionRequest[] = [];
  const tools: VoiceToolRequest[] = [];
  let toolAnswer: (request: VoiceToolRequest) => VoiceToolResponse = () => ({ result: "ok" });
  let currentStatus = start.status ?? status();
  const statusReads: string[] = [];
  const updates: string[] = [];
  const chimes: number[] = [];
  let options: Record<string, any> | null = null;
  let ended = 0;
  let input = 0;
  const call: VoiceCall = {
    endSession: async () => { ended += 1; },
    setMicMuted: () => {},
    getInputVolume: () => input,
    getOutputVolume: () => 0,
    sendContextualUpdate: (text) => { updates.push(text); },
  };
  const voice = createVoiceController({
    api: {
      status: async (machineId) => { statusReads.push(machineId); return currentStatus; },
      session: async (_machineId, request) => { sessions.push(request); return { conversation_token: "tok", agent_id: "a", persona: "Nara", brief: "the brief", ...(start.result ? { result: start.result } : {}) }; },
      tool: async (_machineId, request) => { tools.push(request); return toolAnswer(request); },
    },
    loadSdk: async () => ({ Conversation: { startSession: async (given) => { if (start.sdkError) throw start.sdkError; options = given as Record<string, any>; return call; } } }),
    chime: () => { chimes.push(now); },
    now: () => now,
    every: (ms, run) => { const id = ++timerId; timers.set(id, { ms, run }); return () => { timers.delete(id); }; },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    voice, sessions, tools, updates, chimes, statusReads, settle,
    get options() { return options!; },
    get ended() { return ended; },
    set input(level: number) { input = level; },
    set status(next: VoiceStatus) { currentStatus = next; },
    set toolAnswer(answer: (request: VoiceToolRequest) => VoiceToolResponse) { toolAnswer = answer; },
    timers: (ms: number) => [...timers.values()].filter((timer) => timer.ms === ms).length,
    /** moves the clock and runs every timer once per its period passed */
    async advance(ms: number) {
      for (let passed = 0; passed < ms; passed += 500) {
        now += 500;
        for (const timer of [...timers.values()]) if (now % timer.ms === 0) timer.run();
        await settle();
      }
    },
  };
}

describe("the Assistant's voice routes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("asks the VM's own routes on the VM, and through the machine proxy from another Ovis", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ result: "x" }), { status: 200 }); }) as typeof fetch;
    await fetchAssistantVoiceStatus("local");
    await fetchAssistantVoiceStatus("raka-devs");
    await startAssistantVoiceSession("local", {});
    await startAssistantVoiceSession("raka-devs", { result_task_id: "t1" });
    await runAssistantVoiceTool("raka-devs", { tool: "last_result" });
    expect(urls).toEqual([
      "/api/assistant/voice/status",
      "/api/machines/raka-devs/assistant/voice/status",
      "/api/assistant/voice/session",
      "/api/machines/raka-devs/assistant/voice/session",
      "/api/machines/raka-devs/assistant/voice/tool",
    ]);
  });

  it("says an offline VM, a refused key and a refused mic apart", async () => {
    expect(voiceTrouble(new ApiError("u", 503, "offline", "machine_offline"))).toBe("offline");
    expect(voiceTrouble(new ApiError("u", 502, "no", "voice_provider_auth"))).toBe("provider_auth");
    expect(voiceTrouble(new ApiError("u", 502, "no", "voice_provider"))).toBe("provider");
    expect(voiceTrouble(Object.assign(new Error("denied"), { name: "NotAllowedError" }))).toBe("mic");
    expect(voiceTrouble(new Error("?"))).toBe("failed");
  });

  it("hands each tool's parameters on as the contract's request", () => {
    expect(toolRequest("ask_assistant", { text: "merge PR 34", confirmed: true })).toEqual({ tool: "ask_assistant", text: "merge PR 34", confirmed: true });
    expect(toolRequest("ask_assistant", { text: "check CI" })).toEqual({ tool: "ask_assistant", text: "check CI" });
    expect(toolRequest("sessions", { machine: "macbook-pro" })).toEqual({ tool: "sessions", machine: "macbook-pro" });
    expect(toolRequest("sessions", {})).toEqual({ tool: "sessions" });
    expect(toolRequest("last_result", undefined)).toEqual({ tool: "last_result" });
  });
});

describe("the voice call", () => {
  it("starts only when asked, with the token over WebRTC, every tool and the brief", async () => {
    const h = harness();
    h.voice.bind("raka-devs");
    await h.voice.refresh();
    expect(h.voice.getState().phase).toBe("idle");
    expect(h.sessions).toEqual([]);
    await h.voice.start();
    expect(h.sessions).toEqual([{}]);
    expect(h.options.conversationToken).toBe("tok");
    expect(h.options.connectionType).toBe("webrtc");
    expect(Object.keys(h.options.clientTools)).toEqual([...VOICE_TOOLS]);
    expect(h.updates).toEqual(["the brief"]);
    expect(h.voice.getState().phase).toBe("listening");
    h.options.onModeChange({ mode: "speaking" });
    expect(h.voice.getState().phase).toBe("speaking");
    h.options.onMessage({ message: "Ya, ada apa?", source: "ai", role: "agent", event_id: 1 });
    expect(h.voice.getState().captions.map((line) => [line.who, line.text])).toEqual([["agent", "Ya, ada apa?"]]);
  });

  it("does not start without a key, and says a refused mic", async () => {
    const h = harness({ status: status({ configured: false }) });
    h.voice.bind("local");
    await h.voice.refresh();
    expect(h.voice.getState().trouble).toBe("no_key");
    await h.voice.start();
    expect(h.sessions).toEqual([]);

    const mic = harness({ sdkError: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
    mic.voice.bind("local");
    await mic.voice.start();
    expect(mic.voice.getState()).toMatchObject({ phase: "idle", trouble: "mic" });
  });

  it("ends after its silence, and talk or a tool keeps it open", async () => {
    const h = harness();
    h.voice.bind("local");
    await h.voice.start();
    await h.advance((VOICE_SILENCE_SECONDS - 2) * 1000);
    h.options.onMessage({ message: "cek CI", source: "user", role: "user", event_id: 2 });
    expect(h.voice.getState().phase).toBe("thinking");
    await h.advance((VOICE_SILENCE_SECONDS - 2) * 1000);
    h.input = 0.4; // someone speaks, no transcript yet
    await h.advance(1000);
    h.input = 0;
    expect(h.ended).toBe(0);
    await h.advance(VOICE_SILENCE_SECONDS * 1000);
    expect(h.ended).toBe(1);
    expect(h.voice.getState().phase).toBe("idle");
  });

  it("keeps the call open while a risky ask waits for the user's OK, then the task works and is polled", async () => {
    const h = harness();
    h.voice.bind("local");
    await h.voice.start();
    h.toolAnswer = (request) => request.tool === "ask_assistant" && !request.confirmed
      ? { result: "Read it back and ask", needs_confirmation: true }
      : { result: "Sent", task: task("t1") };
    expect(await h.options.clientTools.ask_assistant({ text: "merge PR 34" })).toBe("Read it back and ask");
    expect(h.voice.getState().tasks).toMatchObject([{ text: "merge PR 34", waiting: true }]);
    expect(h.timers(POLL_MS)).toBe(0);
    await h.advance(VOICE_SILENCE_SECONDS * 3000);
    expect(h.ended).toBe(0);

    expect(await h.options.clientTools.ask_assistant({ text: "merge PR 34", confirmed: true })).toBe("Sent");
    expect(h.tools.at(-1)).toEqual({ tool: "ask_assistant", text: "merge PR 34", confirmed: true });
    expect(h.voice.getState().tasks).toMatchObject([{ id: "t1", state: "working", waiting: false }]);
    expect(h.timers(POLL_MS)).toBe(1);
    h.status = status({}, [task("t1")], "working");
    await h.advance(VOICE_SILENCE_SECONDS * 1000);
    expect(h.ended).toBe(1);
  });

  it("polls only while a task works; a finished one chimes and waits for a tap outside Voice", async () => {
    const h = harness();
    h.voice.bind("raka-devs");
    await h.voice.start();
    h.toolAnswer = () => ({ result: "Sent", task: task("t1") });
    await h.options.clientTools.ask_assistant({ text: "check CI" });
    h.voice.end();
    h.voice.setVoiceShown(false);
    h.status = status({}, [task("t1")], "working");
    await h.advance(POLL_MS);
    expect(h.statusReads.length).toBe(2); // the bind's read, then one poll
    expect(h.voice.getState().tasks[0]?.state).toBe("working");
    h.status = status({}, [task("t1", "done", "CI is green, merged.")]);
    await h.advance(POLL_MS);
    expect(h.voice.getState().tasks[0]?.state).toBe("done");
    expect(h.chimes.length).toBe(1);
    expect(h.voice.getState().result?.id).toBe("t1");
    expect(h.timers(POLL_MS)).toBe(0);
    await h.advance(POLL_MS * 3);
    expect(h.statusReads.length).toBe(3);
    expect(h.sessions).toEqual([{}]);

    h.voice.hear();
    await h.settle();
    expect(h.sessions.at(-1)).toEqual({ result_task_id: "t1" });
    expect(h.voice.getState().result).toBeNull();
  });

  it("opens the result call by itself on the Voice screen, and ends it after the follow-up silence", async () => {
    const h = harness({ result: { task_id: "t1", text: "CI is green." } });
    h.voice.bind("local");
    h.status = status({}, [task("t1")], "working");
    await h.voice.refresh();
    h.voice.setVoiceShown(true);
    expect(h.timers(POLL_MS)).toBe(1);
    h.status = status({}, [task("t1", "done", "CI is green.")]);
    await h.advance(POLL_MS);
    expect(h.chimes.length).toBe(1);
    expect(h.sessions).toEqual([{ result_task_id: "t1" }]);
    expect(h.updates).toEqual(["the brief", expect.stringContaining("CI is green.")]);
    await h.advance((VOICE_FOLLOW_UP_SECONDS - 3) * 1000);
    expect(h.ended).toBe(0);
    await h.advance(4000);
    expect(h.ended).toBe(1);
  });
});
