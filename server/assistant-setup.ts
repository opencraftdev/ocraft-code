/**
 * Set up a VM as the Assistant from the browser (docs/plan/20261112-0955-assistant-one-click-setup.md):
 * the same scripts/install-assistant.sh the setup page tells you to paste, run over `ssh -tt` on a PTY
 * from the Rust host or the Node sidecar, its terminal streamed to the page. SSH is Remote PCs' own
 * (server/ssh.ts): the account's config and agent, Ovis's known_hosts, a new host's fingerprint shown
 * and accepted in the page, a changed one refused, passwords and passphrases asked in the page.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ASSISTANT_AGENTS, type AssistantAgent, type AssistantSetupEvent, type AssistantSetupJob, type AssistantSetupMachine } from "../shared/assistant.ts";
import type { SshTarget } from "../shared/machines.ts";
import { badRequest, conflictResponse, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { canSendSecret, sameOrigin, shellQuote, validateTarget } from "./machine-security.ts";
import { PtySession } from "./pty/session.ts";
import { sidecarAvailable } from "./pty/sidecar.ts";
import { SshConnection } from "./ssh.ts";

/** The script's own rule for a Tailscale machine name (scripts/install-assistant.sh) */
export const ASSISTANT_NAME_RULE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** the install's last words name the VM's tailnet address */
const ADDRESS = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi;
/** terminal escapes and carriage returns, which the address search reads past */
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r/g;
/** what a page that joins late (or again) is shown of the terminal so far */
const REPLAY_CHARS = 200_000;
const ACTIVE: readonly AssistantSetupJob["phase"][] = ["connecting", "authentication", "running"];

/** The script at the commit this server runs, so a cached `main` never serves an older one; `main` when the revision is unknown. */
export function installScriptUrl(revision: string | undefined): string {
  const ref = revision && /^[0-9a-f]{7,40}$/.test(revision) ? revision : "main";
  return `https://raw.githubusercontent.com/opencraftdev/ocraft-code/${ref}/scripts/install-assistant.sh`;
}

/** The command the VM runs: fixed here, with only the validated name and agent in it, quoted. */
export function installCommand(revision: string | undefined, name: string, agent: AssistantAgent): string {
  if (!ASSISTANT_NAME_RULE.test(name) || !ASSISTANT_AGENTS.includes(agent)) throw new Error("Invalid machine name or agent");
  return `curl -fsSL ${shellQuote(installScriptUrl(revision))} | ASSISTANT_NAME=${shellQuote(name)} ASSISTANT_AGENT=${shellQuote(agent)} bash`;
}

/** A connected Linux PC of this Ovis, its SSH address and this app's key for it (MachineManager.linuxMachines). */
export interface SetupMachine { id: string; name: string; target: SshTarget; keyPath?: string }

/**
 * A setup request's SSH target, name and agent, or the reason it is refused. With `machineId`, the
 * target is that machine's own, looked up here among `machines`: never an address the page sent.
 */
export function validateSetup(body: unknown, machines: readonly SetupMachine[] = []): { target: SshTarget; keyPath?: string; name: string; agent: AssistantAgent; cols: number; rows: number } {
  if (!isJsonObject(body)) throw new Error("Expected a setup request");
  let target: SshTarget;
  let keyPath: string | undefined;
  if (body["machineId"] !== undefined) {
    if (body["destination"] !== undefined || body["port"] !== undefined) throw new Error("Choose a machine or enter an SSH address, not both");
    const machine = machines.find((candidate) => candidate.id === body["machineId"]);
    if (!machine) throw new Error("That machine is not a connected Linux machine of this Ovis");
    ({ target, keyPath } = machine);
  } else target = validateTarget({ destination: body["destination"], ...(body["port"] === undefined ? {} : { port: body["port"] }) });
  const name = body["name"];
  if (typeof name !== "string" || !ASSISTANT_NAME_RULE.test(name)) throw new Error("A machine name is lowercase letters, digits and inner hyphens");
  const agent = body["agent"];
  if (typeof agent !== "string" || !(ASSISTANT_AGENTS as readonly string[]).includes(agent)) throw new Error("The agent CLI is claude or codex");
  const size = (value: unknown, fallback: number) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 1000 ? Number(value) : fallback;
  return { target, ...(keyPath === undefined ? {} : { keyPath }), name, agent: agent as AssistantAgent, cols: size(body["cols"], 100), rows: size(body["rows"], 30) };
}

