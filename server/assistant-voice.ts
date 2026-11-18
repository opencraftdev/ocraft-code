/**
 * The Assistant's voice mode on the VM (docs/plan/20261115-1240-assistant-voice.md, wire contract
 * shared/assistant-voice.ts): the ElevenLabs agent "Nara" kept in step with the profile's VOICE.md,
 * a short-lived conversation token per call, and the persona's client tools, which the page runs and
 * this server answers. The ElevenLabs key stays in stateDir/assistant/voice.json (or
 * ELEVENLABS_API_KEY): no answer, log line or error here ever carries it.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionGraph } from "../shared/assistant.ts";
import { VOICE_MARKER, type VoiceSessionResponse, type VoiceStatus, type VoiceTask, type VoiceToolResponse } from "../shared/assistant-voice.ts";
import { firstMessageFault } from "../shared/launch-rules.ts";
import type { AgentStatus, ConversationResponse } from "../shared/protocol.ts";
import { logDay, VOICE } from "./assistant-sessions.ts";
import { paneConversation } from "./conversation.ts";
import { isJsonObject } from "./http.ts";
import { writePrivateState } from "./private-state.ts";
import { readStateDocument } from "./state-document.ts";

const BASE = "https://api.elevenlabs.io";
const TASKS_KEPT = 20;
const RESULT_CHARS = 4000;
/** a task whose working state was never heard (missed, or before a restart) ends when the pane rests this long after its send */
const UNHEARD_DONE_MS = 30_000;
const AT_REST: readonly (AgentStatus | null)[] = ["idle", "done"];

export class VoiceError extends Error {
  /** `upstream`: the HTTP status ElevenLabs answered, when it answered one */
  constructor(readonly code: string, message: string, readonly status: number, readonly upstream?: number) { super(message); }
}

/** An ask that changes things outside, which Nara must read back and the user confirm (Indonesian and English). */
export function riskyAsk(text: string): boolean {
  return /^\s*email\b|\b(?:merge|gabung\w*|squash|approve|land\s+(?:it|the\s+pr|pr)|drop\s+(?:\S+\s+){0,2}(?:branch|table|database|db|stash|pr)|kirim\s+(?:\S+\s+){0,2}ke|push|delete|hapus|remove|kill|reset|force|deploy|release|publish|rebase|(?:close|tutup)\s+(?:\S+\s+){0,3}(?:session|sesi|pane|workspace|pr|issue)|(?:send|kirim|kirimin|kabari|kabarin|email|message|reply|balas)\s+(?:\S+\s+){0,3}(?:message|pesan|email|chat|wa|whatsapp|slack|dm))\b/i.test(text);
}

/** the newest tasks stay in the status after they finish, so a page polling for one reads its reply */
const RECENT_DONE = 5;

const validTask = (value: unknown): value is VoiceTask => isJsonObject(value)
  && typeof value.id === "string" && typeof value.text === "string" && typeof value.sent_at === "number"
  && (value.state === "working" || value.state === "done") && (value.result === null || typeof value.result === "string");

/** voice.json: `tool_ids`/`tools_hash` are the three client tools created for the agent */
interface VoiceConfig { api_key?: string; agent_id?: string; voice_id?: string; synced_hash?: string; tool_ids?: string[]; tools_hash?: string; tools_partial?: string }
const validConfig = (value: unknown): value is VoiceConfig => isJsonObject(value)
  && ["api_key", "agent_id", "voice_id", "synced_hash", "tools_hash", "tools_partial"].every((key) => value[key] === undefined || typeof value[key] === "string")
  && (value.tool_ids === undefined || (Array.isArray(value.tool_ids) && value.tool_ids.every((id) => typeof id === "string")));

/**
 * The client tools (https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools and
 * POST /v1/convai/tools, https://elevenlabs.io/docs/api-reference/tools/create): `tool_config` with
 * type "client", name, description, a JSON-schema `parameters`, and `expects_response` so the agent
 * waits for this server's answer.
 */
