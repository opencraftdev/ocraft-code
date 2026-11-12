import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The Assistant's `@` session tags (docs/plan/20261112-1728-assistant-session-mentions.md) on the
// unmodified app over the demo's fixture transport. The demo's roster is extended at build time only
// (a Bun.build plugin over site/demo/fixtures/machines.json; the file stays as recorded) with a
// fictional Assistant VM, two fictional PCs with agent sessions and one offline PC. The script opens
// the Assistant's chat, types `@`, filters, tags two sessions, checks the chip row, Backspace and ×,
// and reads what a send hands the socket. No herdr session is opened; everything stays on loopback.
// Screenshots (dark and light) go to argv[2], else a temp directory, and their paths are printed.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-assistant-mentions-demo-"));
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "assistant-mentions-shots-"));
mkdirSync(shots, { recursive: true });

const VM_ADDRESS = "raka-devs.tail38376d.ts.net";
// the demo socket answers for the recorded panes only: the Assistant pane takes one of their ids (an idle claude)
const ASSISTANT_PANE = "w1H:p1";

/** one fictional PC's snapshot: a workspace per pane, each pane an agent */
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
const pc = (id: string, name: string, destination: string, state: string, panes: Parameters<typeof snapshot>[0]) => ({
  id, herdr_profile_id: `profile-${id}`, name, kind: "ssh", target: { destination }, enabled: true, state, error: null, snapshot: state === "connected" ? snapshot(panes) : null,
});
const EXTRA = [
  pc("raka-devs", "raka-devs", `opencraft@${VM_ADDRESS}`, "connected", [
    { id: ASSISTANT_PANE, folder: "/home/opencraft/.config/ovis/assistant/agent", title: "Assistant", agent: "claude", status: "idle", workspace: "Assistant" },
  ]),
  pc("muhammad-macbook", "muhammad-macbook", "muhammad@muhammads-macbook-air-2.tail38376d.ts.net", "connected", [
    { id: "wM:p1", folder: "/Users/muhammad/repo/trina-ax", title: "MCP progress report", agent: "claude", status: "working", workspace: "trina-ax" },
    { id: "wL:p1", folder: "/Users/muhammad/repo/ledger-sync", title: "Retry failed webhooks", agent: "codex", status: "idle", workspace: "ledger-sync" },
    { id: "wN:p1", folder: "/Users/muhammad/repo/trina-ax-docs", title: "Docs for the trina release", agent: "claude", status: "done", workspace: "trina-ax-docs" },
  ]),
  pc("macbook-pro", "macbook-pro", "potenlab@potenlab-macbookpro", "connected", [
    { id: "wV:p1", folder: "/Users/potenlab/repo/harbor-api", title: "Rate limit the search endpoint", agent: "claude", status: "blocked", workspace: "harbor-api" },
    { id: "wW:p1", folder: "/Users/potenlab/repo/garden-app", title: "Onboarding screens", agent: "codex", status: "working", workspace: "garden-app" },
  ]),
  pc("old-imac", "old-imac", "studio@old-imac", "disconnected", []),
];

