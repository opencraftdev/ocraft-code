import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnCoreTransport } from "./connection.ts";
import { CoreAttachSession, CoreEngine } from "./engine.ts";

/**
 * Against a real herdr-core: set OVIS_TEST_HC_BIN to an `hc` built from herdr-core
 * (`cargo build --release -p herdr-core`, Zig 0.16). The core runs on its own HOME, XDG dirs,
 * session and socket under a temporary directory, never the user's, and is stopped afterwards.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

describe.skipIf(!bin)("herdr-core engine on a real core", () => {
  // short: a Unix socket path is limited to about 100 bytes, and the holder sockets are longer
  const root = bin ? mkdtempSync("/tmp/ovhc-") : "/nonexistent";
  const env = {
    PATH: process.env["PATH"],
    HOME: root,
    XDG_STATE_HOME: join(root, "s"),
    XDG_CONFIG_HOME: join(root, "c"),
    XDG_RUNTIME_DIR: join(root, "r"),
    HC_SESSION: "ovis-test",
    HC_SOCKET: join(root, "hc.sock"),
    SHELL: "/bin/sh",
  };
  const engine = new CoreEngine(() => spawnCoreTransport(bin!, env));

  afterAll(async () => {
    await engine.close();
    Bun.spawnSync([bin!, "server", "stop"], { env });
    rmSync(root, { recursive: true, force: true });
  });

  test("a terminal run on the core is a pane, attaches, and takes input", async () => {
    const { connection } = await engine.ready();
    // the `created` event reaches the engine's subscription after the reply
    const created = new Promise<void>((resolve) => {
      const stop = engine.listen((notice) => {
        if (notice.kind === "structure") {
          stop();
          resolve();
        }
      });
    });
    const address = (await connection.call<{ address: string }>("terminal.run", { argv: ["/bin/sh"], cwd: root, keep: false, size: { cols: 80, rows: 24 } })).address;
    await created;
    const pane = await engine.paneGet(`hc:loose:${address}`);
    expect(pane.terminal_id).toBe(address);

    let out = "";
    const echoed = new Promise<void>((resolve) => {
      const session = new CoreAttachSession({ terminal: address, cols: 80, rows: 24, onData: (d) => { out += d; if (out.includes("ovis-42")) { session.kill(); resolve(); } }, onExit: () => {} }, engine);
      session.write("echo ovis-$((6*7))\r");
    });
    await echoed;
    expect(out).toContain("ovis-42");
    await engine.paneSendKeys(pane.pane_id, ["ctrl+d"]);
  }, 30_000);
});
