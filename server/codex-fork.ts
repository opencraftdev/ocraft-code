import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { codexHistorySegments } from "./codex.ts";
import { nativeRecordHash } from "./conversation-fork-points.ts";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** A private stdio app-server process. It never sends turn/start, inputs, or approvals. */
export class ForkRpc {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly child: ChildProcessWithoutNullStreams;
  constructor(home: string, cwd: string, executable = "codex") {
    this.child = spawn(executable, ["app-server"], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      if (line.length > 1024 * 1024) return;
      let message: any; try { message = JSON.parse(line); } catch { return; }
      const waiting = this.pending.get(message.id);
      if (!waiting || message.method) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error("Codex could not create the fork.")); else waiting.resolve(message.result);
    });
    const failed = () => { for (const waiting of this.pending.values()) waiting.reject(new Error("The Codex fork process ended.")); this.pending.clear(); };
    this.child.on("error", failed); this.child.on("exit", failed);
  }
  async request(method: "initialize" | "thread/start" | "thread/inject_items" | "thread/read", params: Record<string, unknown>): Promise<any> {
    const id = ++this.id;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex fork timed out.")); }, 60000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "ovis", title: "Ovis conversation fork", version: "0.4.19" }, capabilities: { experimentalApi: false } });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 2000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}

/** Build the selected native context across inherited rollout segments, never from rendered text. */
export async function codexForkHistory(path: string, home: string, hash: string): Promise<{ items: unknown[]; model?: string; modelProvider?: string; baseInstructions?: string; effort?: string }> {
  let items: unknown[] = [], bytes = 0, found = false;
  let model: string | undefined, modelProvider: string | undefined, baseInstructions: string | undefined, effort: string | undefined;
  const pending = new Set<string>();
  for (const segment of codexHistorySegments(path, home)) {
    bytes += segment.end;
    if (bytes > 128 * 1024 * 1024) throw new Error("This conversation is too large to fork here.");
    const lines = createInterface({ input: createReadStream(segment.path, { encoding: "utf8", start: 0, end: Math.max(0, segment.end - 1) }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > 16 * 1024 * 1024) throw new Error("A conversation record is too large.");
      let entry: any; try { entry = JSON.parse(line); } catch { throw new Error("The selected history contains an incomplete record."); }
      const payload = entry.payload;
      if (entry.type === "session_meta") {
        modelProvider = typeof payload?.model_provider === "string" ? payload.model_provider : modelProvider;
        baseInstructions = typeof payload?.base_instructions === "string" ? payload.base_instructions : typeof payload?.base_instructions?.text === "string" ? payload.base_instructions.text : baseInstructions;
      }
      if (entry.type === "turn_context") {
        model = typeof payload?.model === "string" ? payload.model : model;
        effort = typeof payload?.effort === "string" ? payload.effort : effort;
      }
      if (entry.type === "compacted") {
        if (!Array.isArray(payload?.replacement_history)) throw new Error("The compacted history does not report its retained context.");
        items = [...payload.replacement_history]; pending.clear();
      }
      if (entry.type === "event_msg" && payload?.type === "thread_rolled_back") throw new Error("Refresh the conversation after its rewind before forking.");
      if (entry.type === "response_item") {
        items.push(payload);
        if (["function_call", "custom_tool_call"].includes(payload?.type) && typeof payload.call_id === "string") pending.add(payload.call_id);
        if (["function_call_output", "custom_tool_call_output"].includes(payload?.type)) pending.delete(payload.call_id);
      }
      if (nativeRecordHash(entry) === hash) { found = true; break; }
    }
    if (found) break;
  }
  if (!found || items.length === 0) throw new Error("The selected message is no longer in this history.");
  if (pending.size > 0) throw new Error("Wait for the pending tool calls before forking this point.");
  return { items, model, modelProvider, baseInstructions, effort };
}

/** Native session creation plus history injection handles a boundary inside a Codex turn. No model turn starts. */
export async function forkCodex(sourcePath: string, home: string, cwd: string, hash: string): Promise<string> {
  const history = await codexForkHistory(sourcePath, home, hash);
  const rpc = new ForkRpc(home, cwd);
  try {
    await rpc.initialize();
    const result = await rpc.request("thread/start", { cwd, ...(history.model ? { model: history.model } : {}), ...(history.modelProvider ? { modelProvider: history.modelProvider } : {}), ...(history.baseInstructions ? { baseInstructions: history.baseInstructions } : {}), ...(history.effort ? { config: { model_reasoning_effort: history.effort } } : {}) });
    const id: unknown = result.thread?.id;
    if (typeof id !== "string" || !UUID.test(id) || basename(sourcePath).includes(id)) throw new Error("Codex did not create a separate session.");
    await rpc.request("thread/inject_items", { threadId: id, items: history.items });
    return id;
  } finally { await rpc.close(); }
}