/** the demo transport with the extended roster: only the fixture's import changes, at build time */
async function buildTransport(): Promise<void> {
  const fixture = join(repo, "site/demo/fixtures/machines.json");
  const result = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app, naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
    plugins: [{
      name: "assistant-mentions-roster",
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

const light = async (page: Page): Promise<void> => {
  // this fork pins one dark scheme (src/theme-bootstrap.ts): the light theme block, without the pinned row's inline tokens
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
  // what the composer hands the socket, read back below: each demo socket's sends, kept in window.__sent
  writeFileSync(join(app, "capture-sends.js"), `(() => {
  const Demo = window.WebSocket;
  const sent = window.__sent = [];
  window.WebSocket = function (url, protocols) {
    const socket = new Demo(url, protocols);
    const send = socket.send.bind(socket);
    socket.send = (data) => { if (typeof data === "string") sent.push(data); return send(data); };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: Demo[name] });
})();`);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script src="./capture-sends.js"></script>\n    <script type="module"`));
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
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
        await context.addInitScript(([address]) => {
          localStorage.setItem("ovis:assistant-address", address!);
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        }, [VM_ADDRESS]);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/herdr-web-ui/demo/app/?machine=raka-devs&pane=${encodeURIComponent(ASSISTANT_PANE)}&view=chat`);
        const box = page.locator(".composer-text");
        // the demo opens a remote PC's pane in the terminal lens: the Assistant is used in its chat
        await page.getByRole("button", { name: "Chat", exact: true }).click();
        await box.waitFor();
        if (theme === "light") await light(page);
        const shot = async (name: string) => { const path = join(shots, `assistant-mentions-${name}-${theme}.png`); await page.screenshot({ path }); saved.push(path); };

        // a bare @ lists the sessions by PC, the VM and the Assistant's own pane left out, an offline PC dimmed
        await box.click();
        await box.pressSequentially("Ask @");
        const menu = page.locator(".composer-menu");
        await menu.getByRole("option").first().waitFor();
        const headings = await menu.locator(".menu-heading").allTextContents();
        assert.deepEqual(headings, ["workstation", "muhammad-macbook", "macbook-pro", "old-imac · offline"], "grouped by PC, the VM left out, the offline PC dimmed");
        assert.equal(await menu.getByRole("option").count(), 11, "every agent session on the connected PCs: the workstation's six and the fictional five");
        await shot("picker");

        // the typed words filter in any order; Esc closes, typing opens again
        await box.pressSequentially("progress trina");
        await page.waitForFunction(() => document.querySelectorAll(".composer-menu [role=option]").length === 1);
        await shot("filtered");
        await box.press("Escape");
        assert.equal(await menu.count(), 0, "Esc closes the picker");
        await box.press("Backspace");
        await box.pressSequentially("a");
        await menu.getByRole("option").first().waitFor();
        await box.press("Enter");
        assert.match(await box.inputValue(), /^Ask @\[muhammad-macbook wM:p1 · trina-ax · MCP progress report\] $/, "Enter tags the highlighted session");

        // a second tag by mouse, after arrowing; Tab would take it as Enter does
        await box.pressSequentially("and @harbor");
        await menu.getByRole("option").first().waitFor();
        await menu.getByRole("option").first().click();
        const tagged = await box.inputValue();
        assert.equal(tagged, "Ask @[muhammad-macbook wM:p1 · trina-ax · MCP progress report] and @[macbook-pro wV:p1 · harbor-api · Rate limit the search e…] ");
        const chips = page.locator(".composer-session-tag");
        assert.deepEqual(await chips.locator(".composer-session-tag-text").allTextContents(), ["muhammad-macbook · trina-ax · MCP progress report", "macbook-pro · harbor-api · Rate limit the search e…"]);
        await shot("tags");

        // Backspace right after a tag takes it whole; × takes its tag out of the text
        await box.press("Backspace");
        await box.press("Backspace");
        assert.equal(await box.inputValue(), "Ask @[muhammad-macbook wM:p1 · trina-ax · MCP progress report] and ");
        await box.pressSequentially("@garden");
        await menu.getByRole("option").first().waitFor();
        await box.press("Tab");
        await chips.nth(0).getByRole("button").click();
        assert.equal(await box.inputValue(), "Ask and @[macbook-pro wW:p1 · garden-app · Onboarding screens] ");
        await box.fill("");

        // what a send hands the Assistant: each tag as its exact session
        await box.pressSequentially("Compare @trina mcp");
        await menu.getByRole("option").first().waitFor();
        await box.press("Enter");
        await box.pressSequentially("with @harbor");
        await menu.getByRole("option").first().waitFor();
        await box.press("Enter");
        await box.pressSequentially("please");
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer-send")?.disabled === false);
        await box.press("Enter");
        const expected = "Compare @session(machine=\"muhammad-macbook\" host=\"muhammads-macbook-air-2\" pane=\"wM:p1\" folder=\"/Users/muhammad/repo/trina-ax\" agent=\"claude\" title=\"MCP progress report\")"
          + " with @session(machine=\"macbook-pro\" host=\"potenlab-macbookpro\" pane=\"wV:p1\" folder=\"/Users/potenlab/repo/harbor-api\" agent=\"claude\" title=\"Rate limit the search endpoint\") please";
        await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.some((data) => data.includes("@session(")));
        const submitted = (await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent))
          .map((data) => JSON.parse(data) as { type: string; text?: string }).find((message) => message.text?.includes("@session("));
        assert.equal(submitted?.text, expected, "the send carries each tag as its exact session");
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: picker, filter, Esc, Enter/Tab/mouse, chips, Backspace, ×, and the expanded send`);
        if (theme === "dark") console.log(`sent: ${submitted?.text}`);
        await context.close();
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  for (const path of saved) console.log(path);
} finally {
  rmSync(app, { recursive: true, force: true });
}
