import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionGraph } from "../shared/assistant.ts";
import type { VoiceSessionResponse, VoiceStatus, VoiceToolResponse } from "../shared/assistant-voice.ts";
import type { AgentStatus, ConversationResponse } from "../shared/protocol.ts";
import { type AssistantPanes, type AssistantSession, VOICE, writeAgentFolder } from "./assistant-sessions.ts";
import { AssistantVoice, riskyAsk } from "./assistant-voice.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

const KEY = "sk_test_never_shown_0123456789";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), "ovis-voice-")); roots.push(root); return root; };

/** a fake ElevenLabs API: records each call, answers by path; never the network */
function fakeElevenLabs(fail?: { status: number }) {
  const calls: { method: string; path: string; key: string | null; body: unknown }[] = [];
  let tools = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, key: new Headers(init?.headers).get("xi-api-key"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.origin !== "https://api.elevenlabs.io") throw new Error("not ElevenLabs");
    // a provider that quotes the key back
    if (fail) return new Response(JSON.stringify({ detail: `invalid key ${KEY}` }), { status: fail.status });
    if (url.pathname === "/v1/convai/tools") return Response.json({ id: `tool_${++tools}` });
    if (url.pathname === "/v1/convai/agents/create") return Response.json({ agent_id: "agent_1" });
    if (url.pathname === "/v1/convai/agents/agent_1" && method === "PATCH") return Response.json({ agent_id: "agent_1" });
    if (url.pathname === "/v1/convai/conversation/token") return Response.json({ token: "conv_token", conversation_id: "c1" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetcher };
}

const conversation = (text: string): ConversationResponse => ({ source: "claude-transcript", turns: [
  { role: "user", ts: null, parts: [{ kind: "text", text: "[voice] check CI" }] },
  { role: "assistant", ts: null, parts: [{ kind: "text", text }] },
] } as ConversationResponse);

const GRAPH: SessionGraph = {
  updated_at: 0,
  machines: [{ name: "mac", id: "m1", host: "mac", state: "connected" }, { name: "vm", id: "m2", host: "raka-devs", state: "connected" }],
  projects: [],
  sessions: [{
    key: "mac/p1", machine: "mac", host: "mac", workspace: "ovis", pane: "p1", agent: "claude", state: "working", title: null, folder: "/home/u/ovis",
    repo_root: "/home/u/ovis", branch: "feat/voice", head: null, remote: null, prs: [{ number: 34, url: "u", title: "t", state: "OPEN" }],
    files: { changed: [], touched: [] }, assistant_opened: false, seen_at: null,
  }],
};

/** the Assistant's session as the voice mode sees it: its folder, profile and pane */
function fakeSession(folder: string, status: { now: AgentStatus | null }) {
  const sent: string[] = [];
  const session = {
    folder, profile: "assistant", codexHome: undefined, info: () => ({ pane_id: "w1:p1" }),
    paneNow: async () => ({ paneId: "w1:p1", status: status.now }),
    sendToPane: async (_pane: string, text: string) => { sent.push(text); },
  } as unknown as AssistantSession;
  return { session, sent };
}

function voiceFixture(options: { key?: boolean; fail?: { status: number }; reply?: string } = {}) {
  const stateDir = tempRoot();
  const folder = join(stateDir, "assistant", "agent");
  writeAgentFolder(folder);
  if (options.key !== false) writeFileSync(join(stateDir, "assistant", "voice.json"), JSON.stringify({ api_key: KEY }));
  const api = fakeElevenLabs(options.fail);
  const status = { now: "idle" as AgentStatus | null };
  const { session, sent } = fakeSession(folder, status);
  let now = Date.UTC(2026, 10, 15, 3, 4);
  const voice = new AssistantVoice(stateDir, { session, graph: { build: () => GRAPH } }, {
    fetch: api.fetch, conversation: async () => conversation(options.reply ?? "CI is green and PR 34 is merged."), now: () => now,
  });
  return { stateDir, folder, voice, api, status, sent, advance: (ms: number) => { now += ms; } };
}

describe("risky asks", () => {
  it("are caught in English and Indonesian", () => {
    for (const text of ["merge PR 34", "push the branch", "delete the old worktree", "hapus branch lama", "remove that file", "close the ovis session",
      "tutup sesi di macbook", "kill the dev server", "reset main", "force it", "deploy to the VM", "send a message to Dion", "kirim pesan ke Trina",
      "send Dion a message", "kabarin Depras lewat wa", "tutup PR 12", "close the PR", "release v1.2", "message Dion on slack"]) {
      expect({ text, risky: riskyAsk(text) }).toEqual({ text, risky: true });
    }
    for (const text of ["cek CI di ovis", "what's running on the mac?", "summarize PR 34", "buka sesi baru di ovis", "jalankan test",
      "summarize the message from Dion", "apa isi pesan terakhir?", "pushover notifications docs"]) {
      expect({ text, risky: riskyAsk(text) }).toEqual({ text, risky: false });
    }
  });
});

describe("the voice persona file", () => {
  it("is seeded once and never overwritten", () => {
    const folder = join(tempRoot(), "agent");
    writeAgentFolder(folder);
    const path = join(folder, "profiles", "assistant", "VOICE.md");
    expect(readFileSync(path, "utf8")).toBe(VOICE);
    writeFileSync(path, "# Sari\nmy own words\n");
    writeAgentFolder(folder);
    expect(readFileSync(path, "utf8")).toBe("# Sari\nmy own words\n");
  });
});

describe("the ElevenLabs agent", () => {
  it("is created once, patched only when VOICE.md changes, and the key goes only in its header", async () => {
    const { stateDir, folder, voice, api } = voiceFixture();
    const first = await voice.session({});
    expect(first).toEqual({ conversation_token: "conv_token", agent_id: "agent_1", persona: "Nara", brief: expect.any(String) });
    expect(api.calls.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual([
      "POST /v1/convai/tools", "POST /v1/convai/tools", "POST /v1/convai/tools", "POST /v1/convai/agents/create", "GET /v1/convai/conversation/token",
    ]);
    expect(api.calls.every((call) => call.key === KEY)).toBe(true);
    expect(api.calls.map((call) => call.body).filter(Boolean).map((body) => (body as { tool_config?: { name: string } }).tool_config?.name).filter(Boolean)).toEqual(["ask_assistant", "sessions", "last_result"]);
    const created = api.calls[3]!.body as { conversation_config: { agent: { prompt: { prompt: string; tool_ids: string[] } } } };
    expect(created.conversation_config.agent.prompt.tool_ids).toEqual(["tool_1", "tool_2", "tool_3"]);
    expect(created.conversation_config.agent.prompt.prompt).toContain("You are Nara");
    expect(api.calls[4]!.path).toBe("/v1/convai/conversation/token?agent_id=agent_1");

    api.calls.length = 0;
    await voice.session({});
    expect(api.calls.map((call) => call.method)).toEqual(["GET"]);

    writeFileSync(join(folder, "profiles", "assistant", "VOICE.md"), "# Sari\nShorter.\n");
    api.calls.length = 0;
    expect((await voice.session({})).persona).toBe("Sari");
    expect(api.calls.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual(["PATCH /v1/convai/agents/agent_1", "GET /v1/convai/conversation/token"]);

    const stored = JSON.parse(readFileSync(join(stateDir, "assistant", "voice.json"), "utf8"));
    expect(stored).toMatchObject({ api_key: KEY, agent_id: "agent_1", tool_ids: ["tool_1", "tool_2", "tool_3"], synced_hash: expect.any(String) });
    expect(statSync(join(stateDir, "assistant", "voice.json")).mode & 0o777).toBe(0o600);
  });

  it("tells a refused key and a provider failure apart, without the key", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [status, code] of [[401, "voice_provider_auth"], [500, "voice_provider"]] as const) {
        const { voice } = voiceFixture({ fail: { status } });
        const thrown = await voice.session({}).then(() => null, (error: unknown) => error as { code: string; status: number; message: string });
        expect(thrown).toMatchObject({ code, status: 502 });
        expect(thrown!.message).not.toContain(KEY);
        expect(thrown!.message).toContain("***");
      }
      expect(errors.mock.calls.flat().join(" ")).not.toContain(KEY);
    } finally { errors.mockRestore(); }
  });
});

