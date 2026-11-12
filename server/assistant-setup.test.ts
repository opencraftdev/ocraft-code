import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantSetupEvent, AssistantSetupJob } from "../shared/assistant.ts";
import { installCommand, installScriptUrl, validateSetup } from "./assistant-setup.ts";
import { createServer } from "./index.ts";
import { shellQuote } from "./machine-security.ts";
import { sidecarAvailable } from "./pty/sidecar.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SCRIPT_URL = `https://raw.githubusercontent.com/opencraftdev/ocraft-code/${REVISION}/scripts/install-assistant.sh`;

describe("what a VM setup runs", () => {
  it("takes only a valid SSH address, name and agent", () => {
    expect(validateSetup({ destination: "ubuntu@vm.example", port: 2222, name: "ovis-assistant", agent: "codex" }))
      .toEqual({ target: { destination: "ubuntu@vm.example", port: 2222 }, name: "ovis-assistant", agent: "codex", cols: 100, rows: 30 });
    for (const destination of ["-oProxyCommand=touch /tmp/x", "vm example", "vm;id", "", 7]) {
      expect(() => validateSetup({ destination, name: "vm", agent: "claude" })).toThrow();
    }
    for (const port of [0, 70000, "22", 1.5]) expect(() => validateSetup({ destination: "vm", port, name: "vm", agent: "claude" })).toThrow();
    for (const name of ["My VM", "vm-", "-vm", "vm;id", "$(id)", "vm' ; rm -rf ~ ; '", "vm\nid", "", 1]) {
      expect(() => validateSetup({ destination: "vm", name, agent: "claude" })).toThrow();
    }
    for (const agent of ["gemini", "claude;id", "", null]) expect(() => validateSetup({ destination: "vm", name: "vm", agent })).toThrow();
  });

  it("fetches the script at the server's own commit, or main when it is unknown", () => {
    expect(installScriptUrl(REVISION)).toBe(SCRIPT_URL);
    for (const unknown of [undefined, "", "main; id", "not-a-sha"]) expect(installScriptUrl(unknown)).toContain("/ocraft-code/main/scripts/install-assistant.sh");
    expect(installCommand(REVISION, "my-vm", "claude")).toBe(`curl -fsSL '${SCRIPT_URL}' | ASSISTANT_NAME='my-vm' ASSISTANT_AGENT='claude' bash`);
    expect(() => installCommand(REVISION, "vm'; id; '", "claude")).toThrow();
  });
});

/**
 * A fake `ssh` (OVIS_SSH) that stands in for both of Remote PCs' runs: the master connection (`-M`),
 * which asks about a host key through ssh's askpass helper as OpenSSH does, and the `-tt` run of the
 * install, which prints what the mode file says. It never reaches a host.
 */
const FAKE_SSH = `#!/bin/bash
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/calls"
mode="$(cat "$dir/mode" 2>/dev/null)"
control=""; prev=""
for arg in "$@"; do [ "$prev" = -S ] && control="$arg"; prev="$arg"; done
case " $* " in *" -M "*)
  if [ "$mode" = changed ]; then
    echo "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@" >&2
    echo "Host key verification failed." >&2
    exit 255
  fi
  answer="$("$SSH_ASKPASS" "The authenticity of host 'vm.example' can't be established.
ED25519 key fingerprint is SHA256:fakefingerprint.
Are you sure you want to continue connecting (yes/no)? ")"
  if [ "$answer" != yes ]; then echo "Host key verification failed." >&2; exit 255; fi
  : > "$control"
  exec sleep 600
;; esac
printf '%s' "\${@: -1}" > "$dir/remote"
printf 'Assistant: installing\\r\\n'
if [ "$mode" = hang ]; then echo $$ > "$dir/pid"; exec sleep 600; fi
printf 'Assistant: the Assistant is at \\033[1mhttps://my-vm.tail1234.ts.net\\033[0m\\r\\n'
exit 0
`;

