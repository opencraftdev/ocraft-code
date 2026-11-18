import { expect, test } from "bun:test";
import type { HerdrPane } from "../shared/protocol.ts";
import { handleAssistantRequest } from "./assistant.ts";
import { AssistantVoice } from "./assistant-voice.ts";
import { FolderAssistant } from "./folder-assistant.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pane = (id: string, cwd: string, status = "idle", agent: string | null = "claude") =>
  ({ pane_id: id, workspace_id: "w1", cwd, foreground_cwd: cwd, agent, agent_status: status }) as unknown as HerdrPane;

test("the agent in the folder is the Assistant; others are its sessions", async () => {
  const sent: [string, string][] = [];
  const panes = [pane("t1", "/home/me/repo"), pane("t2", "/home/me/orchestrator/", "working"), pane("t3", "/home/me/orchestrator", "idle", null)];
  const folder = new FolderAssistant("/home/me/orchestrator", async () => ({ panes }), async (id, text) => { sent.push([id, text]); });
  expect(folder.info()).toBeNull();
  expect(await folder.paneNow()).toEqual({ paneId: "t2", status: "working" });
  expect(folder.info()).toEqual({ pane_id: "t2" });
  expect(folder.graph.build().sessions.map((s) => s.pane)).toEqual(["t1"]);
  await folder.sendToPane("t2", "hi");
  expect(sent).toEqual([["t2", "hi"]]);
  expect(await new FolderAssistant("/elsewhere", async () => ({ panes })).paneNow()).toBeNull();
});

test("a folder Assistant answers only the voice routes", async () => {
  const folder = new FolderAssistant("/home/me/orchestrator", async () => ({ panes: [pane("t2", "/home/me/orchestrator")] }));
  const voice = new AssistantVoice(mkdtempSync(join(tmpdir(), "folder-voice-")), { session: folder, graph: folder.graph }, { fetch: (() => { throw new Error("no network in tests"); }) as unknown as typeof fetch });
  const status = await handleAssistantRequest(new Request("http://x/api/assistant/voice/status"), "/api/assistant/voice/status", { voice });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ configured: false, assistant: { state: "idle" } });
  for (const path of ["/api/assistant", "/api/assistant/machines/m1"]) {
    expect((await handleAssistantRequest(new Request(`http://x${path}`), path, { voice })).status).toBe(404);
  }
});
