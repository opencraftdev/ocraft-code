import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// herdr-app's split panes and layouts on the unmodified app over the demo's fixture transport (no
// herdr session): a tab's split tree in the terminal view, each split pane's header (name, folder,
// its actions on hover, the grip), a split from that header, a pane dragged onto another's middle
// trading places, the terminals layout from the palette (no sidebar, framed cards) kept across a
// reload, and a phone still showing one pane. Screenshots in UI_EVIDENCE_DIR or evidence/.
const repo = join(import.meta.dir, "..");
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "splits-layouts");
mkdirSync(evidence, { recursive: true });
const app = mkdtempSync(join(tmpdir(), "herdr-splits-demo-"));

const shown = (page: Page): Promise<string[]> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")].map((frame) => frame.dataset["layoutPane"] ?? ""));
async function until(page: Page, check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `${label}: timed out`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
}
const post = async (page: Page, path: string, body: Record<string, unknown>): Promise<void> => {
  const status = await page.evaluate(async ([url, payload]) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status,
    [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      await context.addInitScript(() => {
        if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}`;
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await until(page, async () => (await shown(page)).length === 1, "the shell alone");

      // herdr's split tree: a split right, then one down from its header's button
      await post(page, "/api/pane/split", { pane_id: panes.shell, direction: "right", focus: false });
      await until(page, async () => (await shown(page)).length === 2, "a split right shows both panes");
      const shell = page.locator(`.pane-frame[data-layout-pane="${panes.shell}"]`);
      const actions = shell.locator(".pane-frame-actions");
      await page.mouse.move(5, 5);
      assert.equal(await actions.isVisible(), false, "a split pane's actions wait for the pointer");
      await shell.hover();
      await actions.getByRole("button", { name: "Split down" }).click();
      await until(page, async () => (await shown(page)).length === 3, "the header's Split down adds a pane");
      assert.equal(await page.locator(".pane-divider").count(), 2, "each split draws a divider");
      assert(await shell.locator(".pane-frame-grip").isVisible(), "the hovered pane shows its grip");
      await page.screenshot({ path: join(evidence, "main-1440.png") });

      // a pane's title dropped on another pane's middle: the two trade places (herdr's pane.swap)
      const before = await shown(page);
      const other = before.find((id) => id !== panes.shell)!;
      const box = (await page.locator(`.pane-frame[data-layout-pane="${other}"]`).boundingBox())!;
      const rect = async (id: string) => (await page.locator(`.pane-frame[data-layout-pane="${id}"]`).boundingBox())!;
      const shellBefore = await rect(panes.shell);
      await shell.locator(".pane-frame-head").dragTo(page.locator(`.pane-frame[data-layout-pane="${other}"]`), { targetPosition: { x: box.width / 2, y: box.height / 2 } });
      await until(page, async () => { const now = await rect(panes.shell); return now.x !== shellBefore.x || now.y !== shellBefore.y; }, "a drop in another pane's middle swaps them");

      // the terminals layout from the palette: no sidebar, the panes as cards; kept across a reload
      await page.keyboard.press("ControlOrMeta+Shift+K");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      await palette.waitFor();
      await palette.getByRole("option", { name: "Switch to the terminals layout" }).click();
      await until(page, () => page.evaluate(() => document.querySelector(".app")?.classList.contains("layout-terminals") ?? false), "the terminals layout");
      await until(page, () => page.evaluate(() => document.querySelector(".app")?.classList.contains("sidebar-collapsed") ?? false), "the terminals layout folds the sidebar");
      const radius = await shell.evaluate((frame) => parseFloat(getComputedStyle(frame).borderTopLeftRadius));
      assert(radius > 0, "the terminals layout draws the panes as rounded cards");
      await page.screenshot({ path: join(evidence, "terminals-1440.png") });
      await page.reload();
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await until(page, () => page.evaluate(() => document.querySelector(".app")?.classList.contains("layout-terminals") ?? false), "a reload keeps the terminals layout");

      // a phone keeps one pane at a time
      await page.setViewportSize({ width: 390, height: 844 });
      await until(page, async () => (await shown(page)).length === 1, "a phone shows one pane");
      await page.screenshot({ path: join(evidence, "phone-390.png") });

      assert.deepEqual(errors, []);
      console.log(`splits and layouts: tree, header actions, swap, terminals layout and phone; screenshots in ${evidence}`);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
