import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

  test("a reporting program is an agent: its process, a prompt, and an output wait", async () => {
    const { connection } = await engine.ready();
    const reported = new Promise<void>((resolve) => {
      const stop = engine.listen((notice) => {
        if (notice.kind === "status") {
          stop();
          resolve();
        }
      });
    });
    // reports itself as Claude (OSC 7501), then stays a shell that runs what is sent
    const script = "printf '\\033]7501;state=idle:app=claude\\033\\\\'; exec /bin/sh";
    const address = (await connection.call<{ address: string }>("terminal.run", { argv: ["/bin/sh", "-c", script], cwd: root, keep: false, size: { cols: 80, rows: 24 } })).address;
    await reported;
    const paneId = `hc:loose:${address}`;

    const agent = (await engine.rpc("agent.get", { target: paneId })) as { agent: { agent: string; terminal_id: string } };
    expect([agent.agent.agent, agent.agent.terminal_id]).toEqual(["claude", address]);
    const waited = engine.rpc("pane.wait_for_output", { pane_id: paneId, source: "recent", match: { type: "substring", value: "ovis-84" }, timeout_ms: 10_000 });
    await engine.rpc("agent.prompt", { target: paneId, text: "echo ovis-$((2*42))" });
    expect(await waited).toEqual({ type: "output_matched", pane_id: paneId, matched_line: "ovis-84" });

    // the shell answered, so it is the foreground now (the core learns it after the program starts)
    const info = (await engine.rpc("pane.process_info", { pane_id: paneId })) as { process_info: { shell_pid: number; foreground_processes: { pid: number; name: string; cwd: string }[] } };
    expect(info.process_info.shell_pid).toBeGreaterThan(0);
    expect(info.process_info.foreground_processes).toHaveLength(1);
    expect(info.process_info.foreground_processes[0]!.name).toMatch(/^(sh|bash|dash)$/); // macOS's /bin/sh is bash
    expect(realpathSync(info.process_info.foreground_processes[0]!.cwd)).toBe(realpathSync(root));
    await engine.paneSendKeys(paneId, ["ctrl+d"]);
  }, 30_000);
});
