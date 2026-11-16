import { describe, expect, test } from "bun:test";
import { HerdrError } from "../herdr/client.ts";
import { CoreConnection } from "./connection.ts";
import { FakeCore, until } from "./core.fake.ts";
import { CLOSE, CREDIT, DATA, encodeFrame, FrameReader, HEADER_BYTES, MAX_PAYLOAD, RESIZE } from "./frames.ts";

describe("frame codec", () => {
  test("encodes channel, kind and length little-endian", () => {
    const frame = encodeFrame(0x01020304, RESIZE, new Uint8Array([9, 8]));
    expect([...frame]).toEqual([4, 3, 2, 1, RESIZE, 2, 0, 0, 0, 9, 8]);
  });

  test("reads frames whatever the chunk boundaries", () => {
    const bytes = new Uint8Array([
      ...encodeFrame(0, DATA, new TextEncoder().encode('{"id":1}')),
      ...encodeFrame(7, CREDIT, new Uint8Array([1, 0, 0, 0])),
      ...encodeFrame(7, CLOSE),
    ]);
    for (const step of [1, 2, 5, HEADER_BYTES, bytes.length]) {
      const reader = new FrameReader();
      const frames = [];
      for (let at = 0; at < bytes.length; at += step) frames.push(...reader.push(bytes.subarray(at, at + step)));
      expect(frames.map((f) => [f.channel, f.kind, f.payload.length])).toEqual([[0, DATA, 8], [7, CREDIT, 4], [7, CLOSE, 0]]);
    }
  });

  test("refuses a frame over 16 MiB", () => {
    const header = new Uint8Array(HEADER_BYTES);
    new DataView(header.buffer).setUint32(5, MAX_PAYLOAD + 1, true);
    expect(() => new FrameReader().push(header)).toThrow();
  });
});

describe("CoreConnection", () => {
  test("says hello framed, then answers calls side by side and maps error kinds", async () => {
    const core = new FakeCore((method, params) => {
      if (method === "terminal.get") throw Object.assign(new Error(`no terminal ${params["terminal"]}`), { kind: "not_found" });
      return { method };
    });
    const connection = await CoreConnection.open(core.transport());
    expect(connection.hello.version).toBe("0.1.11");
    const [a, b] = await Promise.all([connection.call("terminal.list"), connection.call("server.status")]);
    expect(a).toEqual({ method: "terminal.list" });
    expect(b).toEqual({ method: "server.status" });
    const failed = await connection.call("terminal.get", { terminal: "t9" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(HerdrError);
    expect((failed as HerdrError).code).toBe("not_found");
    connection.close();
  });

  test("refuses a core of another generation", async () => {
    const core = new FakeCore(() => null, { generation: 2, version: "1.0.0", methods: [], features: [] });
    const error = await CoreConnection.open(core.transport()).catch((e: unknown) => e);
    expect((error as HerdrError).code).toBe("unsupported_core");
  });

  test("a stream gets frames that came before it was taken, and credits what it handed on", async () => {
    const core = new FakeCore(() => ({ channel: 5 }));
    const connection = await CoreConnection.open(core.transport());
    await connection.call("terminal.attach");
    core.send(5, DATA, new TextEncoder().encode("early"));
    await new Promise((resolve) => setImmediate(resolve)); // the frame is read before the stream exists
    const got: string[] = [];
    const stream = connection.stream(5, { onData: (b) => got.push(new TextDecoder().decode(b)), onClose: () => {} });
    expect(got).toEqual(["early"]);
    await until(() => core.sent(5, CREDIT).length === 1);
    expect(new DataView(core.sent(5, CREDIT)[0]!.buffer).getUint32(0, true)).toBe(5);

    stream.pause();
    core.send(5, DATA, new TextEncoder().encode("abc"));
    await until(() => got.length === 2);
    expect(core.sent(5, CREDIT).length).toBe(1);
    stream.resume();
    await until(() => core.sent(5, CREDIT).length === 2);
    expect(new DataView(core.sent(5, CREDIT)[1]!.buffer).getUint32(0, true)).toBe(3);

    stream.write(new TextEncoder().encode("ls\r"));
    stream.resize(100, 30);
    stream.close();
    await until(() => core.sent(5, CLOSE).length === 1);
    expect(new TextDecoder().decode(core.sent(5, DATA)[0])).toBe("ls\r");
    const resize = new DataView(core.sent(5, RESIZE)[0]!.buffer);
    expect([resize.getUint16(0, true), resize.getUint16(2, true)]).toEqual([100, 30]);
    connection.close();
  });

  test("the core's CLOSE carries its reason; a lost connection fails calls and ends streams with null", async () => {
    const core = new FakeCore((method) => (method === "hang" ? undefined : { channel: 3 }));
    const connection = await CoreConnection.open(core.transport());
    const reasons: unknown[] = [];
    connection.stream(3, { onData: () => {}, onClose: (r) => reasons.push(r) });
    core.send(3, CLOSE, new TextEncoder().encode('{"reason":"exited","exit_code":0}'));
    await until(() => reasons.length === 1);
    expect(reasons[0]).toEqual({ reason: "exited", exit_code: 0 });

    connection.stream(4, { onData: () => {}, onClose: (r) => reasons.push(r) });
    let lost = false;
    connection.onLost(() => (lost = true));
    core.drop();
    await until(() => lost);
    expect(reasons[1]).toBeNull();
    expect(((await connection.call("x").catch((e: unknown) => e)) as HerdrError).code).toBe("closed");
  });
});
