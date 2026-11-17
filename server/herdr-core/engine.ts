import type { HerdrIdentity } from "../../shared/machines.ts";
import type { AgentInfo, PaneInfo, PaneProcessInfo, PaneReadResult, SessionSnapshot } from "../../shared/herdr-api.generated.ts";
import { HerdrError, type EventFrame, type HerdrSubscription, type PaneReadOptions, type SubscribeHandlers, type Subscription } from "../herdr/client.ts";
import { CoreConnection, spawnCoreTransport, type CoreStream, type Transport } from "./connection.ts";
import { applyCoreEvent, coreAgent, coreSnapshot, coreStatus, LAYOUT_DOC, type CoreTerminal, type LayoutDoc } from "./snapshot.ts";

/**
 * Which engine this PC's bridge drives: herdr 0.9 (the default) or herdr-core, the engine of
 * herdr's desktop app (`OVIS_ENGINE=herdr-core`). Per machine, as each PC runs its own bridge.
 * `hc` is found on the PATH, or at `OVIS_HC_BIN`; `HC_SESSION` / `HC_SOCKET` pick the core as for hc.
 */
export function coreEngineEnabled(): boolean {
  return process.env["OVIS_ENGINE"] === "herdr-core";
}

export function coreBin(): string {
  return process.env["OVIS_HC_BIN"] || "hc";
}

/** What the engine tells its listeners: computed against the snapshot before (`ended`) or after the change. */
export type CoreNotice =
  | { kind: "status"; paneIds: string[]; status: string; agent: string | null }
  | { kind: "ended"; paneIds: string[] }
  | { kind: "structure" }
  | { kind: "lost" };

interface CoreState {
  connection: CoreConnection;
  terminals: CoreTerminal[];
  doc: LayoutDoc | null;
  seq: number;
  events: CoreStream;
}

/**
 * The bridge's one herdr-core connection: the terminal list kept current by one unfiltered event
 * subscription, and the `herdr-app` layout document re-read whenever it changes. A snapshot is
 * computed from these, never asked for. A dropped connection is reopened on the next use.
 */
export class CoreEngine {
  private state: Promise<CoreState> | null = null;
  private readonly listeners = new Set<(notice: CoreNotice) => void>();

  constructor(private readonly transport: () => Transport = () => spawnCoreTransport(coreBin())) {}

  ready(): Promise<CoreState> {
    this.state ??= this.connect().catch((error: unknown) => {
      this.state = null;
      throw error instanceof HerdrError ? error : new HerdrError("connect_failed", `cannot start herdr-core (${coreBin()} connect): ${(error as Error)?.message ?? error}`);
    });
    return this.state;
  }

  private async connect(): Promise<CoreState> {
    const connection = await CoreConnection.open(this.transport());
    // subscribe before reading the document (schema/README.md, Documents)
    const subscribed = await connection.call<{ seq: number; terminals: CoreTerminal[]; channel: number }>("events.subscribe", {});
    const lines = new LineSplitter();
    const state = { connection, terminals: subscribed.terminals ?? [], doc: null, seq: subscribed.seq ?? 0 } as Omit<CoreState, "events"> as CoreState;
    // frames that came before this reply are replayed inside stream(): `state` must exist by then
    state.events = connection.stream(subscribed.channel, {
      onData: (bytes) => { for (const line of lines.push(bytes)) this.onLine(state, line); },
      onClose: () => connection.close(),
    });
    state.doc = await this.readDoc(connection);
    connection.onLost(() => {
      this.state = null;
      this.notify({ kind: "lost" });
    });
    return state;
  }

  private async readDoc(connection: CoreConnection): Promise<LayoutDoc | null> {
    const answer = await connection.call<{ value: unknown }>("doc.get", { name: LAYOUT_DOC });
    return typeof answer?.value === "object" && answer.value !== null ? (answer.value as LayoutDoc) : null;
  }