/** What the setup needs of an SSH connection: Remote PCs' SshConnection. */
export interface SetupConnection {
  start(challenge: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void>;
  terminal(script: string): { argv: string[]; env: Record<string, string> };
  close(): void;
}

export interface AssistantSetupOptions {
  /** the commit this server runs; unset, OVIS_REVISION */
  revision?: string;
  /** whether a PTY host can run here; unset, the server's own answer (server/pty/sidecar.ts) */
  ptyAvailable?: () => boolean;
  connect?: (target: SshTarget, sshDir: string, keyPath?: string) => SetupConnection;
  /** the machines a setup may pick by id; unset, none */
  machines?: () => SetupMachine[];
}

interface Running {
  public: AssistantSetupJob;
  ssh?: SetupConnection;
  pty?: PtySession;
  pending?: { resolve(answer: string): void; reject(error: Error): void };
  output: string;
  scan: string;
}

/** One setup at a time per server. */
export class AssistantSetup {
  private current: Running | null = null;
  private listeners = new Set<(event: AssistantSetupEvent) => void>();

  constructor(private readonly stateDir: string, private readonly options: AssistantSetupOptions = {}) {}

  job(): AssistantSetupJob | null { return this.current?.public ?? null; }

  /** the machines the page may offer, without their keys */
  machines(): AssistantSetupMachine[] {
    return (this.options.machines?.() ?? []).map(({ id, name, target }) => ({ id, name, destination: target.destination }));
  }

  start(body: unknown): AssistantSetupJob {
    const { target, keyPath, name, agent, cols, rows } = validateSetup(body, this.options.machines?.() ?? []);
    if (this.current && ACTIVE.includes(this.current.public.phase)) throw new SetupBusy();
    const command = installCommand(this.options.revision ?? process.env["OVIS_REVISION"], name, agent);
    const job: Running = { public: { id: randomUUID(), phase: "connecting", destination: target.destination, challenge: null, command, address: null, error: null }, output: "", scan: "" };
    this.current = job;
    if (!(this.options.ptyAvailable ?? sidecarAvailable)()) {
      job.public.phase = "unsupported";
      return job.public;
    }
    // Remote PCs' ssh directory: its known_hosts is the one a PC added there trusts
    const sshDir = join(this.stateDir, "ssh");
    const ssh = job.ssh = (this.options.connect ?? ((t, dir, key) => new SshConnection(t, dir, key)))(target, sshDir, keyPath);
    void (async () => {
      try {
        await ssh.start((prompt, hostKey) => {
          if (this.current !== job || job.public.phase === "stopped") return Promise.reject(new Error("Setup stopped"));
          job.public.phase = "authentication";
          job.public.challenge = { id: randomUUID(), kind: hostKey ? "host_key" : "secret", prompt };
          this.tell(job);
          return new Promise<string>((resolve, reject) => { job.pending = { resolve, reject }; });
        });
        if (job.public.phase === "stopped") return;
        const { argv, env } = ssh.terminal(command);
        job.public.phase = "running";
        job.public.challenge = null;
        this.tell(job);
        job.pty = new PtySession({
          command: argv[0]!, args: argv.slice(1), cols, rows, env,
          onData: (data) => this.output(job, data),
          onExit: (code) => {
            if (job.public.phase !== "running") return;
            job.public.phase = code === 0 ? "done" : "failed";
            if (code !== 0) job.public.error = `The install ended with exit code ${code ?? "unknown"}`;
            ssh.close();
            this.tell(job);
          },
        });
      } catch (error) {
        ssh.close();
        if (job.public.phase === "stopped") return;
        job.public.phase = "failed";
        job.public.challenge = null;
        job.public.error = error instanceof Error ? error.message.trim().slice(-2000) : String(error);
        this.tell(job);
      }
    })();
    return job.public;
  }

  answer(body: unknown): AssistantSetupJob {
    const job = this.current;
    if (!job?.pending || !job.public.challenge || !isJsonObject(body) || body["challenge_id"] !== job.public.challenge.id) throw new Error("SSH question changed; read it again");
    const answer = body["answer"];
    if (typeof answer !== "string" || answer.length > 4096 || /[\r\n\0]/.test(answer)) throw new Error("Invalid SSH response");
    if (job.public.challenge.kind === "host_key" && answer !== "yes" && answer !== "no") throw new Error("Confirm or reject the fingerprint");
    const pending = job.pending;
    job.pending = undefined;
    job.public.challenge = null;
    job.public.phase = "connecting";
    this.tell(job);
    pending.resolve(answer);
    return job.public;
  }

  /** a challenge's kind, for the route to ask for HTTPS before a secret */
  challengeKind(): "host_key" | "secret" | null { return this.current?.public.challenge?.kind ?? null; }

  input(data: unknown): void {
    if (typeof data !== "string" || data.length > 65536) throw new Error("Invalid terminal input");
    const pty = this.current?.public.phase === "running" ? this.current.pty : undefined;
    if (!pty) throw new Error("The install is not running");
    pty.write(data);
  }

