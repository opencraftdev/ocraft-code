import { spawn } from "node:child_process";
import { basename, dirname, join, isAbsolute, relative } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { ConversationForkResponse, SessionSnapshot } from "../shared/protocol.ts";
import { paneConversation, paneTranscript } from "./conversation.ts";
import { paneCodexHome } from "./codex.ts";
import { readForkPoint } from "./conversation-fork-points.ts";
import { forkCodex } from "./codex-fork.ts";
import { agentLaunch } from "./agent-launch.ts";
import { sessionSnapshot, tabCreate, tabClose } from "./herdr/client.ts";
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";

export const CONVERSATION_FORK_PATH = "/api/pane/conversation/fork";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export interface ConversationForkDeps {
  codexHome?: string;
  readOnly?: boolean;
  snapshot?: () => Promise<SessionSnapshot>;
  conversation?: typeof paneConversation;
  transcript?: typeof paneTranscript;
  codexHomeOf?: typeof paneCodexHome;
  fork?: (source: { kind: "claude" | "codex"; path: string; home: string; cwd: string; hash: string; message?: string }) => Promise<string>;
  tabs?: { create: typeof tabCreate; start: typeof agentLaunch; close: typeof tabClose };
  holdOpen?: (seconds: number) => void;
  started?: (paneId: string, kind: "claude" | "codex", sessionId: string, home: string) => Promise<boolean>;
}

function forkClaude(session: string, home: string, cwd: string, message: string, project: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, "claude-fork-worker.ts"), session, cwd, message], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_PROJECT_DIR_NAME: project }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude fork timed out.")); }, 60000);
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 4096) child.kill(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Claude fork could not start.")); });
    child.on("exit", code => {
      clearTimeout(timer);
      try { const id: unknown = JSON.parse(output).sessionId; if (code !== 0 || typeof id !== "string" || !UUID.test(id) || id === session) throw new Error(); resolve(id); }
      catch { reject(new Error("Claude could not fork this message.")); }
    });
  });
}
const defaultFork: NonNullable<ConversationForkDeps["fork"]> = source => source.kind === "codex"
  ? forkCodex(source.path, source.home, source.cwd, source.hash)
  : forkClaude(basename(source.path, ".jsonl"), source.home, source.cwd, source.message!, basename(dirname(source.path)));