  private onLine(state: CoreState, line: string): void {
    let message: { method?: string; params?: { seq?: number; type?: string; terminal?: string; data?: Record<string, unknown>; terminals?: CoreTerminal[] } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    const params = message.params ?? {};
    if (message.method === "missed") {
      state.terminals = params.terminals ?? [];
      state.seq = params.seq ?? state.seq;
      void this.refreshDoc(state);
      return;
    }
    if (message.method !== "event" || (params.seq !== undefined && params.seq <= state.seq)) return;
    state.seq = params.seq ?? state.seq;
    if (params.type === "doc") {
      if (params.data?.["name"] === LAYOUT_DOC && params.data["machine"] === undefined) void this.refreshDoc(state);
      return;
    }
    const before = params.type === "finished" || params.type === "removed" ? this.panesOf(state, params.terminal) : [];
    if (!applyCoreEvent(state.terminals, params)) return;
    if (before.length > 0) this.notify({ kind: "ended", paneIds: before });
    if (params.type === "status") {
      const terminal = state.terminals.find((t) => t.address === params.terminal);
      this.notify({ kind: "status", paneIds: this.panesOf(state, params.terminal), status: coreStatus(terminal), agent: coreAgent(terminal) });
    }
    if (params.type !== "status" && params.type !== "turn" && params.type !== "size" && params.type !== "foreground") this.notify({ kind: "structure" });
  }

  private async refreshDoc(state: CoreState): Promise<void> {
    try {
      state.doc = await this.readDoc(state.connection);
    } catch {
      /* the connection dropped: the next connect reads it again */
    }
    this.notify({ kind: "structure" });
  }

  private panesOf(state: CoreState, terminal: string | undefined): string[] {
    return this.snapshotOf(state).panes.filter((pane) => pane.terminal_id === terminal).map((pane) => pane.pane_id);
  }

  private snapshotOf(state: CoreState): SessionSnapshot {
    return coreSnapshot({ doc: state.doc, terminals: state.terminals, version: `herdr-core ${state.connection.hello.version}`, protocol: state.connection.hello.generation });
  }

  private notify(notice: CoreNotice): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch (error) {
        console.error("herdr-core listener failed:", error);
      }
    }
  }

  listen(listener: (notice: CoreNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ping(): Promise<HerdrIdentity> {
    const { connection } = await this.ready();
    return { version: `herdr-core ${connection.hello.version}`, protocol: connection.hello.generation, terminal_attach: true };
  }

  async sessionSnapshot(): Promise<SessionSnapshot> {
    return this.snapshotOf(await this.ready());
  }

  private async pane(paneId: string): Promise<{ state: CoreState; pane: PaneInfo; terminal: CoreTerminal | undefined }> {
    const state = await this.ready();
    const pane = this.snapshotOf(state).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    return { state, pane, terminal: state.terminals.find((t) => t.address === pane.terminal_id) };
  }

  async paneGet(paneId: string): Promise<PaneInfo> {
    return (await this.pane(paneId)).pane;
  }

  /**
   * `terminal.read` gives plain text: the screen, plus `lines` of history for a recent read. An
   * ANSI read gets the same text (herdr-core has no styled read; the attach stream carries styles).
   */
  async paneRead(options: PaneReadOptions): Promise<PaneReadResult> {
    const { state, pane } = await this.pane(options.paneId);
    const source = options.source ?? "visible";
    const lines = source === "visible" ? 0 : (options.lines ?? 400);
    const read = await state.connection.call<{ text: string; complete: boolean }>("terminal.read", { terminal: pane.terminal_id, lines }, options.timeoutMs);
    return { pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, revision: pane.revision, source, format: options.format ?? "text", text: read.text, truncated: !read.complete };
  }

  /** Key names as herdr-core spells them: lowercase, `ctrl+c` (herdr-core keys.rs lowercases them too). */
  async paneSendKeys(paneId: string, keys: string[], guard?: () => boolean): Promise<void> {
    const { state, pane } = await this.pane(paneId);
    if (guard && !guard()) throw new HerdrError("cancelled", "herdr-core terminal.keys was not sent: the sender may no longer send");
    await state.connection.call("terminal.keys", { terminal: pane.terminal_id, keys });
  }

  /**
   * Raw text, no Enter: herdr-core's terminal.send always submits, so the text goes in through a
   * short attach at the terminal's own size (which leaves its grid as it is), then detaches.
   */
  async paneSendText(paneId: string, text: string, guard?: () => boolean): Promise<void> {
    const { state, pane, terminal } = await this.pane(paneId);
    const attached = await state.connection.call<{ channel: number }>("terminal.attach", { terminal: pane.terminal_id, cols: terminal?.cols || 80, rows: terminal?.rows || 24, history: 0, resumed: true });
    const stream = state.connection.stream(attached.channel, { onData: () => {}, onClose: () => {} });
    try {
      if (guard && !guard()) throw new HerdrError("cancelled", "herdr-core input was not sent: the sender may no longer send");
      stream.write(new TextEncoder().encode(text));
    } finally {
      stream.close();
    }
  }

  /**
   * herdr 0.9's `pane.process_info` from the terminal's own record (`terminal.get`, read fresh):
   * `pid` is the shell, `foreground` the foreground process group's leader. herdr-core names only
   * that leader, so `foreground_processes` holds one process (none once the terminal has ended).
   */
  async paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
    const { state, pane } = await this.pane(paneId);
    const record = await state.connection.call<{ pid?: number | null; foreground?: { pid: number; name: string; argv: string[]; cwd: string } | null }>("terminal.get", { terminal: pane.terminal_id });
    const fg = record.foreground;
    return {
      pane_id: pane.pane_id,
      shell_pid: record.pid ?? null,
      foreground_process_group_id: fg?.pid ?? null,
      foreground_processes: fg ? [{ pid: fg.pid, name: fg.name, argv: fg.argv, argv0: fg.argv[0] ?? fg.name, cwd: fg.cwd }] : [],
    };
  }

  /** herdr 0.9's agent record of a pane. herdr-core has no agent hooks, so no `agent_session`: Ovis finds the session from the process. */
  async agentGet(target: string): Promise<AgentInfo> {
    const { state, pane } = await this.pane(target);
    const agent = this.snapshotOf(state).agents.find((candidate) => candidate.pane_id === pane.pane_id);
    if (!agent) throw new HerdrError("agent_not_found", `pane ${target} runs no agent`);
    return agent;
  }

  async agentList(): Promise<AgentInfo[]> {
    return this.snapshotOf(await this.ready()).agents;
  }

  /** `agent.prompt`: herdr-core's `terminal.send` pastes the text and presses Enter. */
  async agentPrompt(target: string, text: string, guard?: () => boolean): Promise<void> {
    const { state, pane } = await this.pane(target);
    if (guard && !guard()) throw new HerdrError("cancelled", "herdr-core terminal.send was not sent: the sender may no longer send");
    await state.connection.call("terminal.send", { terminal: pane.terminal_id, text });
  }

  /**
   * `pane.wait_for_output` as `terminal.wait {output}`: plain text printed after the wait starts
   * (herdr-core strips escapes and has no regex match). A timeout rejects as herdr 0.9's does.
   */
  async paneWaitForOutput(paneId: string, match: { type: string; value: string }, timeoutMs = 30_000): Promise<{ pane_id: string; matched_line: string }> {
    if (match?.type !== "substring") throw new HerdrError("unsupported_engine", `herdr-core waits for plain text only, not ${match?.type}`);
    const { state, pane } = await this.pane(paneId);
    const waited = await state.connection.call<{ ended: boolean; reason: string }>("terminal.wait", { terminal: pane.terminal_id, output: match.value, timeout: timeoutMs / 1000 }, timeoutMs + 5_000);
    if (waited.reason === "output") return { pane_id: pane.pane_id, matched_line: match.value };
    throw new HerdrError(waited.reason === "timeout" ? "timeout" : "output_not_matched", `pane ${paneId} stopped waiting: ${waited.reason}`);
  }

  /**
   * herdr 0.9's JSON-RPC, answered from herdr-core for the methods it maps; any other method is
   * refused (`unsupported_engine`), so no call can reach a herdr 0.9 running beside the core.
   * Answers carry herdr 0.9's envelope, as `herdrRpc`'s callers unwrap it.
   */
  async rpc(method: string, params: Record<string, unknown>, timeoutMs?: number, guard?: () => boolean): Promise<unknown> {
    const paneId = String(params["pane_id"] ?? params["target"] ?? "");
    const text = typeof params["text"] === "string" ? params["text"] : "";
    const keys = Array.isArray(params["keys"]) ? params["keys"].map(String) : [];
    switch (method) {
      case "session.snapshot": return { snapshot: await this.sessionSnapshot() };
      case "pane.get": return { pane: await this.paneGet(paneId) };
      case "pane.process_info": return { type: "pane_process_info", process_info: await this.paneProcessInfo(paneId) };
      case "agent.get": return { type: "agent_info", agent: await this.agentGet(paneId) };
      case "agent.list": return { type: "agent_list", agents: await this.agentList() };
      case "agent.prompt": await this.agentPrompt(paneId, text, guard); return { type: "ok" };
      case "pane.send_text": await this.paneSendText(paneId, text, guard); return { type: "ok" };
      case "pane.send_keys": await this.paneSendKeys(paneId, keys, guard); return { type: "ok" };
      case "pane.send_input":
        if (text) await this.paneSendText(paneId, text, guard);
        if (keys.length > 0) await this.paneSendKeys(paneId, keys, guard);
        return { type: "ok" };
      case "pane.wait_for_output":
        return { type: "output_matched", ...(await this.paneWaitForOutput(paneId, params["match"] as { type: string; value: string }, typeof params["timeout_ms"] === "number" ? params["timeout_ms"] : timeoutMs)) };
      default: throw new HerdrError("unsupported_engine", `${method} is not available on herdr-core yet`);
    }
  }

  /** herdr 0.9's events.subscribe, answered from herdr-core's events (see CoreNotice). */
  subscribeEvents(subscriptions: HerdrSubscription[], handlers: SubscribeHandlers): Subscription {
    const types = new Set(subscriptions.map((s) => s.type));
    const statusPanes = new Set(subscriptions.filter((s) => s.type === "pane.agent_status_changed" && s.pane_id).map((s) => s.pane_id!));
    let closed = false;
    let stop: (() => void) | null = null;
    const emit = (frame: EventFrame): void => {
      if (!closed) handlers.onEvent(frame);
    };
    this.ready().then(() => {
      if (closed) return;
      stop = this.listen((notice) => {
        if (notice.kind === "lost") {
          closed = true;
          stop?.();
          handlers.onClose?.();
        } else if (notice.kind === "status") {
          for (const paneId of notice.paneIds) {
            if (statusPanes.has(paneId)) emit({ event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: notice.status, agent: notice.agent } });
          }
        } else if (notice.kind === "ended") {
          for (const paneId of notice.paneIds) if (types.has("pane.exited")) emit({ event: "pane.exited", data: { type: "pane_exited", pane_id: paneId } });
        } else if (types.has("layout.updated")) {
          emit({ event: "layout.updated", data: { type: "layout_updated" } });
        }
      });
      handlers.onStarted?.();
    }, (error: Error) => {
      if (closed) return;
      closed = true;
      handlers.onError?.(error);
      handlers.onClose?.();
    });
    return {
      close() {
        closed = true;
        stop?.();
      },
    };
  }

  /** Drops the connection (tests; a server stop). The next use connects again. */
  async close(): Promise<void> {
    const state = await this.state?.catch(() => null);
    state?.connection.close();
    this.state = null;
  }
}

