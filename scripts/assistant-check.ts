/**
 * The Assistant VM's health check, end to end, against a running VM (docs/plan/20261111-2112-assistant.md):
 *
 *   bun scripts/assistant-check.ts <vm-address> [--ssh user@host] [--browser] [--new-chat] [--out <dir>]
 *
 * Read only by default. It checks, and prints PASS or FAIL for each:
 * - the page says it is the Assistant VM, and its policy lets its own tailnet frame it
 * - every machine is connected with no problem, and there is at least one
 * - the current chat has a pane, and that pane's conversation reads
 * - every archived chat's transcript reads
 * - with --ssh: `ovis-task machines` and `ovis-task sessions` answer on the VM itself, as the
 *   Assistant's own pane runs them
 * - with --browser: the VM's Code mode on the Assistant's chat shows the Assistant panel (New chat,
 *   tasks) beside it, the chat without "Couldn't load the conversation", and an earlier chat's answer
 *   drawn as Markdown, not as raw `**`
 * - with --new-chat (it archives the current chat): New chat in the panel opens the new chat, without
 *   an error
 *
 * Exits 1 when any check fails. Screenshots go to --out (default: a temp folder).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AssistantState } from "../shared/assistant.ts";

export interface CheckResult { name: string; ok: boolean; detail: string }

/** the checks a state alone answers: machines, and the current chat */
export function assessState(state: AssistantState): CheckResult[] {
  const results: CheckResult[] = [];
  const broken = state.machines.filter((machine) => machine.state !== "connected" || (machine.health?.problems.length ?? 1) > 0);
  results.push({
    name: "machines",
    ok: state.machines.length > 0 && broken.length === 0,
    detail: state.machines.length === 0 ? "no machines: add one with herdr machine add on the VM, then Connect it"
      : broken.length === 0 ? state.machines.map((machine) => `${machine.name} (${machine.health?.agents.join(", ") || "no agents"})`).join("; ")
        : broken.map((machine) => `${machine.name}: ${machine.state}${machine.health ? ` ${machine.health.problems.join(", ")}` : " not checked yet"}`).join("; "),
  });
  const current = state.sessions.find((session) => session.archived_at === undefined);
  results.push({ name: "current chat", ok: !!current?.pane_id, detail: current ? `${current.name} pane ${current.pane_id ?? "none"}` : "no current chat" });
  return results;
}

