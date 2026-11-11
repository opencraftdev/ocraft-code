/**
 * `ovis-task`, the Assistant's one tool (bin/ovis-task runs this). It holds no logic of its own: it
 * asks the VM's Ovis server on loopback (OVIS_TASK_URL) with the token the Assistant's pane was
 * given (OVIS_TASK_TOKEN), and prints the answer. The server checks every path and argument.
 */
const USAGE = `ovis-task projects
ovis-task list
ovis-task read <project> <path>
ovis-task grep <project> <pattern> [path]
ovis-task git <project> log|diff|status|show [args...]`;

/** the request a command line makes, or the usage line it got wrong */
export function cliRequest(argv: readonly string[]): { path: string; body?: unknown } | { usage: string } {
  const [command, project, ...rest] = argv;
  switch (command) {
    case "projects": case "list": return argv.length === 1 ? { path: command } : { usage: `ovis-task ${command}` };
    case "read": return project !== undefined && rest.length === 1 ? { path: "read", body: { project, path: rest[0] } } : { usage: "ovis-task read <project> <path>" };
    case "grep": return project !== undefined && (rest.length === 1 || rest.length === 2) ? { path: "grep", body: { project, pattern: rest[0], ...(rest[1] === undefined ? {} : { path: rest[1] }) } } : { usage: "ovis-task grep <project> <pattern> [path]" };
    case "git": return project !== undefined && rest.length >= 1 ? { path: "git", body: { project, command: rest[0], args: rest.slice(1) } } : { usage: "ovis-task git <project> log|diff|status|show [args...]" };
    // create, show, answer and cancel come with tasks (the plan's phase 4)
    default: return { usage: USAGE };
  }
}

async function main(): Promise<number> {
  const request = cliRequest(process.argv.slice(2));
  if ("usage" in request) { console.error(`usage: ${request.usage}`); return 2; }
  const url = process.env["OVIS_TASK_URL"];
  const token = process.env["OVIS_TASK_TOKEN"];
  if (!url || !token) { console.error("ovis-task runs only in the Assistant's own pane (OVIS_TASK_URL and OVIS_TASK_TOKEN are not set)"); return 1; }
  const response = await fetch(`${url}/api/ovis-task/${request.path}`, {
    method: request.body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  }).catch((error: unknown) => { console.error(`ovis-task: the Assistant's server does not answer (${error instanceof Error ? error.message : String(error)})`); return null; });
  if (response === null) return 1;
  const answer = await response.json().catch(() => null) as { error?: { code: string; message: string }; output?: string; truncated?: boolean } | unknown[] | null;
  if (!response.ok || answer === null || (!Array.isArray(answer) && answer.error)) {
    const error = answer !== null && !Array.isArray(answer) ? answer.error : undefined;
    console.error(`ovis-task: ${error ? `${error.message} (${error.code})` : `HTTP ${response.status}`}`);
    return 1;
  }
  if (Array.isArray(answer)) { console.log(JSON.stringify(answer, null, 2)); return 0; }
  process.stdout.write(answer.output ?? "");
  if (answer.truncated) console.error("\novis-task: the output was cut; read a smaller part");
  return 0;
}

if (import.meta.main) process.exit(await main());