class LineSplitter {
  private pending = "";
  private readonly decoder = new TextDecoder();

  push(bytes: Uint8Array): string[] {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

let shared: CoreEngine | null = null;

/** The bridge's engine; tests may swap it. */
export function coreEngine(): CoreEngine {
  return (shared ??= new CoreEngine());
}

export function setCoreEngineForTests(engine: CoreEngine | null): void {
  shared = engine;
}

export interface CoreAttachOptions {
  terminal: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * A herdr-core attach with PtySession's surface (server/pty/session.ts), so the attachment code
 * drives either. The stream is a byte channel on the shared connection: no pty, no CLI. Keys typed
 * before the attach answers wait for it. `kill` detaches without reporting an exit, as PtySession's does.
 */
export class CoreAttachSession {
  readonly host = "herdr-core" as const;
  readonly exited: Promise<void>;
  private stream: CoreStream | null = null;
  private queued: Uint8Array[] = [];
  private closed = false;
  private paused = false;
  private cols: number;
  private rows: number;
  private resolveExited!: () => void;

  constructor(private readonly options: CoreAttachOptions, engine: CoreEngine = coreEngine()) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
    void this.start(engine);
  }

  private async start(engine: CoreEngine): Promise<void> {
    const decoder = new TextDecoder();
    try {
      const { connection } = await engine.ready();
      const attached = await connection.call<{ channel: number }>("terminal.attach", { terminal: this.options.terminal, cols: this.cols, rows: this.rows, history: 0 });
      const stream = connection.stream(attached.channel, {
        onData: (bytes) => {
          const text = decoder.decode(bytes, { stream: true });
          if (text && !this.closed) this.options.onData(text);
        },
        onClose: (reason) => this.finish(reason === null ? null : typeof reason["exit_code"] === "number" ? reason["exit_code"] : 0),
      });
      if (this.closed) {
        stream.close();
        return;
      }
      this.stream = stream;
      if (this.paused) stream.pause();
      if (this.cols !== this.options.cols || this.rows !== this.options.rows) stream.resize(this.cols, this.rows);
      for (const bytes of this.queued) stream.write(bytes);
      this.queued = [];
    } catch (error) {
      if (!this.closed) this.options.onData(`\r\n${(error as Error)?.message ?? "herdr-core attach failed"}\r\n`);
      this.finish(1);
    }
  }

  private finish(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stream = null;
    this.resolveExited();
    this.options.onExit(code);
  }

  write(data: string): boolean {
    if (this.closed) return false;
    const bytes = new TextEncoder().encode(data);
    if (this.stream) this.stream.write(bytes);
    else this.queued.push(bytes);
    return true;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.stream?.resize(cols, rows);
  }

  /** herdr-core has no same-size SIGWINCH; a resize to the current grid is the nearest ask for a repaint. */
  winch(): void {
    this.stream?.resize(this.cols, this.rows);
  }

  pause(): void {
    this.paused = true;
    this.stream?.pause();
  }

  resume(): void {
    this.paused = false;
    this.stream?.resume();
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.close();
    this.stream = null;
    this.resolveExited();
  }
}
