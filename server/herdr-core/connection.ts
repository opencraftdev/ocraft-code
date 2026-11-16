import { HerdrError } from "../herdr/client.ts";
import { CLOSE, CREDIT, DATA, encodeFrame, FrameReader, RESIZE, resizePayload, u32, type Frame } from "./frames.ts";

/** The protocol generation this bridge speaks (herdr-core schema/README.md); a newer one needs a bridge update. */
export const CORE_GENERATION = 1;
const CALL_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;

/** Bytes both ways with the core: `hc connect`'s stdin/stdout, or a fake in tests. */
export interface Transport {
  write: (bytes: Uint8Array) => void;
  readable: ReadableStream<Uint8Array>;
  close: () => void;
  /** what the core printed on stderr, for a refused connect */
  stderr?: () => Promise<string>;
}

export interface HelloResult {
  generation: number;
  version: string;
  methods: string[];
  features: string[];
  core?: { id?: string; name?: string };
  [key: string]: unknown;
}

export interface StreamHandlers {
  onData: (bytes: Uint8Array) => void;
  /** the core ended the stream (its JSON reason), or the connection dropped (`null`) */
  onClose: (reason: Record<string, unknown> | null) => void;
}

/**
 * One byte channel (an attach or an event stream). Credit flows back as bytes are handed on;
 * a paused stream holds its credit, so the core stops sending once the window is spent.
 */
export class CoreStream {
  private owed = 0;
  private paused = false;
  closed = false;

  constructor(private readonly connection: CoreConnection, readonly channel: number, private readonly handlers: StreamHandlers) {}

  /** @internal the connection routes this channel's frames here */
  receive(frame: Frame): void {
    if (this.closed) return;
    if (frame.kind === DATA) {
      this.handlers.onData(frame.payload);
      this.owed += frame.payload.length;
      if (!this.paused) this.flushCredit();
    } else if (frame.kind === CLOSE) {
      this.end(parseReason(frame.payload));
    }
  }

  /** @internal */
  end(reason: Record<string, unknown> | null): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.forget(this.channel);
    this.handlers.onClose(reason);
  }

  write(bytes: Uint8Array): void {
    if (!this.closed && bytes.length > 0) this.connection.send(this.channel, DATA, bytes);
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.connection.send(this.channel, RESIZE, resizePayload(cols, rows));
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.flushCredit();
  }

  /** Detach: the core answers with an empty CLOSE, which nobody needs to wait for. */
  close(): void {
    if (this.closed) return;
    this.connection.send(this.channel, CLOSE, new Uint8Array(0));
    this.end({ reason: "detached" });
  }

  private flushCredit(): void {
    if (this.owed === 0 || this.closed) return;
    this.connection.send(this.channel, CREDIT, u32(this.owed));
    this.owed = 0;
  }
}

function parseReason(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.length === 0) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function coreError(error: unknown): HerdrError {
  const record = (typeof error === "object" && error !== null ? error : {}) as { message?: unknown; data?: { kind?: unknown } };
  const kind = typeof record.data?.kind === "string" ? record.data.kind : "core_error";
  return new HerdrError(kind, typeof record.message === "string" ? record.message : "herdr-core call failed");
}

/**
 * One framed connection to herdr-core: JSON-RPC calls on channel 0 run side by side, and each
 * attach or subscription gets a channel of its own. Unlike herdr 0.9's one-request sockets, this
 * connection stays open; when it drops, every waiting call fails and every stream closes with null.
 */
export class CoreConnection {
  private nextId = 1;
  private readonly replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly streams = new Map<number, CoreStream>();
  /** frames for a channel whose reply has not been handled yet: the reply comes first on the wire, but resolves a tick later */
  private readonly early = new Map<number, Frame[]>();
  private lostHandlers: Array<() => void> = [];
  lost = false;

  private constructor(private readonly transport: Transport, readonly hello: HelloResult) {}

