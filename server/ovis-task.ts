/**
 * The routes the Assistant's `ovis-task` CLI (bin/ovis-task) calls, /api/ovis-task/...
 * (docs/plan/20261112-1622-assistant-delegation.md). They are not the UI's routes: only a client on
 * this VM's loopback that came through no proxy (so never through `tailscale serve`) and holds the
 * CLI token reaches them. The token is a file in stateDir only this server reads, handed to the
 * Assistant's pane in its environment.
 *
 * machines, sessions and peek read; send messages an agent at rest; open starts a session
 * (server/assistant.ts). No route restarts the Assistant or changes a machine's settings: those are the user's.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Assistant, AssistantError } from "./assistant.ts";
import { isAuthenticated } from "./auth.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { writePrivateState } from "./private-state.ts";
import { readStateDocument } from "./state-document.ts";

/** The CLI's token: made once, kept at 0600 in stateDir/assistant/. */
export function cliToken(stateDir: string): string {
  const path = join(stateDir, "assistant", "cli-token.json");
  const read = readStateDocument(path);
  if (read.kind === "json" && isJsonObject(read.value) && typeof read.value.token === "string" && read.value.token.length >= 32) return read.value.token;
  const token = randomBytes(32).toString("hex");
  writePrivateState(path, { token });
  return token;
}

const ROUTES: Record<string, "GET" | "POST"> = { machines: "GET", sessions: "GET", peek: "POST", send: "POST", open: "POST" };

/**
 * /api/ovis-task/*. `local`: the request came from this VM's loopback and through no proxy, which
 * index.ts decides before any other route sees it.
 */
export async function handleOvisTaskRequest(request: Request, pathname: string, assistant: Assistant | null, token: string | null, local: boolean): Promise<Response> {
  const name = pathname.slice("/api/ovis-task/".length);
  const method = ROUTES[name];
  setRequestRoute(method ? `/api/ovis-task/${name}` : "/api/ovis-task/:unknown");
  if (!assistant || token === null) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (!local) return jsonResponse({ error: { code: "loopback_only", message: "ovis-task runs on the Assistant VM itself" } }, 403);
  if (!isAuthenticated(request, token) || !request.headers.get("authorization")) return jsonResponse({ error: { code: "unauthorized", message: "ovis-task token required" } }, 401);
  if (!method) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (request.method !== method) return jsonResponse({ error: { code: "method_not_allowed", message: `use ${method}` } }, 405, { allow: method });
  try {
    if (name === "machines") return jsonResponse(assistant.machineFolders());
    if (name === "sessions") return jsonResponse(assistant.herdrSessions(new URL(request.url).searchParams.get("machine") ?? undefined));
    const body = await request.json().catch(() => null);
    if (name === "peek") return jsonResponse(await assistant.peekSession(body));
    if (name === "send") return jsonResponse(await assistant.sendToSession(body));
    return jsonResponse(await assistant.openSession(body), 201);
  } catch (error) {
    if (error instanceof AssistantError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return jsonResponse({ error: { code: "machine_unavailable", message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }, 502);
  }
}