/** the tailnet a `*.ts.net` address is in, or null */
export function tailnetOf(host: string): string | null {
  return /^[a-z0-9-]+\.([a-z0-9-]+\.ts\.net)$/i.exec(host)?.[1] ?? null;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    ssh: { type: "string" }, browser: { type: "boolean" }, "new-chat": { type: "boolean" }, out: { type: "string" },
  } });
  if (positionals.length !== 1) { console.error("usage: bun scripts/assistant-check.ts <vm-address> [--ssh user@host] [--browser] [--new-chat] [--out <dir>]"); return 2; }
  const base = new URL(/^https?:\/\//.test(positionals[0]!) ? positionals[0]! : `https://${positionals[0]}`).origin;
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`); };
  const get = (path: string) => fetch(`${base}${path}`, { headers: { origin: base } });

  const health = await get("/api/health").then((response) => response.json() as Promise<{ web_ui?: { assistant?: boolean; revision?: string | null } }>).catch((error: unknown) => ({ failed: String(error) }));
  if ("failed" in health) { check("reachable", false, `${base}: ${health.failed}`); return 1; }
  check("assistant VM", health.web_ui?.assistant === true, `revision ${health.web_ui?.revision ?? "unknown"}${health.web_ui?.assistant ? "" : ": OVIS_ASSISTANT=1 is not set on this server"}`);
  const policy = (await get("/")).headers.get("content-security-policy") ?? "";
  const tailnet = tailnetOf(new URL(base).hostname);
  if (tailnet) check("framing", policy.includes(`https://*.${tailnet}`), /frame-ancestors[^;]*/.exec(policy)?.[0] ?? "no frame-ancestors");

  const state = await (await get("/api/assistant")).json() as AssistantState;
  for (const result of assessState(state)) check(result.name, result.ok, result.detail);
  const current = state.sessions.find((session) => session.archived_at === undefined);
  if (current?.pane_id) {
    const response = await get(`/api/pane/conversation?pane_id=${encodeURIComponent(current.pane_id)}`);
    const body = await response.json().catch(() => null) as { turns?: unknown[]; error?: { message: string } } | null;
    check("conversation", response.ok, response.ok ? `${body?.turns?.length ?? 0} turns` : `${response.status} ${body?.error?.message ?? ""}`);
  }
  const archived = state.sessions.filter((session) => session.archived_at !== undefined);
  const failedTranscripts: string[] = [];
  // an archived chat with **bold** in an answer: the one the browser check opens
  let withBold: string | null = null;
  for (const session of archived) {
    const response = await get(`/api/assistant/sessions/${encodeURIComponent(session.name)}`);
    if (!response.ok) { failedTranscripts.push(session.name); continue; }
    const transcript = await response.json() as { turns: { role: string; text: string }[] };
    if (withBold === null && transcript.turns.some((turn) => turn.role !== "user" && /\*\*[^*\n]+\*\*/.test(turn.text))) withBold = session.name;
  }
  check("archived chats", failedTranscripts.length === 0, failedTranscripts.length ? `unreadable: ${failedTranscripts.join(", ")}` : `${archived.length} read`);

  if (values.ssh) {
    // as the Assistant's pane runs it: loopback, the CLI token, the checkout's bin/ovis-task
    const script = 'c=$HOME/.local/share/ovis-assistant/ovis; t=$(sed -n \'s/.*"token": *"\\([^"]*\\)".*/\\1/p\' "$HOME/.config/ovis/assistant/cli-token.json"); PATH=$HOME/.bun/bin:$PATH OVIS_TASK_URL=http://127.0.0.1:${OVIS_PORT:-7317} OVIS_TASK_TOKEN=$t "$c/bin/ovis-task" machines';
    const run = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", values.ssh, script], { stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString();
    const start = output.indexOf("[");
    let listed: { name: string; folders: string[] }[] | null = null;
    try { listed = start < 0 ? null : JSON.parse(output.slice(start)); } catch { listed = null; }
    check("ovis-task machines", run.exitCode === 0 && Array.isArray(listed), listed ? listed.map((machine) => `${machine.name}: ${machine.folders.length} folders`).join("; ") : (run.stderr.toString() || output).trim().slice(-300));
    // every herdr session the Assistant coordinates, read as its pane reads them
    const sessions = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", values.ssh, script.replace(/ machines$/, " sessions")], { stdout: "pipe", stderr: "pipe" });
    const sessionText = sessions.stdout.toString();
    let seen: { machine: string; workspaces: { panes: unknown[] }[] }[] | null = null;
    try { seen = JSON.parse(sessionText.slice(sessionText.indexOf("["))); } catch { seen = null; }
    check("ovis-task sessions", sessions.exitCode === 0 && Array.isArray(seen), seen ? seen.map((machine) => `${machine.machine}: ${machine.workspaces.reduce((sum, workspace) => sum + workspace.panes.length, 0)} panes`).join("; ") : (sessions.stderr.toString() || sessionText).trim().slice(-300));
  }

  if (values.browser || values["new-chat"]) {
    const { chromium } = await import("playwright-core");
    const { chromePath } = await import("./chrome-path.ts");
    const out = values.out ?? mkdtempSync(join(tmpdir(), "assistant-check-"));
    const browser = await chromium.launch({ executablePath: chromePath() });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      // the VM's own Code mode on the Assistant's chat: its panel takes the agent panel's place
      await page.goto(`${base}/?pane=${encodeURIComponent(current?.pane_id ?? "")}&view=chat`, { waitUntil: "load" });
      const panel = page.locator("#agent-details-panel.assistant-agent-panel");
      const newChat = panel.getByRole("button", { name: "New chat" });
      if (!(await newChat.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
        await page.getByRole("button", { name: /Show agent panel|Workspace and agents/ }).click().catch(() => {});
      }
      const shown = await newChat.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      check("assistant panel", shown, shown ? "New chat and the tasks beside the Assistant's chat" : "no Assistant panel beside the Assistant's chat");
      // true when the error shows within `seconds`: waits on the text itself, no fixed sleep
      const errorShown = (seconds: number) => page.getByText("Couldn't load the conversation").waitFor({ state: "visible", timeout: seconds * 1000 }).then(() => true, () => false);
      if (values["new-chat"]) {
        const before = new URL(page.url()).searchParams.get("pane");
        await newChat.click();
        const moved = await page.waitForURL((url) => { const pane = url.searchParams.get("pane"); return pane !== null && pane !== before; }, { timeout: 30_000 }).then(() => true, () => false);
        const failed = await errorShown(30);
        await page.screenshot({ path: join(out, "new-chat.png") });
        check("new chat", moved && !failed, !moved ? "the view stayed on the old chat" : failed ? "Couldn't load the conversation within 30 s" : `opened ${new URL(page.url()).searchParams.get("pane")} without an error in 30 s`);
      } else {
        const failed = await errorShown(15);
        await page.screenshot({ path: join(out, "chat.png") });
        check("chat page", !failed, failed ? "Couldn't load the conversation" : "drawn without an error in 15 s");
      }
      if (withBold !== null) {
        // the panel lists the newest few earlier chats first
        const showAll = panel.getByRole("button", { name: /^Show all/ });
        if (await showAll.count()) await showAll.click();
        await panel.locator(`.assistant-row[title="${withBold}"]`).click();
        await page.locator(".assistant-transcript").waitFor({ timeout: 15_000 });
        const raw = await page.locator(".assistant-transcript .assistant-turn").evaluateAll((turns) => turns.some((turn) => /\*\*[^*\n]+\*\*/.test(turn.textContent ?? "")));
        await page.screenshot({ path: join(out, "archived.png") });
        check("archived Markdown", !raw, raw ? `${withBold}: an answer shows raw **bold** markers` : `${withBold} drawn as Markdown`);
      } else console.log("skip  archived Markdown: no archived answer has **bold** to check");
      console.log(`screenshots: ${out}`);
    } finally { await browser.close(); }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(failed.length === 0 ? `\nall ${results.length} checks passed` : `\n${failed.length} of ${results.length} checks failed`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