const TOOL_CONFIGS = [
  { type: "client", name: "ask_assistant", expects_response: true, response_timeout_secs: 20,
    description: "Hand real work to the Assistant (Claude on the user's VM): anything to check, change, run, open or send. A risky ask (merge, push, delete, close a session, send a message to someone) needs confirmed=true after the user said yes.",
    parameters: { type: "object", required: ["text"], properties: {
      text: { type: "string", description: "What the user wants, in one clear sentence" },
      confirmed: { type: "boolean", description: "The user said yes after you read a risky ask back" },
    } } },
  { type: "client", name: "sessions", expects_response: true, response_timeout_secs: 20,
    description: "What runs where: the agent sessions open on the user's machines, optionally one machine.",
    parameters: { type: "object", required: [], properties: { machine: { type: "string", description: "A machine's name; leave out for every machine" } } } },
  { type: "client", name: "last_result", expects_response: true, response_timeout_secs: 20,
    description: "The Assistant's latest finished reply to a voice request.",
    parameters: { type: "object", required: [], properties: {} } },
];

const TOOL_USE = `

## Tools

- ask_assistant(text, confirmed?): hands work to the Assistant. If it answers needs_confirmation,
  read the ask back in one sentence, wait for yes, then call it again with confirmed=true.
- sessions(machine?): what runs where, answered at once.
- last_result(): the Assistant's latest finished reply.
At the start you get a brief about the user, their machines and the Assistant's state: use it, do
not read it out.`;

/** ElevenLabs' documented example voice (agents/create), used until voice.json names one */
const DEFAULT_VOICE_ID = "cjVigY5qzO86Huf0OWal";

/** the persona's name: VOICE.md's first heading */
export const personaName = (voice: string): string => voice.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Nara";

/**
 * The agent, as POST /v1/convai/agents/create takes it and PATCH /v1/convai/agents/{agent_id}
 * patches it (https://elevenlabs.io/docs/api-reference/agents/create, .../agents/update):
 * conversation_config.agent { first_message, language, prompt { prompt, llm, tool_ids,
 * built_in_tools.language_detection } }, conversation_config.language_presets (per language code,
 * `overrides.agent.first_message`, https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection),
 * conversation_config.tts { model_id, voice_id }. eleven_flash_v2_5: the multilingual low-latency TTS.
 */
