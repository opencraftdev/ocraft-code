import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The Assistant's voice mode (docs/plan/20261115-1240-assistant-voice.md) on the unmodified app over
// the demo's fixture transport. The roster gains a fictional Assistant VM at build time (as
// scripts/assistant-mentions-demo-regression.ts does); the VM's voice routes are answered by a
// stand-in fetch in the page, and the ElevenLabs SDK by a stand-in the test-hook build reads from
// window.__ovisVoiceSdk (lib/assistantVoice.ts). No ElevenLabs, no microphone, no herdr session.
// Checks: the switch in the Assistant's header only, Chat by default; Voice idle without a call;
// a call with captions, a working task card and the level-driven orb; "needs a key"; the toast in
// another pane when the task finishes. Screenshots (dark and light, 1280 and 390) go to argv[2],
// else a temp directory, and their paths are printed.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-assistant-voice-demo-"));
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "assistant-voice-shots-"));
mkdirSync(shots, { recursive: true });

const VM_ADDRESS = "raka-devs.tail38376d.ts.net";
const ASSISTANT_PANE = "w1H:p1";

function snapshot(panes: { id: string; folder: string; title: string; agent: string; status: string; workspace: string }[]) {
  return {
    version: "0.9.0", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null,
    workspaces: panes.map((pane, index) => ({ workspace_id: pane.id.split(":")[0], number: index + 1, label: pane.workspace, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${pane.id.split(":")[0]}:t1`, agent_status: pane.status })),
    tabs: panes.map((pane) => ({ tab_id: `${pane.id.split(":")[0]}:t1`, workspace_id: pane.id.split(":")[0], number: 1, label: "1", focused: false, pane_count: 1, agent_status: pane.status })),
    layouts: [],
    agents: [],
    panes: panes.map((pane) => ({
      pane_id: pane.id, terminal_id: `term-${pane.id}`, workspace_id: pane.id.split(":")[0], tab_id: `${pane.id.split(":")[0]}:t1`, focused: false,
      cwd: pane.folder, foreground_cwd: pane.folder, label: pane.title, agent: pane.agent, agent_status: pane.status, revision: 1,
    })),
  };
}
const EXTRA = [{
  id: "raka-devs", herdr_profile_id: "profile-raka-devs", name: "raka-devs", kind: "ssh", target: { destination: `opencraft@${VM_ADDRESS}` }, enabled: true, state: "connected", error: null,
  // the bridge's herdr, as a connected PC's roster entry carries it (without it the header says herdr offline)
  herdr: { version: "0.9.0", protocol: 22, terminal_attach: true },
  snapshot: snapshot([{ id: ASSISTANT_PANE, folder: "/home/opencraft/.config/ovis/assistant/agent", title: "Assistant", agent: "claude", status: "idle", workspace: "Assistant" }]),
}];

async function buildTransport(): Promise<void> {
  const fixture = join(repo, "site/demo/fixtures/machines.json");
  const result = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app, naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
    plugins: [{
      name: "assistant-voice-roster",
      setup(build) {
        build.onLoad({ filter: /fixtures[\\/]machines\.json$/ }, (args) => {
          if (args.path !== fixture) return undefined;
          const recorded = JSON.parse(readFileSync(fixture, "utf8")) as { machines: unknown[] };
          return { contents: `export default ${JSON.stringify({ ...recorded, machines: [...recorded.machines, ...EXTRA] })};`, loader: "js" };
        });
      },
    }],
  });
  if (!result.success) throw new Error(`the demo's transport did not build:\n${result.logs.map(String).join("\n")}`);
}

/** the VM's voice routes and the SDK, faked in the page; the script steers them through window.__voice */
const FAKES = `(() => {
  const voice = window.__voice = {
    status: { configured: true, persona: "Nara", minutes: null, assistant: { state: "idle", pending: [] } },
    level: 0, call: null, requests: [], ended: 0,
  };
  const realFetch = window.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    // the demo answers no remote PC: the Assistant's chat is a short conversation of its own
    if (url.pathname === "/api/machines/raka-devs/pane/conversation") return Promise.resolve(json({ source: "claude-transcript", cursor: null,
      metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
      turns: [
        { role: "user", ts: new Date(Date.now() - 600000).toISOString(), parts: [{ kind: "text", text: "[voice] Is PR 34 on ovis merged?" }] },
        { role: "assistant", ts: new Date(Date.now() - 590000).toISOString(), parts: [{ kind: "text", text: "Not yet: CI is still running on PR 34 (2 of 3 checks green). I'll merge it once the last one passes." }] },
      ] }));
    const match = /\\/assistant\\/voice\\/(status|session|tool)$/.exec(url.pathname);
    if (!match) return realFetch(input, init);
    const body = init && init.body ? JSON.parse(init.body) : null;
    voice.requests.push({ path: url.pathname, body });
    if (match[1] === "status") return Promise.resolve(json(voice.status));
    if (match[1] === "session") return Promise.resolve(json({ conversation_token: "demo-token", agent_id: "demo", persona: "Nara", brief: "The user is Raka.",
      ...(body && body.result_task_id ? { result: { task_id: body.result_task_id, text: "CI is green and PR 34 is merged." } } : {}) }));
    const task = { id: "t1", text: body.text, sent_at: Date.now(), state: "working", result: null };
    if (body.tool === "ask_assistant") { voice.status.assistant = { state: "working", pending: [task] }; return Promise.resolve(json({ result: "Sent to the Assistant.", task })); }
    return Promise.resolve(json({ result: "nothing" }));
  };
  window.__ovisVoiceSdk = { Conversation: { startSession: async (options) => {
    voice.call = options;
    return {
      endSession: async () => { voice.ended += 1; voice.call = null; },
      setMicMuted: () => {},
      getInputVolume: () => 0,
      getOutputVolume: () => voice.level,
      sendContextualUpdate: () => {},
    };
  } } };
})();`;

const light = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    for (const name of [...root.style].filter((property) => property.startsWith("--"))) root.style.removeProperty(name);
    root.style.removeProperty("background-color");
  });
};

try {
  await buildDemoApp(app);
  await buildTransport();
  const index = join(app, "index.html");
  writeFileSync(join(app, "voice-fakes.js"), FAKES);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script src="./voice-fakes.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const saved: string[] = [];
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const theme of ["dark", "light"] as const) {
        for (const width of [1280, 390] as const) {
          const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 860 }, locale: "en-US", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) });
          await context.addInitScript(([address]) => {
            localStorage.setItem("ovis:assistant-address", address!);
            if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          }, [VM_ADDRESS]);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const shot = async (name: string) => { const path = join(shots, `assistant-voice-${name}-${width}-${theme}.png`); await page.screenshot({ path, animations: "disabled" }); saved.push(path); };
          const steer = (run: string) => page.evaluate(run);

          await page.goto(`${origin}/herdr-web-ui/demo/app/?machine=raka-devs&pane=${encodeURIComponent(ASSISTANT_PANE)}&view=chat`);
          await page.getByRole("button", { name: "Chat", exact: true }).click();
          await page.locator(".composer-text").waitFor();
          if (theme === "light") await light(page);

          // Chat by default, the chat as it was: the switch in the header and nothing over the composer
          const chatButton = page.getByRole("button", { name: "Assistant chat" });
          const voiceButton = page.getByRole("button", { name: "Assistant voice" });
          assert.equal(await chatButton.getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator(".assistant-voice, .assistant-voice-bar").count(), 0);
          await page.getByText("I'll merge it once the last one passes.").waitFor();
          assert.equal(await page.getByText("herdr offline").count(), 0);
          await shot("chat");

          // Voice: the call screen, and no call until the orb is tapped
          await voiceButton.click();
          await page.locator(".assistant-voice").waitFor();
          await page.waitForFunction(() => (window as unknown as { __voice: { requests: { path: string }[] } }).__voice.requests.some((request) => request.path.endsWith("/status")));
          assert.equal(await page.locator(".assistant-voice-minutes").count(), 0, "no minutes line: ElevenLabs gives no number");
          assert.equal(await page.evaluate(() => (window as unknown as { __voice: { requests: { path: string }[] } }).__voice.requests.filter((request) => request.path.endsWith("/session")).length), 0, "switching never starts a call");
          assert.equal(await page.locator(".assistant-voice-phase").textContent(), "Tap to talk");
          await shot("voice-idle");

          // a call: Nara speaks, captions of both sides, the task she sent working
          await page.locator(".assistant-voice-orb").click();
          await page.waitForFunction(() => (window as unknown as { __voice: { call: unknown } }).__voice.call !== null);
          const paths = await page.evaluate(() => (window as unknown as { __voice: { requests: { path: string }[] } }).__voice.requests.map((request) => request.path));
          assert.ok(paths.includes("/api/machines/raka-devs/assistant/voice/session"), "a remote Assistant goes through the machine proxy");
          await steer(`(async () => {
            const call = window.__voice.call;
            call.onMessage({ message: "Cek CI di ovis, merge kalau hijau ya.", source: "user", role: "user", event_id: 1 });
            await call.clientTools.ask_assistant({ text: "cek CI di ovis, merge kalau hijau" });
            call.onMessage({ message: "Oke, aku kasih ke Assistant ya.", source: "ai", role: "agent", event_id: 2 });
            call.onModeChange({ mode: "speaking" });
            window.__voice.level = 0.7;
          })()`);
          await page.locator(".assistant-voice-task.is-working").waitFor();
          await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".assistant-voice-orb")!).getPropertyValue("--level")) > 0.5);
          assert.equal(await page.locator(".assistant-voice-phase").textContent(), "Speaking");
          assert.deepEqual(await page.locator(".assistant-voice-captions li").allTextContents(), ["You Cek CI di ovis, merge kalau hijau ya.", "Nara Oke, aku kasih ke Assistant ya."]);
          assert.equal(await page.locator(".machine-group.is-assistant .assistant-call-dot[aria-label='On call with Nara']").count(), 1, "the sidebar marks the Assistant's PC while the call is open");
          await shot("voice-speaking");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(overflow, 0, "no sideways scroll");

          // in Chat the call goes on as a thin bar over the composer
          await chatButton.click();
          await page.locator(".assistant-voice-bar").getByText("On call with Nara").waitFor();
          await shot("chat-on-call");
          await page.locator(".assistant-voice-bar").click();
          await page.locator(".assistant-voice").waitFor();
          await page.getByRole("button", { name: "End" }).click();
          await page.locator(".assistant-voice-bar.is-inline").getByText("Assistant working… 1 task").waitFor();
          assert.equal(await page.locator(".assistant-call-dot").count(), 0, "no mark once the call ended");

          // no key on the VM: one line, the guide and a retry
          await steer(`window.__voice.status = { ...window.__voice.status, configured: false }`);
          await chatButton.click();
          await voiceButton.click();
          await page.locator(".assistant-voice-trouble").getByText("Voice needs an ElevenLabs key").waitFor();
          await shot("voice-no-key");
          await steer(`window.__voice.status = { ...window.__voice.status, configured: true }`);

          // the task finishes while the user is in another pane: the chime and the toast; its tap opens the result call
          await chatButton.click();
          await page.locator(".assistant-voice-bar").getByText("Assistant working… 1 task").waitFor();
          await shot("chat-working");
          const other = page.locator(`[data-pane]:not([data-pane="${ASSISTANT_PANE}"]) >> visible=true`).first();
          if (width === 390) await page.getByRole("button", { name: "Open workspace list" }).click();
          await other.click();
          await page.waitForFunction(() => !document.querySelector(".assistant-view-switch"));
          await steer(`window.__voice.status = { ...window.__voice.status, assistant: { state: "idle", pending: [] } }`);
          await page.locator(".assistant-voice-toast").waitFor({ timeout: 12_000 });
          assert.equal(await page.evaluate(() => (window as unknown as { __voice: { call: unknown } }).__voice.call), null, "Nara never speaks by herself outside the Assistant");
          await shot("toast");
          await page.locator(".assistant-voice-toast-hear").click();
          await page.locator(".assistant-voice").waitFor();
          await page.waitForFunction(() => (window as unknown as { __voice: { requests: { body: { result_task_id?: string } | null }[] } }).__voice.requests.some((request) => request.body?.result_task_id === "t1"));
          assert.deepEqual(errors, []);
          console.log(`PASS ${theme} ${width}: switch, Voice idle, call with captions and a task, Chat bar, no key, toast and the result call`);
          await context.close();
        }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  for (const path of saved) console.log(path);
} finally {
  rmSync(app, { recursive: true, force: true });
}
