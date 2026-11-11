import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install-assistant.sh --dry-run, as CI runs it: on a PATH without herdr, Bun, Tailscale or an agent
 * CLI and with no terminal, so every step is printed with its default answer, and nothing is
 * installed, written or signed in.
 */
const SCRIPT = join(import.meta.dir, "install-assistant.sh");

describe.skipIf(process.platform === "win32")("install-assistant.sh --dry-run", () => {
  const dryRun = (env: Record<string, string> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "ovis-assistant-home-"));
    try {
      const result = Bun.spawnSync(["bash", SCRIPT, "--dry-run"], { env: { HOME: home, PATH: "/usr/bin:/bin", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), left: readdirSync(home) };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("prints the whole install and runs none of it", () => {
    const { code, out, left } = dryRun();
    expect(code).toBe(0);
    expect(left).toEqual([]);
    for (const step of [
      "+ sudo tailscale up --hostname=ovis-assistant",
      "+ sh -c curl -fsSL https://herdr.dev/install.sh | sh",
      "+ bash -c curl -fsSL https://bun.sh/install | bash",
      "+ claude auth login",
      "+ git clone --branch main https://github.com/opencraftdev/ocraft-code.git",
      "Environment=HOST=127.0.0.1 PORT=7317 OVIS_ASSISTANT=1 OVIS_ASSISTANT_AGENT=claude",
      "+ systemctl --user enable herdr.service ovis-assistant.service",
      "+ tailscale serve --bg --https=443 http://127.0.0.1:7317",
    ]) expect(out).toContain(step);
  });

  it("takes its answers from the environment, and never prints the auth key", () => {
    const { code, out } = dryRun({ ASSISTANT_NAME: "my-vm", TS_AUTHKEY: "tskey-auth-secret", ASSISTANT_AGENT: "codex" });
    expect(code).toBe(0);
    expect(out).toContain("+ sudo tailscale up --hostname=my-vm --auth-key=<auth key>");
    expect(out).toContain("+ codex login --device-auth");
    expect(out).toContain("OVIS_ASSISTANT_AGENT=codex");
    expect(out).not.toContain("tskey-auth-secret");
  });

  it("refuses a name Tailscale cannot take and an unknown agent", () => {
    expect(dryRun({ ASSISTANT_NAME: "My VM" }).code).not.toBe(0);
    expect(dryRun({ ASSISTANT_AGENT: "gemini" }).code).not.toBe(0);
  });
});