export function agentBody(voice: string, voiceId: string, toolIds: string[]): unknown {
  return {
    name: `${personaName(voice)} (Ovis Assistant)`,
    conversation_config: {
      agent: {
        first_message: "Ya, ada apa?",
        language: "id",
        prompt: {
          prompt: `${voice.trim()}${TOOL_USE}`,
          llm: "gemini-2.5-flash",
          tool_ids: toolIds,
          built_in_tools: { language_detection: { name: "language_detection", description: "", params: { system_tool_type: "language_detection" } } },
        },
      },
      language_presets: { en: { overrides: { agent: { first_message: "Yes, what's up?" } } } },
      tts: { model_id: "eleven_flash_v2_5", voice_id: voiceId },
    },
  };
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** the provider's words without the key they may quote back */
const scrub = (message: string, key: string): string => (key ? message.split(key).join("***") : message).slice(0, 500);

/** what the voice mode needs of the Assistant's session: AssistantSession on the VM, FolderAssistant elsewhere */
export interface VoiceSession {
  readonly folder: string;
  readonly profile: string;
  readonly codexHome: string | undefined;
  paneNow(): Promise<{ paneId: string; status: AgentStatus | null } | null>;
  info(): { pane_id: string | null } | null;
  sendToPane(paneId: string, text: string): Promise<void>;
}

/** what the voice mode needs of the Assistant (server/assistant.ts) */
export interface VoiceSources {
  session: VoiceSession | null;
  graph: { build(): SessionGraph };
}
export interface VoiceOptions {
  /** the ElevenLabs API; tests pass a fake, nothing here ever reaches the real one in a test */
  fetch?: typeof fetch;
  /** the Assistant pane's conversation; unset, read from its transcript */
  conversation?: (paneId: string, codexHome?: string) => Promise<ConversationResponse>;
  now?: () => number;
}

export class AssistantVoice {
  private configPath: string;
  private tasksPath: string;
  private tasks: VoiceTask[];
  /** tasks whose working state was heard after their send */
  private worked = new Set<string>();
  private syncing: Promise<string> = Promise.resolve("");
  private fetch: typeof fetch;
  private conversation: (paneId: string, codexHome?: string) => Promise<ConversationResponse>;
  private now: () => number;

  constructor(stateDir: string, private sources: VoiceSources, options: VoiceOptions = {}) {
    this.configPath = join(stateDir, "assistant", "voice.json");
    this.tasksPath = join(stateDir, "assistant", "voice-tasks.json");
    this.fetch = options.fetch ?? fetch;
    this.conversation = options.conversation ?? ((paneId, codexHome) => paneConversation(paneId, codexHome));
    this.now = options.now ?? Date.now;
    const read = readStateDocument(this.tasksPath);
    // a damaged entry is dropped, so one bad line never stops every status
    this.tasks = read.kind === "json" && Array.isArray(read.value) ? read.value.filter(validTask) : [];
  }

  private config(): VoiceConfig {
    const read = readStateDocument(this.configPath);
    return read.kind === "json" && validConfig(read.value) ? read.value : {};
  }
  private key(): string { return this.config().api_key || process.env["ELEVENLABS_API_KEY"] || ""; }
  private profileDir(): string | null {
    const session = this.sources.session;
    return session && join(session.folder, "profiles", session.profile);
  }
  private voice(): string {
    const dir = this.profileDir();
    try { return dir && existsSync(join(dir, "VOICE.md")) ? readFileSync(join(dir, "VOICE.md"), "utf8") : VOICE; } catch { return VOICE; }
  }

  /** One ElevenLabs call: its JSON answer, or a VoiceError whose message holds no key. */
  private async call(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<Record<string, unknown>> {
    const key = this.key();
    if (!key) throw new VoiceError("voice_not_configured", "Voice needs an ElevenLabs key on the Assistant VM", 409);
    let response: Response;
    try {
      response = await this.fetch(`${BASE}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "xi-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new VoiceError("voice_provider", scrub(`Could not reach ElevenLabs: ${error instanceof Error ? error.message : String(error)}`, key), 502);
    }
    if (!response.ok) {
      // scrubbed whole, then cut: a cut first could leave part of a quoted key unmatched
      const detail = scrub((await response.text().catch(() => "")).trim(), key).slice(0, 300);
      throw new VoiceError(response.status === 401 || response.status === 403 ? "voice_provider_auth" : "voice_provider", `ElevenLabs answered ${response.status}${detail ? `: ${detail}` : ""}`, 502, response.status);
    }
    const answer = await response.json().catch(() => null);
    return isJsonObject(answer) ? answer : {};
  }

  /** The agent as VOICE.md and the tools say now: created once, patched when they changed, else left. Its id. One sync at a time. */
  sync(): Promise<string> {
    const run = this.syncing.catch(() => "").then(() => this.syncNow());
    this.syncing = run;
    return run;
  }

  private async syncNow(): Promise<string> {
    let config = this.config();
    const save = (next: VoiceConfig) => { writePrivateState(this.configPath, next); config = next; };
    const toolsHash = hash(TOOL_CONFIGS);
    if (!config.tool_ids || config.tools_hash !== toolsHash) {
      // ponytail: tools of an earlier tool config are left on the account, unused; delete them if they ever pile up
      // each id is kept as it is made (`tools_partial`), so a failure part way creates only the rest next time
      const ids: string[] = config.tools_partial === toolsHash ? [...(config.tool_ids ?? [])] : [];
      for (const tool_config of TOOL_CONFIGS.slice(ids.length)) {
        const created = await this.call("/v1/convai/tools", "POST", { tool_config });
        if (typeof created.id !== "string") throw new VoiceError("voice_provider", "ElevenLabs created a tool without an id", 502);
        ids.push(created.id);
        save({ ...this.config(), tool_ids: [...ids], tools_partial: toolsHash });
      }
      const { tools_partial: _done, ...rest } = this.config();
      save({ ...rest, tool_ids: ids, tools_hash: toolsHash });
    }
    const body = agentBody(this.voice(), config.voice_id || DEFAULT_VOICE_ID, config.tool_ids!);
    const synced = hash(body);
    if (!config.agent_id) {
      const created = await this.call("/v1/convai/agents/create", "POST", body);
      if (typeof created.agent_id !== "string") throw new VoiceError("voice_provider", "ElevenLabs created an agent without an id", 502);
      save({ ...this.config(), agent_id: created.agent_id, synced_hash: synced });
    } else if (config.synced_hash !== synced) {
      try {
        await this.call(`/v1/convai/agents/${encodeURIComponent(config.agent_id)}`, "PATCH", body);
      } catch (error) {
        // the agent was deleted on ElevenLabs: made again rather than failing for good
        if (!(error instanceof VoiceError && error.upstream === 404)) throw error;
        this.forgetAgent();
        return this.syncNow();
      }
      save({ ...this.config(), synced_hash: synced });
    }
    return config.agent_id!;
  }

  /** the stored agent is gone on ElevenLabs: the next sync creates a new one */
  private forgetAgent(): void {
    const { agent_id: _agent, synced_hash: _hash, ...rest } = this.config();
    writePrivateState(this.configPath, rest);
  }

  private async paneState(): Promise<{ paneId: string; status: AgentStatus | null } | null> {
    return await this.sources.session?.paneNow() ?? null;
  }

  async status(): Promise<VoiceStatus> {
    const pane = await this.paneState();
    // a task whose working was never heard: done once the pane rests well after its send
    if (pane && AT_REST.includes(pane.status) && this.tasks.some((task) => task.state === "working" && this.now() - task.sent_at > UNHEARD_DONE_MS)) {
      await this.finish(pane.paneId, (task) => this.now() - task.sent_at > UNHEARD_DONE_MS);
    }
    return {
      configured: this.key() !== "",
      persona: personaName(this.voice()),
      // ElevenLabs' GET /v1/user/subscription (https://elevenlabs.io/docs/api-reference/user/subscription/get)
      // counts characters (credits), not agent minutes: no clean minutes number, so none is invented
      minutes: null,
      assistant: { state: (["idle", "working", "blocked", "done"] as const).find((state) => state === pane?.status) ?? "unknown", pending: this.tasks.filter((task, index) => task.state === "working" || index >= this.tasks.length - RECENT_DONE) },
    };
  }

  /** The Assistant's pane state as herdr reports it: a working task that was worked on is done when the pane comes to rest. */
  heard(paneId: string, status: AgentStatus): void {
    if (paneId !== this.sources.session?.info()?.pane_id) return;
    const working = this.tasks.filter((task) => task.state === "working");
    if (status === "working") for (const task of working) this.worked.add(task.id);
    else if (AT_REST.includes(status) && working.some((task) => this.worked.has(task.id))) void this.finish(paneId, (task) => this.worked.has(task.id));
  }

  // ponytail: every finished task takes the same latest reply; one reply per task if voice asks ever queue up
  private async finish(paneId: string, which: (task: VoiceTask) => boolean): Promise<void> {
    const ending = this.tasks.filter((task) => task.state === "working" && which(task));
    if (ending.length === 0) return;
    let result = "The Assistant finished, but its reply could not be read.";
    try {
      const turns = (await this.conversation(paneId, this.sources.session?.codexHome)).turns;
      const last = [...turns].reverse().find((turn) => turn.role === "assistant");
      const text = last?.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n").trim();
      if (text) result = text.slice(0, RESULT_CHARS);
    } catch { /* the fixed sentence above */ }
    for (const task of ending) { task.state = "done"; task.result = result; this.worked.delete(task.id); }
    this.save();
  }

  private save(): void {
    this.tasks = this.tasks.slice(-TASKS_KEPT);
    try { writePrivateState(this.tasksPath, this.tasks); } catch (error) { console.error(`Assistant voice tasks: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async session(body: unknown): Promise<VoiceSessionResponse> {
    if (!this.key()) throw new VoiceError("voice_not_configured", "Voice needs an ElevenLabs key on the Assistant VM", 409);
    let agentId = await this.sync();
    const tokenFor = (id: string) => this.call(`/v1/convai/conversation/token?agent_id=${encodeURIComponent(id)}`, "GET");
    let answer: Record<string, unknown>;
    try {
      answer = await tokenFor(agentId);
    } catch (error) {
      // the agent was deleted on ElevenLabs: made again once
      if (!(error instanceof VoiceError && error.upstream === 404)) throw error;
      this.forgetAgent();
      agentId = await this.sync();
      answer = await tokenFor(agentId);
    }
    const token = answer.token;
    if (typeof token !== "string") throw new VoiceError("voice_provider", "ElevenLabs gave no conversation token", 502);
    const askedTask = isJsonObject(body) && typeof body.result_task_id === "string" ? body.result_task_id : undefined;
    const task = askedTask === undefined ? undefined : this.tasks.find((candidate) => candidate.id === askedTask && candidate.state === "done");
    return {
      conversation_token: token, agent_id: agentId, persona: personaName(this.voice()), brief: await this.brief(),
      ...(task ? { result: { task_id: task.id, text: task.result ?? "" } } : {}),
    };
  }

  /** a few lines for the persona: the user (PROFILE.md's first lines), the machines and their sessions, the Assistant's state */
  private async brief(): Promise<string> {
    const dir = this.profileDir();
    let profile: string[] = [];
    try { if (dir) profile = readFileSync(join(dir, "PROFILE.md"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")).slice(0, 8); } catch { /* none yet */ }
    const graph = this.sources.graph.build();
    const machines = graph.machines.map((machine) => `${machine.name} (${graph.sessions.filter((session) => session.machine === machine.name).length} sessions)`);
    const pane = await this.paneState();
    const pending = this.tasks.filter((task) => task.state === "working").map((task) => task.text);
    return [
      ...(profile.length ? ["About the user:", ...profile] : []),
      `Machines: ${machines.join(", ") || "none connected"}`,
      `Assistant: ${pane?.status ?? "unknown"}${pending.length ? `, working on: ${pending.join("; ")}` : ""}`,
    ].join("\n");
  }

  async tool(body: unknown): Promise<VoiceToolResponse> {
    if (!isJsonObject(body)) throw new VoiceError("invalid_body", "Expected a tool and its parameters", 400);
    switch (body.tool) {
      case "ask_assistant": return this.ask(body.text, body.confirmed === true);
      case "sessions": return { result: this.sessionsSummary(typeof body.machine === "string" && body.machine.trim() ? body.machine.trim() : undefined) };
      case "last_result": {
        const done = this.tasks.filter((task) => task.state === "done").at(-1);
        return { result: done?.result ?? "No finished task yet." };
      }
      default: throw new VoiceError("unknown_tool", "The tool is ask_assistant, sessions or last_result", 400);
    }
  }

  private async ask(value: unknown, confirmed: boolean): Promise<VoiceToolResponse> {
    const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    const message = `${VOICE_MARKER} ${text}`;
    if (!text || firstMessageFault(message, true) !== null) throw new VoiceError("invalid_text", "An ask is plain text of at most 20000 characters", 400);
    if (riskyAsk(text) && !confirmed) return { result: "Read it back to the user and ask for a yes before sending.", needs_confirmation: true };
    const pane = await this.paneState();
    if (!pane) throw new VoiceError("assistant_not_running", "The Assistant is not running right now", 409);
    if (pane.status === "blocked") throw new VoiceError("assistant_prompt", "The Assistant waits on a prompt: answer it in the chat first", 409);
    await this.sources.session!.sendToPane(pane.paneId, message);
    const task: VoiceTask = { id: randomUUID(), text, sent_at: this.now(), state: "working", result: null };
    this.tasks.push(task);
    this.save();
    this.log(text);
    return { result: "Sent to the Assistant; it is working on it.", task };
  }

  /** one line in the profile's daily log, append only */
  private log(text: string): void {
    const dir = this.profileDir();
    if (!dir) return;
    const at = new Date(this.now());
    try {
      mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, "logs", `${logDay(at.getTime())}.md`), `- ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} voice: ${text}\n`);
    } catch (error) { console.error(`Assistant voice log: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** the graph as a few spoken-friendly lines, never its JSON */
  private sessionsSummary(machine?: string): string {
    const graph = this.sources.graph.build();
    const wanted = machine?.toLowerCase();
    const machines = graph.machines.filter((candidate) => wanted === undefined || candidate.name.toLowerCase() === wanted || candidate.host?.toLowerCase() === wanted);
    if (machines.length === 0) return `No machine is named ${machine}. The machines are: ${graph.machines.map((candidate) => candidate.name).join(", ") || "none"}.`;
    return machines.map((candidate) => {
      const sessions = graph.sessions.filter((session) => session.machine === candidate.name);
      return [`${candidate.name} (${candidate.state}): ${sessions.length} session${sessions.length === 1 ? "" : "s"}`, ...sessions.map((session) => `- ${[
        session.agent, session.state ?? "unknown", session.folder ?? "no folder",
        ...(session.branch ? [`branch ${session.branch}`] : []),
        ...session.prs.map((pr) => `PR #${pr.number} ${pr.state}`),
      ].join(", ")}`)].join("\n");
    }).join("\n");
  }
}
