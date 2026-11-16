import { CLOSE, CREDIT, DATA, encodeFrame, FrameReader, RESIZE, type Frame } from "./frames.ts";
import type { Transport } from "./connection.ts";

/**
 * A herdr-core on the far side of a transport, for tests: it answers hello, then hands every
 * framed JSON-RPC call to `handle` and records stream frames (input, credit, resize, close).
 */
export class FakeCore {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly frames: Frame[] = [];
  closed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private reader = new FrameReader();
  private helloDone = false;
  private pending = "";

  constructor(
    private readonly handle: (method: string, params: Record<string, unknown>) => unknown,
    readonly hello: Record<string, unknown> = { generation: 1, version: "0.1.11", methods: [], features: [], framed: true, core: { id: "c1", name: "here" } },
  ) {}

  transport(): Transport {
    const readable = new ReadableStream<Uint8Array>({ start: (controller) => void (this.controller = controller) });
    return {
      write: (bytes) => this.receive(bytes),
      readable,
      close: () => {
        if (this.closed) return;
        this.closed = true;
        try {
          this.controller.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  private receive(bytes: Uint8Array): void {
    if (!this.helloDone) {
      this.pending += new TextDecoder().decode(bytes);
      const newline = this.pending.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(this.pending.slice(0, newline)) as { id: number };
      this.helloDone = true;
      this.raw(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: this.hello })}\n`));
      return;
    }
    for (const frame of this.reader.push(bytes)) {
      if (frame.channel !== 0) {
        this.frames.push(frame);
        continue;
      }
      const request = JSON.parse(new TextDecoder().decode(frame.payload)) as { id: number; method: string; params: Record<string, unknown> };
      this.calls.push({ method: request.method, params: request.params });
      let reply: Record<string, unknown>;
      try {
        reply = { jsonrpc: "2.0", id: request.id, result: this.handle(request.method, request.params) ?? null };
      } catch (error) {
        reply = { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: (error as Error).message, data: { kind: (error as Error & { kind?: string }).kind ?? "not_found" } } };
      }
      this.send(0, DATA, new TextEncoder().encode(JSON.stringify(reply)));
    }
  }

  raw(bytes: Uint8Array): void {
    if (!this.closed) this.controller.enqueue(bytes);
  }

  send(channel: number, kind: number, payload: Uint8Array = new Uint8Array(0)): void {
    this.raw(encodeFrame(channel, kind, payload));
  }

  /** An event-stream notification line on `channel`. */
  event(channel: number, message: Record<string, unknown>): void {
    this.send(channel, DATA, new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
  }

  /** Frames the client sent on a stream channel, by kind. */
  sent(channel: number, kind: typeof DATA | typeof CREDIT | typeof CLOSE | typeof RESIZE): Uint8Array[] {
    return this.frames.filter((frame) => frame.channel === channel && frame.kind === kind).map((frame) => frame.payload);
  }

  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

/** Resolves once `check` holds, polling each macrotask (bounded): no fixed sleeps. */
export async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never held");
}