/** Requests are idempotent: reconnects cannot create the same requested branch twice. */
let copying = 0;
const requests = new Map<string, { ref: string; result: Promise<{ status: number; body: unknown }>; at: number }>();
export async function handleConversationFork(request: Request, deps: ConversationForkDeps = {}): Promise<Response> {
  setRequestRoute(CONVERSATION_FORK_PATH);
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  if (deps.readOnly) return jsonResponse({ error: { code: "read_only", message: "This device cannot create sessions." } }, 403);
  const body = await readJsonObject<{ pane_id?: unknown; fork_ref?: unknown; request_id?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body.pane_id !== "string" || !body.pane_id || typeof body.fork_ref !== "string" || typeof body.request_id !== "string" || !UUID.test(body.request_id)) return badRequest("invalid_fork", "pane_id, fork_ref and request_id are required");
  const point = readForkPoint(body.fork_ref, body.pane_id);
  if (!point) return jsonResponse({ error: { code: "fork_stale", message: "Refresh the conversation before forking this message." } }, 409);
  const key = `${body.pane_id}:${body.request_id}`;
  for (const [id, saved] of requests) if (Date.now() - saved.at > 10 * 60_000) requests.delete(id);
  let saved = requests.get(key);
  if (saved && saved.ref !== body.fork_ref) return badRequest("invalid_fork", "a request ID cannot name another message");
  if (!saved) {
    if (requests.size >= 64 || copying >= 2) return jsonResponse({ error: { code: "fork_busy", message: "Please try again shortly." } }, 429);
    copying++;
    const value = { ref: body.fork_ref, at: Date.now(), result: perform(body.pane_id, point, deps).catch(() => ({ status: 500, body: { error: { code: "fork_failed", message: "The conversation could not be forked. Please try again." } } })).finally(() => { copying--; }) };
    requests.set(key, value); saved = value;
  }
  deps.holdOpen?.(180);
  const result = await saved.result;
  return jsonResponse(result.body, result.status, { "cache-control": "no-store" });
}
async function perform(paneId: string, target: NonNullable<ReturnType<typeof readForkPoint>>, deps: ConversationForkDeps): Promise<{ status: number; body: unknown }> {
  const snapshot = await (deps.snapshot ?? sessionSnapshot)();
  const pane = snapshot.panes.find(item => item.pane_id === paneId);
  if (!pane || !["claude", "codex"].includes(pane.agent ?? "")) return { status: 409, body: { error: { code: "fork_stale", message: "This pane is no longer a Claude or Codex session." } } };
  const conversation = await (deps.conversation ?? paneConversation)(paneId, deps.codexHome);
  if (conversation.history_id !== target.history || conversation.source !== `${target.point.kind}-transcript`) return { status: 409, body: { error: { code: "fork_stale", message: "The conversation changed. Refresh before forking." } } };
  const source = await (deps.transcript ?? paneTranscript)(paneId, deps.codexHome, snapshot);
  const cwd = pane.foreground_cwd || pane.cwd;
  if (!cwd || source.source !== conversation.source || (await stat(source.path)).size > 128 * 1024 * 1024) throw new Error("The source cannot be forked.");
  const kind = target.point.kind;
  let home: string;
  if (kind === "claude") {
    if (basename(dirname(dirname(source.path))) !== "projects" || !target.point.message) throw new Error("The Claude store is not recognized.");
    home = dirname(dirname(dirname(source.path)));
  } else home = await (deps.codexHomeOf ?? paneCodexHome)(paneId, deps.codexHome);
  const inside = relative(await realpath(home), await realpath(source.path));
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("The source session store could not be verified.");
  const sessionId = await (deps.fork ?? defaultFork)({ home, path: source.path, cwd, ...target.point });
  if (!UUID.test(sessionId) || basename(source.path).includes(sessionId)) throw new Error("The fork did not create a distinct session.");
  // A source switch while the copy was being made never launches the wrong conversation.
  const current = await (deps.conversation ?? paneConversation)(paneId, deps.codexHome);
  const currentPane = (await (deps.snapshot ?? sessionSnapshot)()).panes.find(item => item.pane_id === paneId);
  if (current.history_id !== target.history || currentPane?.workspace_id !== pane.workspace_id) return { status: 409, body: { error: { code: "fork_stale", message: "The source session changed while the fork was being created." } } };
  const tabs = deps.tabs ?? { create: tabCreate, start: agentLaunch, close: tabClose };
  const created = await tabs.create({ workspaceId: pane.workspace_id, cwd, label: `Fork · ${(pane.title?.trim() || kind).slice(0, 80)}`, env: { [kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home, ...(kind === "claude" ? { CLAUDE_CODE_PROJECT_DIR_NAME: basename(dirname(source.path)) } : {}) } });
  try {
    const launched = await tabs.start(created.root_pane.pane_id, { kind, args: [kind === "claude" ? "--resume" : "resume", sessionId] });
    if (!launched.agent_started || !await (deps.started ?? startedFork)(created.root_pane.pane_id, kind, sessionId, home)) throw new Error("The forked agent could not start in its source store.");
    return { status: 200, body: { workspace_id: pane.workspace_id, pane_id: created.root_pane.pane_id, session_id: sessionId, agent_started: true } satisfies ConversationForkResponse };
  } catch (error) { await tabs.close(created.tab.tab_id).catch(() => undefined); throw error; }
}

/** Do not open a shell or a different profile as though it were the requested fork. */
async function startedFork(paneId: string, kind: "claude" | "codex", id: string, home: string): Promise<boolean> {
  const deadline = Date.now() + 12000;
  do {
    try {
      const sameHome = kind !== "codex" || await realpath(await paneCodexHome(paneId)) === await realpath(home);
      if (sameHome) {
        const source = await paneTranscript(paneId, kind === "codex" ? home : undefined);
        if (source.source === `${kind}-transcript` && basename(source.path).includes(id)) return true;
      }
    } catch { /* The new CLI is still declaring its session. */ }
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return false;
}