  resize(cols: unknown, rows: unknown): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 1 || Number(cols) > 1000 || Number(rows) < 1 || Number(rows) > 1000) throw new Error("Invalid terminal size");
    this.current?.pty?.resize(Number(cols), Number(rows));
  }

  /** Ends the SSH session and its install, whatever step it is at. */
  stop(): AssistantSetupJob | null {
    const job = this.current;
    if (!job) return null;
    if (!ACTIVE.includes(job.public.phase)) return job.public;
    job.public.phase = "stopped";
    job.public.challenge = null;
    job.pending?.reject(new Error("Setup stopped"));
    job.pending = undefined;
    job.pty?.kill();
    job.ssh?.close();
    this.tell(job);
    return job.public;
  }

  /** the terminal so far and every change after it, until `signal` aborts */
  subscribe(listener: (event: AssistantSetupEvent) => void): () => void {
    const job = this.current;
    if (job) {
      listener({ type: "job", job: job.public });
      if (job.output) listener({ type: "output", data: job.output });
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private output(job: Running, data: string): void {
    if (this.current !== job) return;
    job.output = (job.output + data).slice(-REPLAY_CHARS);
    for (const listener of this.listeners) listener({ type: "output", data });
    // an address split across two reads is found in the next one
    const text = job.scan + data.replace(ESCAPES, "");
    const found = [...text.matchAll(ADDRESS)].at(-1)?.[0];
    job.scan = text.slice(-300);
    if (found && found !== job.public.address) {
      job.public.address = found;
      this.tell(job);
    }
  }

  private tell(job: Running): void {
    if (this.current !== job) return;
    for (const listener of this.listeners) listener({ type: "job", job: job.public });
  }
}

export class SetupBusy extends Error { constructor() { super("A VM setup is already running"); } }

/**
 * /api/assistant-setup: only a signed-in device that may drive this Ovis (the same checks as Add PC:
 * this app's Origin, and its own header on every write), and a secret only over HTTPS or localhost.
 */
export async function handleAssistantSetupRequest(request: Request, pathname: string, setup: AssistantSetup, readOnly: boolean): Promise<Response> {
  const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);
  const action = pathname.slice("/api/assistant-setup".length).replace(/^\//, "");
  setRequestRoute(`/api/assistant-setup${action ? `/${action}` : ""}`);
  if (readOnly) return fail("read_only", "this device can only watch", 403);
  if (!sameOrigin(request)) return fail("invalid_origin", "Use Assistant controls from this app", 403);
  const get = request.method === "GET";
  if (!get && request.method !== "POST") return fail("method_not_allowed", "Use GET or POST", 405);
  if (!get && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Use Assistant controls from this app", 403);
  if (!(get ? ["", "stream"] : ["", "answer", "input", "resize", "stop"]).includes(action)) {
    return fail("not_found", "not found", 404);
  }
  if (action === "stream") return stream(request, setup);
  if (get) return jsonResponse({ job: setup.job(), machines: setup.machines() });
  const body: unknown = action === "stop" ? null : await request.json().catch(() => undefined);
  if (body === undefined) return badRequest("invalid_json", "Request body must be JSON");
  try {
    switch (action) {
      case "": return jsonResponse(setup.start(body), 202);
      case "answer":
        if (setup.challengeKind() === "secret" && !canSendSecret(request)) return fail("https_required", "Passwords and key passphrases require HTTPS or localhost", 403);
        return jsonResponse(setup.answer(body));
      case "input": setup.input(isJsonObject(body) ? body["data"] : undefined); return jsonResponse({ ok: true });
      case "resize": setup.resize(isJsonObject(body) ? body["cols"] : undefined, isJsonObject(body) ? body["rows"] : undefined); return jsonResponse({ ok: true });
      default: return jsonResponse({ job: setup.stop() });
    }
  } catch (error) {
    if (error instanceof SetupBusy) return conflictResponse("setup_running", error.message);
    return badRequest("invalid_setup", error instanceof Error ? error.message : String(error));
  }
}

function stream(request: Request, setup: AssistantSetup): Response {
  let stop = () => {};
  const body = new ReadableStream<string>({
    start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const unsubscribe = setup.subscribe((event) => { try { controller.enqueue(`data: ${JSON.stringify(event)}\n\n`); } catch { stop(); } });
      stop = () => { unsubscribe(); clearInterval(heartbeat); try { controller.close(); } catch { /* closed */ } };
      heartbeat = setInterval(() => { try { controller.enqueue(": heartbeat\n\n"); } catch { stop(); } }, 15_000);
      request.signal.addEventListener("abort", () => stop(), { once: true });
    },
    cancel() { stop(); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
