/**
 * `ovis-task`, the Assistant's one tool (bin/ovis-task runs this). It holds no logic of its own: it
 * asks the VM's Ovis server on loopback (OVIS_TASK_URL) with the token the Assistant's pane was
 * given (OVIS_TASK_TOKEN), and prints the answer. The server checks every path and argument.
 */
import { parseArgs } from "node:util";

const USAGE = `ovis-task projects
ovis-task read <project> <path>
ovis-task grep <project> <pattern> [path]
ovis-task git <project> log|diff|status|show [args...]
ovis-task create <project> --title <title> --brief <brief> [--agent claude|codex] [--review] [--auto-merge] [--after <id>] [--at <time>] [--cron <expr>]
ovis-task list [--status <status>]
ovis-task show <id>
ovis-task answer <id> <choice>
ovis-task cancel <id>
ovis-task machines`;
const CREATE_USAGE = USAGE.split("\n")[4]!;

/** `--flag value` options, or null when one is unknown or lacks its value */
function options<T extends Record<string, { type: "string" | "boolean" }>>(args: readonly string[], spec: T) {
  try { return parseArgs({ args: [...args], options: spec, allowPositionals: true, strict: true }); } catch { return null; }
}

/** the request a command line makes, the usage line it got wrong, or a command the CLI refuses */
export function cliRequest(argv: readonly string[]): { path: string; body?: unknown } | { usage: string } | { refused: string } {
  const [command, project, ...rest] = argv;
  switch (command) {
    case "projects": return argv.length === 1 ? { path: command } : { usage: "ovis-task projects" };
    case "machines": return argv.length === 1 ? { path: command } : { usage: "ovis-task machines" };
    case "list": {
      const read = options(argv.slice(1), { status: { type: "string" } });
      if (!read || read.positionals.length > 0) return { usage: "ovis-task list [--status <status>]" };
      return { path: read.values.status === undefined ? "list" : `list?status=${encodeURIComponent(read.values.status)}` };
    }
    case "read": return project !== undefined && rest.length === 1 ? { path: "read", body: { project, path: rest[0] } } : { usage: "ovis-task read <project> <path>" };
    case "grep": return project !== undefined && (rest.length === 1 || rest.length === 2) ? { path: "grep", body: { project, pattern: rest[0], ...(rest[1] === undefined ? {} : { path: rest[1] }) } } : { usage: "ovis-task grep <project> <pattern> [path]" };
    case "git": return project !== undefined && rest.length >= 1 ? { path: "git", body: { project, command: rest[0], args: rest.slice(1) } } : { usage: "ovis-task git <project> log|diff|status|show [args...]" };
    case "create": {
      const read = options(argv.slice(1), { title: { type: "string" }, brief: { type: "string" }, agent: { type: "string" }, review: { type: "boolean" }, "auto-merge": { type: "boolean" }, after: { type: "string" }, at: { type: "string" }, cron: { type: "string" } });
      if (!read || read.positionals.length !== 1 || read.values.title === undefined || read.values.brief === undefined) return { usage: CREATE_USAGE };
      const { title, brief, agent, review, "auto-merge": autoMerge, after, at, cron } = read.values;
      return { path: "create", body: { project: read.positionals[0], title, brief, agent, review, autoMerge, after, at, cron } };
    }
    case "show": case "cancel": return project !== undefined && rest.length === 0 ? { path: command, body: { id: project } } : { usage: `ovis-task ${command} <id>` };
    case "answer": return project !== undefined && rest.length === 1 ? { path: "answer", body: { id: project, choice: rest[0] } } : { usage: "ovis-task answer <id> <choice>" };
    // the Assistant never merges on its own: only the user approves, in the app
    case "approve": return { refused: "ovis-task approve is refused: only the user approves a task, in the app" };
    default: return { usage: USAGE };
  }
}

async function main(): Promise<number> {
  const request = cliRequest(process.argv.slice(2));
  if ("usage" in request) { console.error(`usage: ${request.usage}`); return 2; }
  if ("refused" in request) { console.error(request.refused); return 1; }
  const url = process.env["OVIS_TASK_URL"];
  const token = process.env["OVIS_TASK_TOKEN"];
  if (!url || !token) { console.error("ovis-task runs only in the Assistant's own pane (OVIS_TASK_URL and OVIS_TASK_TOKEN are not set)"); return 1; }
  const response = await fetch(`${url}/api/ovis-task/${request.path}`, {
    method: request.body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  }).catch((error: unknown) => { console.error(`ovis-task: the Assistant's server does not answer (${error instanceof Error ? error.message : String(error)})`); return null; });
  if (response === null) return 1;
  const answer = await response.json().catch(() => null) as { error?: { code: string; message: string }; output?: string | null; truncated?: boolean } | unknown[] | null;
  if (!response.ok || answer === null || (!Array.isArray(answer) && answer.error)) {
    const error = answer !== null && !Array.isArray(answer) ? answer.error : undefined;
    console.error(`ovis-task: ${error ? `${error.message} (${error.code})` : `HTTP ${response.status}`}`);
    return 1;
  }
  if (Array.isArray(answer) || !["read", "grep", "git", "show"].includes(request.path)) { console.log(JSON.stringify(answer, null, 2)); return 0; }
  if (request.path === "show") {
    const { output, ...task } = answer;
    console.log(JSON.stringify(task, null, 2));
    if (output) process.stdout.write(`\n--- the pane's last lines ---\n${output}\n`);
    return 0;
  }
  process.stdout.write(answer.output ?? "");
  if (answer.truncated) console.error("\novis-task: the output was cut; read a smaller part");
  return 0;
}

if (import.meta.main) process.exit(await main());
