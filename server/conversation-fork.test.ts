import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { createClaudeTranscriptParser } from "./claude-transcript.ts";
import { createCodexTranscriptParser } from "./codex.ts";
import { forkableTurns, markForkPoint, nativeRecordHash, readForkPoint } from "./conversation-fork-points.ts";
import { handleConversationFork, type ConversationForkDeps } from "./conversation-fork.ts";
import { transcriptPage } from "./conversation.ts";
import { codexForkHistory } from "./codex-fork.ts";

describe("native message fork boundaries", () => {
  it("authenticates points to their pane and history, with no prompt or path in the payload", () => {
    const turn: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "private prompt" }] };
    markForkPoint(turn, "claude", { uuid: randomUUID() }, randomUUID());
    const ref = forkableTurns("pane-a", "history-a", [turn])[0]!.fork_ref!;
    expect(readForkPoint(ref, "pane-a")?.history).toBe("history-a");
    expect(readForkPoint(ref, "pane-b")).toBeNull();
    expect(readForkPoint(ref.slice(0, -4) + "xxxx", "pane-a")).toBeNull();
    expect(Buffer.from(ref.split(".")[0]!, "base64url").toString()).not.toContain("private prompt");
    expect(turn.fork_ref).toBeUndefined();
  });
  it("retains Claude points through detached snapshots and partial-record previews", () => {
    const parser = createClaudeTranscriptParser();
    const user = { type: "user", uuid: randomUUID(), timestamp: "2026-10-30T00:00:00Z", message: { role: "user", content: "first" } };
    const answer = { type: "assistant", uuid: randomUUID(), timestamp: "2026-10-30T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
    parser.write(JSON.stringify(user) + "\n");
    const first = forkableTurns("p", "h", parser.snapshot())[0]!.fork_ref!;
    const preview = forkableTurns("p", "h", parser.snapshot(JSON.stringify(answer)));
    expect(preview.map(turn => !!turn.fork_ref)).toEqual([true, true]);
    expect(preview[0]!.fork_ref).toBe(first);
    expect(readForkPoint(preview[1]!.fork_ref, "p")?.point.message).toBe(answer.uuid);
    expect(parser.snapshot().length).toBe(1);
  });
  it("anchors Codex to the model-visible user record and the last response record", () => {
    const parser = createCodexTranscriptParser();
    const user = { type: "response_item", timestamp: "2026-10-30T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } };
    const answer = { type: "response_item", timestamp: "2026-10-30T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } };
    parser.write(JSON.stringify(user) + "\n" + JSON.stringify(answer) + "\n");
    const turns = forkableTurns("p", "h", parser.snapshot());
    expect(readForkPoint(turns[0]!.fork_ref, "p")?.point.hash).toBe(nativeRecordHash(user));
    expect(readForkPoint(turns[1]!.fork_ref, "p")?.point.hash).toBe(nativeRecordHash(answer));
  });
});

function fixture(kind: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "ovis-fork-route-"));
  const cwd = join(root, "project"); mkdirSync(cwd);
  const home = join(root, kind), directory = join(home, kind === "claude" ? "projects/project" : "sessions/2026/10/30"); mkdirSync(directory, { recursive: true });
  const sourceId = randomUUID(), createdId = randomUUID();
  const path = join(directory, sourceId + ".jsonl"); writeFileSync(path, "original transcript\n");
  const source: HerdrPane = { pane_id: "source", workspace_id: "workspace", cwd, agent: kind } as HerdrPane;
  const snapshot = { panes: [source], tabs: [], workspaces: [] } as unknown as SessionSnapshot;
  const conversation = { history_id: "source-history", source: `${kind}-transcript`, turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, version: "v" };
  const turn: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "selected prompt" }] };
  markForkPoint(turn, kind, { type: "user", uuid: randomUUID() }, kind === "claude" ? randomUUID() : undefined);
  const ref = forkableTurns("source", conversation.history_id, [turn])[0]!.fork_ref!;
  let copies = 0, creates = 0, starts: unknown[] = [], closes: string[] = [];
  const deps: ConversationForkDeps = {
    snapshot: async () => snapshot,
    started: async () => true,
    conversation: async () => conversation as Awaited<ReturnType<NonNullable<ConversationForkDeps["conversation"]>>>,
    transcript: async () => ({ source: `${kind}-transcript`, path }) as Awaited<ReturnType<NonNullable<ConversationForkDeps["transcript"]>>>,
    codexHomeOf: async () => home,
    fork: async () => { copies++; return createdId; },
    tabs: {
      create: async () => { creates++; return { tab: { tab_id: "new-tab", workspace_id: "workspace" }, root_pane: { pane_id: "new-pane" } } as Awaited<ReturnType<NonNullable<ConversationForkDeps["tabs"]>["create"]>>; },
      start: async (_pane, payload) => { starts.push(payload); return { agent_started: true }; },
      close: async tab => { closes.push(tab); return; },
    },
  };
  const id = randomUUID();
  const request = (changes: Record<string, unknown> = {}) => new Request("http://localhost/api/pane/conversation/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: "source", fork_ref: ref, request_id: id, ...changes }) });
  return { root, path, kind, deps, request, conversation, createdId, counts: () => ({ copies, creates, starts, closes }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

describe("forking into a new session tab", () => {
  for (const kind of ["claude", "codex"] as const) it(`${kind}: creates once, resumes the new ID, and preserves the source`, async () => {
    const f = fixture(kind);
    try {
      const [first, duplicate] = await Promise.all([handleConversationFork(f.request(), f.deps), handleConversationFork(f.request(), f.deps)]);
      expect(first.status).toBe(200); expect(await duplicate.json()).toEqual(await first.json());
      expect(f.counts()).toEqual({ copies: 1, creates: 1, starts: [{ kind, args: [kind === "claude" ? "--resume" : "resume", f.createdId] }], closes: [] });
      expect(readFileSync(f.path, "utf8")).toBe("original transcript\n");
    } finally { f.clean(); }
  });
  it("refuses observe mode, forged points and stale history before creating anything", async () => {
    const f = fixture("claude");
    try {
      expect((await handleConversationFork(f.request(), { ...f.deps, readOnly: true })).status).toBe(403);
      expect((await handleConversationFork(f.request({ fork_ref: "forged" }), f.deps)).status).toBe(409);
      f.conversation.history_id = "another-session";
      expect((await handleConversationFork(f.request(), f.deps)).status).toBe(409);
      expect(f.counts().copies).toBe(0); expect(f.counts().creates).toBe(0);
    } finally { f.clean(); }
  });
  it("a session switch during copying creates no tab in the replacement conversation", async () => {
    const f = fixture("claude");
    try {
      f.deps.fork = async () => { f.conversation.history_id = "replacement"; return f.createdId; };
      expect((await handleConversationFork(f.request(), f.deps)).status).toBe(409); expect(f.counts().creates).toBe(0);
    } finally { f.clean(); }
  });
  it("closes only its new tab if launching fails", async () => {
    const f = fixture("codex");
    try {
      f.deps.tabs!.start = async () => ({ agent_started: false, error: { code: "test", message: "failed" } });
      expect((await handleConversationFork(f.request(), f.deps)).status).toBe(500);
      expect(f.counts().closes).toEqual(["new-tab"]); expect(readFileSync(f.path, "utf8")).toBe("original transcript\n");
    } finally { f.clean(); }
  });
});

it("Codex copies only native context through the selected record and rejects unfinished tool history", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-fork-context-")), path = join(root, "rollout.jsonl");
  const user = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } };
  const call = { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call", arguments: "{}" } };
  const later = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "later" }] } };
  try {
    writeFileSync(path, [user, call, later].map(x => JSON.stringify(x)).join("\n") + "\n");
    expect((await codexForkHistory(path, root, nativeRecordHash(user))).items).toEqual([user.payload]);
    await expect(codexForkHistory(path, root, nativeRecordHash(call))).rejects.toThrow("pending tool calls");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fork points survive the real paged transcript reader and its cached answer", () => {
  const path = join(import.meta.dir, "fixtures/codex-pictures-0.163.0-rollout.jsonl");
  const first = transcriptPage("codex-transcript", path);
  const marked = forkableTurns("paged", first.history_id, first.turns);
  expect(marked.filter(turn => turn.parts.some(part => part.kind === "text")).every(turn => !!turn.fork_ref)).toBe(true);
  const again = transcriptPage("codex-transcript", path);
  expect(forkableTurns("paged", again.history_id, again.turns).map(turn => turn.fork_ref)).toEqual(marked.map(turn => turn.fork_ref));
});