  /** Says hello, switches to framed mode, and starts reading. */
  static async open(transport: Transport, timeoutMs = HELLO_TIMEOUT_MS): Promise<CoreConnection> {
    const reader = transport.readable.getReader();
    const request = { jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true, generation: CORE_GENERATION } };
    transport.write(new TextEncoder().encode(`${JSON.stringify(request)}\n`));
    let pending = new Uint8Array(0);
    let line: Uint8Array | null = null;
    const deadline = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
    try {
      while (line === null) {
        const { done, value } = await reader.read();
        if (done) break;
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        const newline = joined.indexOf(0x0a);
        if (newline === -1) pending = joined;
        else {
          line = joined.subarray(0, newline);
          pending = joined.slice(newline + 1);
        }
      }
    } finally {
      clearTimeout(deadline);
    }
    if (line === null) {
      const said = (await transport.stderr?.().catch(() => "")) ?? "";
      transport.close();
      throw new HerdrError("connect_failed", `herdr-core did not answer hello${said.trim() ? `: ${said.trim().slice(0, 500)}` : ""}`);
    }
    let reply: { result?: HelloResult; error?: unknown };
    try {
      reply = JSON.parse(new TextDecoder().decode(line)) as typeof reply;
    } catch {
      transport.close();
      throw new HerdrError("bad_frame", "herdr-core sent an unreadable hello reply");
    }
    if (reply.error !== undefined || !reply.result) {
      transport.close();
      throw reply.error !== undefined ? coreError(reply.error) : new HerdrError("bad_frame", "herdr-core's hello reply has no result");
    }
    const hello = reply.result;
    if (hello.generation !== CORE_GENERATION) {
      transport.close();
      throw new HerdrError("unsupported_core", `herdr-core speaks protocol generation ${hello.generation}; this bridge speaks ${CORE_GENERATION}`);
    }
    const connection = new CoreConnection(transport, hello);
    void connection.pump(reader, pending);
    return connection;
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array): Promise<void> {
    const frames = new FrameReader();
    try {
      if (first.length > 0) this.route(frames.push(first));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.route(frames.push(value));
      }
    } catch {
      /* an oversized frame or a broken pipe: either way the connection is over */
    }
    this.drop();
  }

  private route(frames: Frame[]): void {
    for (const frame of frames) {
      if (frame.channel === 0) {
        if (frame.kind === DATA) this.reply(frame.payload);
        continue;
      }
      const stream = this.streams.get(frame.channel);
      if (stream) stream.receive(frame);
      else {
        const held = this.early.get(frame.channel) ?? [];
        held.push(frame);
        this.early.set(frame.channel, held);
      }
    }
  }

  private reply(payload: Uint8Array): void {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(new TextDecoder().decode(payload)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.replies.get(message.id);
    if (!waiting) return;
    this.replies.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error !== undefined && message.error !== null) waiting.reject(coreError(message.error));
    else waiting.resolve(message.result ?? null);
  }

  private drop(): void {
    if (this.lost) return;
    this.lost = true;
    for (const [, waiting] of this.replies) {
      clearTimeout(waiting.timer);
      waiting.reject(new HerdrError("closed", "lost the connection to herdr-core"));
    }
    this.replies.clear();
    for (const stream of [...this.streams.values()]) stream.end(null);
    this.early.clear();
    this.transport.close();
    for (const handler of this.lostHandlers) handler();
    this.lostHandlers = [];
  }

  onLost(handler: () => void): void {
    if (this.lost) handler();
    else this.lostHandlers.push(handler);
  }

  send(channel: number, kind: number, payload: Uint8Array): void {
    if (this.lost) return;
    try {
      this.transport.write(encodeFrame(channel, kind, payload));
    } catch {
      this.drop();
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.lost) return Promise.reject(new HerdrError("closed", "lost the connection to herdr-core"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        reject(new HerdrError("timeout", `herdr-core ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.replies.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(0, DATA, new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  /** Takes a channel a reply named, with the frames that arrived for it meanwhile. */
  stream(channel: number, handlers: StreamHandlers): CoreStream {
    const stream = new CoreStream(this, channel, handlers);
    if (this.lost) {
      queueMicrotask(() => stream.end(null));
      return stream;
    }
    this.streams.set(channel, stream);
    const held = this.early.get(channel) ?? [];
    this.early.delete(channel);
    for (const frame of held) stream.receive(frame);
    return stream;
  }

  /** @internal */
  forget(channel: number): void {
    this.streams.delete(channel);
  }

  close(): void {
    this.drop();
  }
}

/** `hc connect` as a child process: its stdin and stdout are the transport. Never a pty. */
export function spawnCoreTransport(bin: string, env: Record<string, string | undefined> = process.env): Transport {
  const proc = Bun.spawn([bin, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  let closed = false;
  return {
    write(bytes) {
      proc.stdin.write(bytes);
      void proc.stdin.flush();
    },
    readable: proc.stdout,
    close() {
      if (closed) return;
      closed = true;
      try {
        void proc.stdin.end();
      } catch {
        /* already gone */
      }
      proc.kill();
    },
    stderr: () => new Response(proc.stderr).text(),
  };
}
