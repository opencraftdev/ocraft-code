/**
 * herdr-core's framed mode (herdr-core schema/README.md, "Framed mode"): every frame is
 * `[channel u32 LE][kind u8][len u32 LE][payload]`, payload at most 16 MiB. Channel 0 carries
 * JSON-RPC both ways; every other channel is one attach or event stream.
 */
export const DATA = 0;
export const CREDIT = 1;
export const CLOSE = 2;
export const RESIZE = 3;
export const FOCUS = 4;
export const FACTS = 5;
export const AUTOMATIC_INPUT = 6;

export const HEADER_BYTES = 9;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface Frame {
  channel: number;
  kind: number;
  payload: Uint8Array;
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, channel, true);
  out[4] = kind;
  view.setUint32(5, payload.length, true);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function resizePayload(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint16(0, cols, true);
  view.setUint16(2, rows, true);
  return out;
}

/**
 * Splits a byte stream into frames, whatever the chunk boundaries. A frame that claims more than
 * MAX_PAYLOAD throws: the stream is out of step and nothing after it can be trusted.
 */
export class FrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const frames: Frame[] = [];
    let at = 0;
    while (joined.length - at >= HEADER_BYTES) {
      const view = new DataView(joined.buffer, joined.byteOffset + at, HEADER_BYTES);
      const length = view.getUint32(5, true);
      if (length > MAX_PAYLOAD) throw new Error(`herdr-core sent a ${length}-byte frame (over ${MAX_PAYLOAD})`);
      if (joined.length - at < HEADER_BYTES + length) break;
      frames.push({
        channel: view.getUint32(0, true),
        kind: joined[at + 4]!,
        payload: joined.slice(at + HEADER_BYTES, at + HEADER_BYTES + length),
      });
      at += HEADER_BYTES + length;
    }
    this.buffer = joined.slice(at);
    return frames;
  }
}
