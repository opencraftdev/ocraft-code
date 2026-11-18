/**
 * The Assistant as a folder (OVIS_VOICE_ASSISTANT_DIR): on an Ovis that is not the Assistant VM
 * (OVIS_ASSISTANT unset), such as the herdr-core one beside the orchestrator, the agent pane started
 * in that folder is the Assistant voice talks to. Nothing here opens, restarts or compacts it: the
 * folder's own harness keeps it alive. Its profile is the folder's profiles/assistant/.
 */
import { resolve } from "node:path";
import type { GraphSession, SessionGraph } from "../shared/assistant.ts";
import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import type { VoiceSession } from "./assistant-voice.ts";
import { agentPrompt, sessionSnapshot } from "./herdr/client.ts";

const same = (a: string | null | undefined, b: string): boolean => typeof a === "string" && resolve(a) === b;

export class FolderAssistant implements VoiceSession {
  readonly folder: string;
  readonly profile = "assistant";
  readonly codexHome = undefined;
  private paneId: string | null = null;
  private panes: HerdrPane[] = [];

  constructor(folder: string, private snapshot: () => Promise<{ panes: HerdrPane[] }> = () => sessionSnapshot(),
    private prompt: (paneId: string, text: string) => Promise<void> = (paneId, text) => agentPrompt(paneId, text)) {
    this.folder = resolve(folder);
  }

  async paneNow(): Promise<{ paneId: string; status: AgentStatus | null } | null> {
    this.panes = (await this.snapshot()).panes;
    const pane = this.panes.find((p) => p.agent && (same(p.foreground_cwd, this.folder) || same(p.cwd, this.folder)));
    this.paneId = pane?.pane_id ?? null;
    return pane ? { paneId: pane.pane_id, status: pane.agent_status ?? null } : null;
  }

  info(): { pane_id: string } | null { return this.paneId ? { pane_id: this.paneId } : null; }

  sendToPane(paneId: string, text: string): Promise<void> { return this.prompt(paneId, text); }

  // ponytail: this PC's agent panes as of the last status poll, no repos or PRs; Assistant's full graph if voice needs them here
  readonly graph = {
    build: (): SessionGraph => ({
      updated_at: Date.now(),
      machines: [{ name: "this PC", id: "local", host: null, state: "connected" }],
      projects: [],
      sessions: this.panes.filter((p) => p.agent && p.pane_id !== this.paneId).map((p): GraphSession => ({
        key: `local/${p.pane_id}`, machine: "this PC", host: null, workspace: p.workspace_id, pane: p.pane_id, agent: p.agent!,
        state: p.agent_status ?? null, title: null, folder: p.foreground_cwd ?? p.cwd ?? null, repo_root: null, branch: null, head: null,
        remote: null, prs: [], files: { changed: [], touched: [] }, assistant_opened: false, seen_at: null,
      })),
    }),
  };
}
