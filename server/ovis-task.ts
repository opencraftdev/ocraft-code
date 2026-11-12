/**
 * The routes the Assistant's `ovis-task` CLI (bin/ovis-task) calls, /api/ovis-task/... (plan
 * decisions 10, 11 and 14; docs/plan/20261111-2112-assistant.md). They are not the UI's routes:
 * only a client on this VM's loopback that came through no proxy (so never through `tailscale
 * serve`) and holds the CLI token reaches them. The token is a file in stateDir only this server
 * reads, handed to the Assistant's pane in its environment.
 *
 * Every read runs on the project's machine. The script resolves the project folder and the path
 * there (`cd -P`, `realpath`, so `..` and symlinks are followed) and refuses anything outside the
 * folder before it reads. No read writes, and no route adds a project. All writes are tasks
 * (create, answer, cancel; server/assistant-tasks.ts), and no route approves one: that is the user's.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { OvisTaskRefusal } from "../shared/assistant.ts";
import { type Assistant, AssistantError } from "./assistant.ts";
import { isAuthenticated } from "./auth.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { shellQuote } from "./machine-security.ts";
import { writePrivateState } from "./private-state.ts";
import { readStateDocument } from "./state-document.ts";

/** what one read hands back at most; more is cut and said so */
export const OUTPUT_CAP = 256 * 1024;

/** The CLI's token: made once, kept at 0600 in stateDir/assistant/. */
export function cliToken(stateDir: string): string {
  const path = join(stateDir, "assistant", "cli-token.json");
  const read = readStateDocument(path);
  if (read.kind === "json" && isJsonObject(read.value) && typeof read.value.token === "string" && read.value.token.length >= 32) return read.value.token;
  const token = randomBytes(32).toString("hex");
  writePrivateState(path, { token });
  return token;
}

const MESSAGES: Record<OvisTaskRefusal, string> = {
  unknown_project: "No project has that name; `ovis-task projects` lists them",
  unknown_machine: "That project's machine is not one of herdr's saved machines",
  invalid_path: "A path is a relative path inside the project, without control characters",
  absolute_path: "Give a path relative to the project folder, not an absolute one",
  outside_project: "That path leads outside the project folder",
  not_found: "Nothing is at that path",
  not_a_file: "That path is not a file",
  project_missing: "The project's folder is gone from its machine",
  invalid_pattern: "A pattern is one line of at most 1000 characters",
  invalid_git_command: "ovis-task git runs only log, diff, status and show",
  invalid_git_argument: "That git option is not allowed here",
};
const refuse = (code: OvisTaskRefusal, status = 400) => new AssistantError(code, MESSAGES[code], status);

const lineValue = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\0\r\n]/.test(value);

/** a path the Assistant gave: relative to the project folder; "" is the folder itself */
export function checkPath(value: unknown): string {
  if (value === undefined || value === "") return ".";
  if (!lineValue(value, 4096)) throw refuse("invalid_path");
  if (value.startsWith("/") || value.startsWith("~")) throw refuse("absolute_path");
  return value;
}

/**
 * The start of every read: the project folder and the path, resolved on the machine. It prints
 * `refused:<code>` and stops when either is not there or the path resolves outside the folder;
 * after it, `$root` is the folder and `$real` the path, both resolved. Every script exits 0 (an
 * SSH run that exits otherwise throws), so the first line says how it went.
 */
export function resolveScript(root: string, path: string): string {
  return [
    `root=$(cd -P -- ${shellQuote(root)} 2>/dev/null && pwd -P) || { echo refused:project_missing; exit 0; }`,
    `cd "$root" || { echo refused:project_missing; exit 0; }`,
    // `./` first: a relative path, and never an option to realpath
    `real=$(realpath ${shellQuote("./" + path)} 2>/dev/null) || { echo refused:not_found; exit 0; }`,
    `case "$real" in "$root"|"$root"/*) ;; *) echo refused:outside_project; exit 0;; esac`,
    `[ -e "$real" ] || { echo refused:not_found; exit 0; }`,
  ].join("\n");
}

const capped = `head -c ${OUTPUT_CAP + 1}`;

export function readScript(root: string, path: string): string {
  return [resolveScript(root, path), `[ -f "$real" ] || { echo refused:not_a_file; exit 0; }`, "echo ok", `${capped} "$real"`, "exit 0"].join("\n");
}

export function grepScript(root: string, pattern: string, path: string): string {
  return [
    resolveScript(root, path),
    "echo ok",
    // the path relative to the folder, so a match reads `./src/a.ts:3:...`; -r follows no symlink below it
    `rel=".\${real#"$root"}"`,
    `grep -rnI --exclude-dir=.git -e ${shellQuote(pattern)} -- "$rel" 2>/dev/null | ${capped}`,
    "exit 0",
  ].join("\n");
}

export const GIT_COMMANDS = ["log", "diff", "status", "show"] as const;
/**
 * Options that write a file, run a program, read outside the repository or point git elsewhere.
 * git takes any unique prefix of a long option (`--out` is `--output`), so a long option is refused
 * when it is a prefix of one of these as well as when it starts with one.
 */
