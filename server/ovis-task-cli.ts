/**
 * `ovis-task`, the Assistant's one tool (bin/ovis-task runs this). It holds no logic of its own: it
 * asks the VM's Ovis server on loopback (OVIS_TASK_URL) with the token the Assistant's pane was
 * given (OVIS_TASK_TOKEN), and prints the answer. The server checks every argument.
 */
import { parseArgs } from "node:util";

const OPEN_USAGE = "ovis-task open <machine> <folder> [--agent claude|codex] [--create] <brief>";
const USAGE = `ovis-task machines
ovis-task sessions [machine]
ovis-task graph [machine]
ovis-task peek <machine> <pane>
ovis-task send <machine> <pane> <message>
${OPEN_USAGE}`;

/** the request a command line makes, or the usage line it got wrong */
export function cliRequest(argv: readonly string[]): { path: string; body?: unknown } | { usage: string } {
  const [command, machine, ...rest] = argv;
  switch (command) {
    case "machines": return argv.length === 1 ? { path: command } : { usage: "ovis-task machines" };
    case "sessions": return argv.length <= 2 ? { path: machine === undefined ? "sessions" : `sessions?machine=${encodeURIComponent(machine)}` } : { usage: "ovis-task sessions [machine]" };
    case "graph": return argv.length <= 2 ? { path: machine === undefined ? "graph" : `graph?machine=${encodeURIComponent(machine)}` } : { usage: "ovis-task graph [machine]" };
    case "peek": return machine !== undefined && rest.length === 1 ? { path: "peek", body: { machine, pane: rest[0] } } : { usage: "ovis-task peek <machine> <pane>" };
    case "send": return machine !== undefined && rest.length >= 2 ? { path: "send", body: { machine, pane: rest[0], message: rest.slice(1).join(" ") } } : { usage: "ovis-task send <machine> <pane> <message>" };
    case "open": {
      let read;
      try { read = parseArgs({ args: argv.slice(1), options: { agent: { type: "string" }, create: { type: "boolean" } }, allowPositionals: true, strict: true }); } catch { return { usage: OPEN_USAGE }; }
      const [on, folder, ...brief] = read.positionals;
      if (on === undefined || folder === undefined || brief.length === 0) return { usage: OPEN_USAGE };
      return { path: "open", body: { machine: on, folder, brief: brief.join(" "), ...(read.values.agent === undefined ? {} : { agent: read.values.agent }), create: read.values.create === true } };
    }
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
  const answer = await response.json().catch(() => null) as { error?: { code: string; message: string } } | unknown[] | null;
  if (!response.ok || answer === null || (!Array.isArray(answer) && answer.error)) {
    const error = answer !== null && !Array.isArray(answer) ? answer.error : undefined;
    console.error(`ovis-task: ${error ? `${error.message} (${error.code})` : `HTTP ${response.status}`}`);
    return 1;
  }
  console.log(JSON.stringify(answer, null, 2));
  return 0;
}

if (import.meta.main) process.exit(await main());
