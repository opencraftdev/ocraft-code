/**
 * The Assistant VM's health check, end to end, against a running VM
 * (docs/plan/20261112-1622-assistant-delegation.md):
 *
 *   bun scripts/assistant-check.ts <vm-address> [--ssh user@host] [--browser] [--out <dir>]
 *
 * Read only. It checks, and prints PASS or FAIL for each:
 * - the page says it is the Assistant VM
 * - every machine is connected with no problem, and there is at least one
 * - long-lived: the one Assistant session has a live pane and is not restarting; its age and last
 *   compaction are printed, and its conversation reads
 * - with --ssh: `ovis-task machines` and `ovis-task sessions` answer on the VM itself, as the
 *   Assistant's own pane runs them
 * - with --browser: the VM's Code mode on the Assistant's pane shows the agent panel beside it, with
 *   its Sessions section, and the chat without "Couldn't load the conversation"
 *
 * Exits 1 when any check fails. Screenshots go to --out (default: a temp folder).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AssistantState } from "../shared/assistant.ts";

export interface CheckResult { name: string; ok: boolean; detail: string }

/** a duration as a person reads it: 3d 4h, 2h 5m, 7m */
export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24];
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** the checks a state alone answers: machines, and the long-lived session */
export function assessState(state: AssistantState, now = Date.now()): CheckResult[] {
  const results: CheckResult[] = [];
  const broken = state.machines.filter((machine) => machine.state !== "connected" || (machine.health?.problems.length ?? 1) > 0);
  results.push({
    name: "machines",
    ok: state.machines.length > 0 && broken.length === 0,
    detail: state.machines.length === 0 ? "no machines: add one with herdr machine add on the VM, then Connect it"
      : broken.length === 0 ? state.machines.map((machine) => `${machine.name} (${machine.health?.agents.join(", ") || "no agents"})`).join("; ")
        : broken.map((machine) => `${machine.name}: ${machine.state}${machine.health ? ` ${machine.health.problems.join(", ")}` : " not checked yet"}`).join("; "),
  });
  const session = state.session;
  results.push({
    name: "long-lived",
    ok: !!session?.pane_id && session.state !== "restarting",
    detail: !session ? "no Assistant session yet"
      : `pane ${session.pane_id ?? "none"}, ${session.state}, ${session.agent} for ${age(now - session.started_at)}, `
        + (session.last_compaction === null ? "never compacted" : `compacted ${age(now - session.last_compaction)} ago`),
  });
  return results;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    ssh: { type: "string" }, browser: { type: "boolean" }, out: { type: "string" },
  } });
  if (positionals.length !== 1) { console.error("usage: bun scripts/assistant-check.ts <vm-address> [--ssh user@host] [--browser] [--out <dir>]"); return 2; }
  const base = new URL(/^https?:\/\//.test(positionals[0]!) ? positionals[0]! : `https://${positionals[0]}`).origin;
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`); };
  const get = (path: string) => fetch(`${base}${path}`, { headers: { origin: base } });

  const health = await get("/api/health").then((response) => response.json() as Promise<{ web_ui?: { assistant?: boolean; revision?: string | null } }>).catch((error: unknown) => ({ failed: String(error) }));
  if ("failed" in health) { check("reachable", false, `${base}: ${health.failed}`); return 1; }
  check("assistant VM", health.web_ui?.assistant === true, `revision ${health.web_ui?.revision ?? "unknown"}${health.web_ui?.assistant ? "" : ": OVIS_ASSISTANT=1 is not set on this server"}`);

  const state = await (await get("/api/assistant")).json() as AssistantState;
  for (const result of assessState(state)) check(result.name, result.ok, result.detail);
  const paneId = state.session?.pane_id ?? null;
  if (paneId) {
    const response = await get(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    const body = await response.json().catch(() => null) as { turns?: unknown[]; error?: { message: string } } | null;
    check("conversation", response.ok, response.ok ? `${body?.turns?.length ?? 0} turns` : `${response.status} ${body?.error?.message ?? ""}`);
  }

  if (values.ssh) {
    // as the Assistant's pane runs it: loopback, the CLI token, the checkout's bin/ovis-task
    const script = 'c=$HOME/.local/share/ovis-assistant/ovis; t=$(sed -n \'s/.*"token": *"\\([^"]*\\)".*/\\1/p\' "$HOME/.config/ovis/assistant/cli-token.json"); PATH=$HOME/.bun/bin:$PATH OVIS_TASK_URL=http://127.0.0.1:${OVIS_PORT:-7317} OVIS_TASK_TOKEN=$t "$c/bin/ovis-task" machines';
    const run = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", values.ssh, script], { stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString();
    const start = output.indexOf("[");
    let listed: { name: string; folders: string[] }[] | null = null;
    try { listed = start < 0 ? null : JSON.parse(output.slice(start)); } catch { listed = null; }
    check("ovis-task machines", run.exitCode === 0 && Array.isArray(listed), listed ? listed.map((machine) => `${machine.name}: ${machine.folders.length} folders`).join("; ") : (run.stderr.toString() || output).trim().slice(-300));
    // every herdr session the Assistant delegates to, read as its pane reads them
    const sessions = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", values.ssh, script.replace(/ machines$/, " sessions")], { stdout: "pipe", stderr: "pipe" });
    const sessionText = sessions.stdout.toString();
    let seen: { machine: string; workspaces: { panes: unknown[] }[] }[] | null = null;
    try { seen = JSON.parse(sessionText.slice(sessionText.indexOf("["))); } catch { seen = null; }
    check("ovis-task sessions", sessions.exitCode === 0 && Array.isArray(seen), seen ? seen.map((machine) => `${machine.machine}: ${machine.workspaces.reduce((sum, workspace) => sum + workspace.panes.length, 0)} panes`).join("; ") : (sessions.stderr.toString() || sessionText).trim().slice(-300));
  }

  if (values.browser) {
    const { chromium } = await import("playwright-core");
    const { chromePath } = await import("./chrome-path.ts");
    const out = values.out ?? mkdtempSync(join(tmpdir(), "assistant-check-"));
    const browser = await chromium.launch({ executablePath: chromePath() });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      // the VM's own Code mode on the Assistant's pane: Code mode's agent panel beside it, with its Sessions section
      await page.goto(`${base}/?pane=${encodeURIComponent(paneId ?? "")}&view=chat`, { waitUntil: "load" });
      const sessions = page.locator("#agent-details-panel").getByText("Sessions", { exact: true });
      if (!(await sessions.first().waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
        await page.getByRole("button", { name: /Show agent panel|Workspace and agents/ }).click().catch(() => {});
      }
      const shown = await sessions.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      check("agent panel", shown, shown ? "the agent panel with Sessions beside the Assistant's chat" : "no Sessions section in the agent panel beside the Assistant's chat");
      // true when the error shows within 15 s: waits on the text itself, no fixed sleep
      const failed = await page.getByText("Couldn't load the conversation").waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      await page.screenshot({ path: join(out, "chat.png") });
      check("chat page", !failed, failed ? "Couldn't load the conversation" : "drawn without an error in 15 s");
      console.log(`screenshots: ${out}`);
    } finally { await browser.close(); }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(failed.length === 0 ? `\nall ${results.length} checks passed` : `\n${failed.length} of ${results.length} checks failed`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