const BLOCKED_LONG = ["output", "output-directory", "exec", "upload-pack", "receive-pack", "ext-diff", "textconv", "no-index", "git-dir", "work-tree", "namespace", "open-files-in-pager", "contents", "config", "config-env", "paginate", "attr-source"];
/** `-c`/`-C` (config, another folder for a global option), `-O<file>` (an order file read anywhere), `-o` */
const BLOCKED_SHORT = /[cCoO]/;

export function gitArgumentFault(arg: string): boolean {
  if (!lineValue(arg, 1000)) return true;
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0]!;
    if (name === "") return false; // `--`: paths follow, which git keeps inside the repository
    return BLOCKED_LONG.some((blocked) => blocked.startsWith(name) || name.startsWith(blocked));
  }
  // a short option, or a bundle of them: `-pO/etc/passwd` reads as -p -O/etc/passwd
  if (arg.startsWith("-") && arg.length > 1) return BLOCKED_SHORT.test(arg.slice(1));
  return false;
}

export function gitScript(root: string, command: (typeof GIT_COMMANDS)[number], args: readonly string[]): string {
  // a diff driver from the repository's own config never runs either
  const safety = command === "status" ? [] : ["--no-ext-diff", "--no-textconv"];
  return [
    resolveScript(root, "."),
    "echo ok",
    `GIT_PAGER=cat GIT_OPTIONAL_LOCKS=0 git -C "$root" --no-pager ${command} ${[...safety, ...args].map(shellQuote).join(" ")} 2>&1 | ${capped}`,
    "exit 0",
  ].join("\n");
}

/** what a read script printed: its output (cut at OUTPUT_CAP), or the refusal it stopped at */
export function readOutput(printed: string): { output: string; truncated: boolean } {
  const newline = printed.indexOf("\n");
  const first = newline < 0 ? printed : printed.slice(0, newline);
  if (first.startsWith("refused:")) {
    const code = first.slice("refused:".length) as OvisTaskRefusal;
    throw refuse(code in MESSAGES ? code : "not_found", code === "not_found" ? 404 : 400);
  }
  if (first !== "ok") throw new Error(`unexpected answer from the machine: ${first.slice(0, 200)}`);
  const output = newline < 0 ? "" : printed.slice(newline + 1);
  return output.length > OUTPUT_CAP ? { output: output.slice(0, OUTPUT_CAP), truncated: true } : { output, truncated: false };
}

const ROUTES: Record<string, "GET" | "POST"> = { projects: "GET", list: "GET", read: "POST", grep: "POST", git: "POST", create: "POST", show: "POST", answer: "POST", cancel: "POST" };

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
  // the Assistant never merges on its own (plan, ovis-task CLI): only the user approves, in the app
  if (name === "approve") return jsonResponse({ error: { code: "ui_only", message: "Only the user approves a task, in the app" } }, 403);
  if (!method) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (request.method !== method) return jsonResponse({ error: { code: "method_not_allowed", message: `use ${method}` } }, 405, { allow: method });
  try {
    if (name === "projects") {
      const { projects, machines } = assistant.state();
      return jsonResponse(projects.map(({ id, path, mergeMode, defaultAgent, machine }) => ({ id, path, mergeMode, defaultAgent, machine: machines.find((item) => item.id === machine)?.name ?? machine })));
    }
    if (name === "list") return jsonResponse(assistant.tasks.list(new URL(request.url).searchParams.get("status") ?? undefined));
    const body = await request.json().catch(() => null);
    if (name === "create") return jsonResponse(await assistant.createTask(body), 201);
    const id = isJsonObject(body) ? body.id : undefined;
    if (name === "show") return jsonResponse(await assistant.tasks.show(id));
    if (name === "answer") return jsonResponse(await assistant.tasks.answer(id, isJsonObject(body) ? body.choice : undefined));
    if (name === "cancel") return jsonResponse(await assistant.tasks.cancel(id));
    if (!isJsonObject(body) || typeof body.project !== "string") throw refuse("unknown_project", 404);
    let script: (root: string) => string;
    if (name === "read") {
      const path = checkPath(body.path);
      script = (root) => readScript(root, path);
    } else if (name === "grep") {
      if (!lineValue(body.pattern, 1000) || body.pattern === "") throw refuse("invalid_pattern");
      const pattern = body.pattern;
      const path = checkPath(body.path);
      script = (root) => grepScript(root, pattern, path);
    } else {
      const command = body.command;
      if (!(GIT_COMMANDS as readonly unknown[]).includes(command)) throw refuse("invalid_git_command");
      const args = body.args ?? [];
      if (!Array.isArray(args) || args.length > 32 || !args.every((arg) => typeof arg === "string" && !gitArgumentFault(arg))) throw refuse("invalid_git_argument");
      script = (root) => gitScript(root, command as (typeof GIT_COMMANDS)[number], args as string[]);
    }
    return jsonResponse(readOutput(await assistant.runInProject(body.project, script)));
  } catch (error) {
    if (error instanceof AssistantError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return jsonResponse({ error: { code: "machine_unavailable", message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }, 502);
  }
}