describe("the persona's tools", () => {
  it("sends one marked message to the Assistant's pane, refuses a risky ask until confirmed, and logs each send", async () => {
    const { voice, sent, folder } = voiceFixture();
    const plain = await voice.tool({ tool: "ask_assistant", text: "cek CI di ovis" });
    expect(sent).toEqual(["[voice] cek CI di ovis"]);
    expect(plain.task).toMatchObject({ text: "cek CI di ovis", state: "working", result: null });

    const risky = await voice.tool({ tool: "ask_assistant", text: "merge PR 34" });
    expect(risky).toEqual({ result: "Read it back to the user and ask for a yes before sending.", needs_confirmation: true });
    expect(sent).toHaveLength(1);
    await voice.tool({ tool: "ask_assistant", text: "merge PR 34", confirmed: true });
    expect(sent).toEqual(["[voice] cek CI di ovis", "[voice] merge PR 34"]);

    const day = new Date(Date.UTC(2026, 10, 15, 3, 4));
    const log = readFileSync(join(folder, "profiles", "assistant", "logs", `${day.getFullYear()}-11-${String(day.getDate()).padStart(2, "0")}.md`), "utf8");
    const time = `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
    expect(log).toBe(`- ${time} voice: cek CI di ovis\n- ${time} voice: merge PR 34\n`);
    await expect(voice.tool({ tool: "ask_assistant", text: "a\u001b[2Jb" })).rejects.toMatchObject({ code: "invalid_text" });
  });

  it("refuses a send while the Assistant's pane is not running or waits on a prompt", async () => {
    const { voice, status, sent } = voiceFixture();
    status.now = "blocked";
    await expect(voice.tool({ tool: "ask_assistant", text: "cek CI" })).rejects.toMatchObject({ code: "assistant_prompt", status: 409 });
    const stopped = new AssistantVoice(tempRoot(), { session: null, graph: { build: () => GRAPH } }, { fetch: fakeElevenLabs().fetch });
    await expect(stopped.tool({ tool: "ask_assistant", text: "cek CI" })).rejects.toMatchObject({ code: "assistant_not_running", status: 409 });
    expect(sent).toEqual([]);
  });

  it("finishes a task when the pane comes to rest after working, with the Assistant's reply", async () => {
    const { voice, stateDir } = voiceFixture();
    expect((await voice.tool({ tool: "last_result" })).result).toBe("No finished task yet.");
    const { task } = await voice.tool({ tool: "ask_assistant", text: "cek CI di ovis" }) as Required<VoiceToolResponse>;
    voice.heard("w1:p1", "idle");
    expect((await voice.status()).assistant.pending.map((pending) => pending.id)).toEqual([task.id]);
    voice.heard("other:pane", "working");
    voice.heard("w1:p1", "working");
    voice.heard("w1:p1", "done");
    const deadline = Date.now() + 2000;
    while ((await voice.status()).assistant.pending.length > 0 && Date.now() < deadline) await Bun.sleep(5);
    expect((await voice.tool({ tool: "last_result" })).result).toBe("CI is green and PR 34 is merged.");
    const stored = JSON.parse(readFileSync(join(stateDir, "assistant", "voice-tasks.json"), "utf8"));
    expect(stored).toEqual([{ ...task, state: "done", result: "CI is green and PR 34 is merged." }]);
    expect(statSync(join(stateDir, "assistant", "voice-tasks.json")).mode & 0o777).toBe(0o600);
    const reopened = await voice.session({ result_task_id: task.id });
    expect(reopened.result).toEqual({ task_id: task.id, text: "CI is green and PR 34 is merged." });
  });

  it("summarizes the session graph in plain lines, for one machine or all", async () => {
    const { voice } = voiceFixture();
    const all = (await voice.tool({ tool: "sessions" })).result;
    expect(all).toBe("mac (connected): 1 session\n- claude, working, /home/u/ovis, branch feat/voice, PR #34 OPEN\nvm (connected): 0 sessions");
    expect((await voice.tool({ tool: "sessions", machine: "raka-devs" })).result).toBe("vm (connected): 0 sessions");
    expect((await voice.tool({ tool: "sessions", machine: "nowhere" })).result).toBe("No machine is named nowhere. The machines are: mac, vm.");
  });

  it("briefs the persona with the user, the machines and the Assistant's state", async () => {
    const { voice, folder } = voiceFixture();
    writeFileSync(join(folder, "profiles", "assistant", "PROFILE.md"), "# Profile\n\nName: Raka\nPrefers Indonesian\n");
    await voice.tool({ tool: "ask_assistant", text: "cek CI" });
    expect((await voice.session({})).brief).toBe("About the user:\nName: Raka\nPrefers Indonesian\nMachines: mac (1 sessions), vm (0 sessions)\nAssistant: idle, working on: cek CI");
  });
});

const PROFILE: HerdrMachineProfile = { id: "voice-test", label: "Test PC", enabled: true, target: { destination: "voice-test.invalid" } };
const panes: AssistantPanes = {
  open: async () => ({ paneId: "w1:p1", workspaceId: "w1" }), start: async () => undefined, pane: async () => ({ agent: "claude", status: "idle" }),
  context: async () => null, send: async () => undefined, close: async () => undefined,
};

describe("the voice routes", () => {
  it("answer only on the Assistant VM", async () => {
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: tempRoot(), tailscaleOwner: null, assistant: false });
    try {
      expect((await fetch(`http://127.0.0.1:${app.port}/api/assistant/voice/status`)).status).toBe(404);
    } finally { app.stop(); }
  });

  it("take a page's Origin or the bridge token, never an origin-less POST, and never show the key", async () => {
    const stateDir = tempRoot();
    mkdirSync(join(stateDir, "assistant"), { recursive: true });
    const api = fakeElevenLabs();
    const errors = spyOn(console, "error");
    const app = createServer({
      port: 0, hostname: "127.0.0.1", token: "", bridgeToken: "bridge-secret", stateDir, tailscaleOwner: null, assistant: true,
      assistantRun: async () => "", assistantPanes: panes, herdrProfiles: async () => [PROFILE], assistantVoice: { fetch: api.fetch, conversation: async () => conversation("ok") },
    });
    const base = `http://127.0.0.1:${app.port}/api/assistant/voice`;
    const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      const unset = await (await fetch(`${base}/status`)).json() as VoiceStatus;
      expect(unset).toMatchObject({ configured: false, persona: "Nara", minutes: null });
      expect((await post("session", {}, { origin: `http://127.0.0.1:${app.port}` })).status).toBe(409);

      writeFileSync(join(stateDir, "assistant", "voice.json"), JSON.stringify({ api_key: KEY }));
      expect((await post("tool", { tool: "last_result" }, {})).status).toBe(403);
      expect((await post("tool", { tool: "last_result" }, { authorization: "Bearer wrong" })).status).toBe(403);
      expect((await post("tool", { tool: "last_result" }, { authorization: "Bearer bridge-secret" })).status).toBe(200);
      const session = await post("session", {}, { authorization: "Bearer bridge-secret" });
      const text = await session.text();
      expect(session.status).toBe(200);
      expect((JSON.parse(text) as VoiceSessionResponse).conversation_token).toBe("conv_token");
      const status = await (await fetch(`${base}/status`)).text();
      expect(JSON.parse(status)).toMatchObject({ configured: true });
      for (const answer of [text, status]) expect(answer).not.toContain(KEY);
      expect(errors.mock.calls.flat().join(" ")).not.toContain(KEY);
      expect((await fetch(`${base}/session`)).status).toBe(405);
      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally { app.stop(); errors.mockRestore(); }
  });
});

describe("the machine proxy", () => {
  it("passes the three voice routes and nothing else of the Assistant", () => {
    for (const path of ["assistant/voice/status", "assistant/voice/session", "assistant/voice/tool"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    for (const path of ["assistant", "assistant/voice", "assistant/voice/key", "assistant/voice/tool/extra", "assistant/machines/x", "assistant/voice/../machines"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
  });
});