describe.skipIf(process.platform === "win32")("POST /api/assistant-setup", () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-assistant-setup-"));
  const fake = join(root, "ssh");
  const saved = process.env["OVIS_SSH"];
  beforeAll(() => {
    writeFileSync(fake, FAKE_SSH, { mode: 0o755 });
    process.env["OVIS_SSH"] = fake;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env["OVIS_SSH"]; else process.env["OVIS_SSH"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  const server = (options: { token?: string; pty?: boolean; assistant?: boolean } = {}) => {
    const stateDir = mkdtempSync(join(root, "state-"));
    for (const file of ["calls", "mode", "remote", "pid"]) rmSync(join(root, file), { force: true });
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: options.token ?? "", stateDir, tailscaleOwner: null, assistant: options.assistant ?? false,
      assistantSetup: { revision: REVISION, ...(options.pty === false ? { ptyAvailable: () => false } : {}) } });
    const base = `http://127.0.0.1:${app.port}`;
    const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/assistant-setup${path}`, body === undefined ? { headers: { origin: base, ...headers } }
      : { method: "POST", headers: { "content-type": "application/json", origin: base, "x-herdr-machine": "1", ...headers }, body: JSON.stringify(body) });
    const job = async () => ((await (await call("")).json()) as { job: AssistantSetupJob | null }).job;
    const until = async (done: (job: AssistantSetupJob | null) => boolean) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const current = await job();
        if (done(current)) return current!;
        if (Date.now() > deadline) throw new Error(`setup stayed ${JSON.stringify(current)}`);
        await Bun.sleep(25);
      }
    };
    return { app, base, call, job, until, close: () => { app.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
  };
  const START = { destination: "ubuntu@vm.example", port: 2222, name: "my-vm", agent: "claude" };

  it("answers only this app's own pages, a signed-in device, and never on the Assistant VM", async () => {
    const open = server();
    try {
      expect((await open.call("", START, { origin: "https://evil.example" })).status).toBe(403);
      expect((await fetch(`${open.base}/api/assistant-setup`, { method: "POST", headers: { "content-type": "application/json", origin: open.base }, body: JSON.stringify(START) })).status).toBe(403);
      expect((await open.call("/stream", undefined, { origin: "https://evil.example" })).status).toBe(403);
      expect(existsSync(join(root, "calls"))).toBe(false);
    } finally { open.close(); }
    const signedOut = server({ token: "setup-test-token" });
    try { expect((await signedOut.call("", START)).status).toBe(401); } finally { signedOut.close(); }
    const vm = server({ assistant: true });
    try { expect((await vm.call("", START)).status).toBe(404); } finally { vm.close(); }
  });

  it("refuses a name that would be shell text before any SSH runs", async () => {
    const app = server();
    try {
      const response = await app.call("", { ...START, name: "x'; touch /tmp/owned; '" });
      expect(response.status).toBe(400);
      expect(existsSync(join(root, "calls"))).toBe(false);
    } finally { app.close(); }
  });

  it("without a PTY host, gives the command to paste instead", async () => {
    const app = server({ pty: false });
    try {
      const response = await app.call("", START);
      expect(response.status).toBe(202);
      const job = (await response.json()) as AssistantSetupJob;
      expect(job.phase).toBe("unsupported");
      expect(job.command).toBe(installCommand(REVISION, "my-vm", "claude"));
      expect(existsSync(join(root, "calls"))).toBe(false);
    } finally { app.close(); }
  });

  it.skipIf(!sidecarAvailable())("asks to trust a new host, runs the install over ssh -tt and picks up the VM's address", async () => {
    const app = server();
    try {
      const started = await app.call("", { ...START, cols: 80, rows: 24 });
      expect(started.status).toBe(202);
      const asked = await app.until((job) => job?.phase === "authentication");
      expect(asked.challenge?.kind).toBe("host_key");
      expect(asked.challenge?.prompt).toContain("SHA256:fakefingerprint");
      // the stream replays the terminal to a page that joins late
      const stream = await app.call("/stream");
      expect((await app.call("/answer", { challenge_id: asked.challenge!.id, answer: "yes" })).status).toBe(200);
      const done = await app.until((job) => job?.phase === "done" || job?.phase === "failed");
      expect(done).toMatchObject({ phase: "done", address: "https://my-vm.tail1234.ts.net", error: null });
      const reader = stream.body!.getReader();
      let text = "";
      while (!text.includes("my-vm.tail1234")) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      const events = text.split("\n\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as AssistantSetupEvent);
      expect(events.some((event) => event.type === "output" && event.data.includes("installing"))).toBe(true);
      // the exact command, and the address only as ssh's own argument
      const run = readFileSync(join(root, "calls"), "utf8").split("\n").find((line) => line.includes("-tt"))!;
      expect(run).toContain("-o Port=2222");
      expect(run).toMatch(/ -tt ubuntu@vm\.example sh -c /);
      expect(readFileSync(join(root, "remote"), "utf8")).toBe(`sh -c ${shellQuote(installCommand(REVISION, "my-vm", "claude"))}`);
    } finally { app.close(); }
  });

  it("refuses a host whose key changed without asking", async () => {
    const app = server();
    writeFileSync(join(root, "mode"), "changed");
    try {
      await app.call("", START);
      const failed = await app.until((job) => job?.phase === "failed");
      expect(failed.challenge).toBeNull();
      expect(failed.error).toContain("Host key verification failed");
      expect(existsSync(join(root, "remote"))).toBe(false);
    } finally { app.close(); }
  });

  it.skipIf(!sidecarAvailable())("runs one setup at a time, and stop ends its SSH session", async () => {
    const app = server();
    writeFileSync(join(root, "mode"), "hang");
    try {
      await app.call("", START);
      const asked = await app.until((job) => job?.phase === "authentication");
      await app.call("/answer", { challenge_id: asked.challenge!.id, answer: "yes" });
      await app.until((job) => job?.phase === "running" && existsSync(join(root, "pid")));
      expect((await app.call("", START)).status).toBe(409);
      const pid = Number(readFileSync(join(root, "pid"), "utf8"));
      expect(((await (await app.call("/stop", {})).json()) as { job: AssistantSetupJob }).job.phase).toBe("stopped");
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 10_000;
      while (alive()) {
        if (Date.now() > deadline) throw new Error("the install's ssh outlived stop");
        await Bun.sleep(25);
      }
      // stopped, a new setup may start
      expect((await app.call("", START)).status).toBe(202);
      await app.call("/stop", {});
    } finally { app.close(); }
  });
});
