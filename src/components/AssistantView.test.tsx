import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { chatRetry, LATER_RETRY_MS, STARTING_MS, startingRetry } from "../lib/startingChat.ts";
import { AgentPanel } from "./AgentPanel.tsx";
import { AssistantSessions, assistantSessions } from "./AssistantSessions.tsx";
import { AssistantSetup } from "./AssistantView.tsx";

const wrap = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(SettingsProvider, { children: element }));

const pane = (id: string, agent_status: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id: id, terminal_id: `t-${id}`, tab_id: "t1", workspace_id: "w1", focused: false, revision: 0, agent: "claude", agent_status, label: id, cwd: "/home/me/code", ...extra,
});
const machine = (id: string, panes: HerdrPane[], extra: Partial<Machine> = {}): Machine => ({
  id, name: id, kind: "ssh", target: { destination: `me@${id}` }, enabled: true, state: "connected", error: null,
  snapshot: { panes, workspaces: [], tabs: [], focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, protocol: 1, version: "1" } as unknown as Machine["snapshot"], ...extra,
});

describe("the Assistant", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterAll(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("sets up from a page with the install command, the VM address and a way back to Code", () => {
    const page = wrap(createElement(AssistantSetup, { onBack: () => {} }));
    expect(page).toContain("data-testid=\"assistant-setup\"");
    expect(page).toContain("scripts/install-assistant.sh | bash");
    expect(page).toContain("Assistant VM address");
    expect(page).toContain("Back to Code");
    expect(page).not.toContain("<iframe");
  });

  it("lists every agent pane but the Assistant's own, per PC, working then blocked then the rest", () => {
    const groups = assistantSessions([
      machine("laptop", [pane("idle1", "idle"), pane("work1", "working"), pane("shell", "unknown", { agent: null }), pane("ask1", "blocked"), pane("done1", "done")]),
      machine("empty", [pane("shell2", "idle", { agent: null })]),
      // the VM's own Assistant pane, when this Ovis is the VM
      machine("local", [pane("assistant", "working", { cwd: "/home/me/.config/ovis/assistant/agent" }), pane("vmwork", "working")], { kind: "local", target: undefined }),
    ]);
    expect(groups.map((group) => [group.machine.id, group.panes.map((item) => item.pane_id)])).toEqual([
      ["laptop", ["work1", "ask1", "idle1", "done1"]],
      ["local", ["vmwork"]],
    ]);
  });

  it("shows what works or waits under each PC's header, and folds the rest into N finished", () => {
    const page = wrap(createElement(AssistantSessions, { onOpen: () => {}, machines: [
      machine("laptop", [pane("Fix login", "idle"), pane("Add tests", "working"), pane("Pick a font", "blocked")]),
      machine("desk", [pane("Bump deps", "done")], { state: "reconnecting" }),
    ] }));
    expect(page).toContain(">Sessions<");
    const rows = [...page.matchAll(/class="agent-panel-row state-(\w+)" title="([^"]+)"/g)].map((match) => [match[2], match[1]]);
    expect(rows).toEqual([["Add tests", "working"], ["Pick a font", "blocked"]]);
    expect(page).toContain("laptop · claude");
    // only a PC with a row shown gets its header, with its connection dot
    expect(page).toContain("machine-dot is-connected");
    expect(page).not.toContain("machine-dot is-reconnecting");
    expect(page).toContain("<span>2 finished</span>");
  });

  it("says so when nothing works", () => {
    const page = wrap(createElement(AssistantSessions, { onOpen: () => {}, machines: [machine("laptop", [pane("Fix login", "idle")])] }));
    expect(page).toContain("No sessions working.");
    expect(page).toContain("<span>1 finished</span>");
    expect(wrap(createElement(AssistantSessions, { onOpen: () => {}, machines: [] }))).toContain("No agent sessions on your PCs.");
  });

  it("draws the agent panel without Changes, with the Sessions section, for the Assistant's pane", () => {
    const props = {
      contextKey: null, pane: pane("assistant", "idle"), panes: [], machineName: "vm", workspaceName: "Assistant", title: "Assistant", online: false, watching: false,
      tab: "agents" as const, drawerOpen: false, onOpenView: () => {}, onCloseView: () => {}, onClose: () => {}, onSelectPane: () => {}, onBrowseFiles: () => {}, onOpenDiff: () => {}, onNewAgent: () => {}, pinned: true,
    };
    const normal = wrap(createElement(AgentPanel, props));
    expect(normal).toContain("aria-label=\"Changes\"");
    const assistant = wrap(createElement(AgentPanel, { ...props, hideChanges: true, extraSections: createElement(AssistantSessions, { onOpen: () => {}, machines: [machine("laptop", [pane("Add tests", "working")])] }) }));
    expect(assistant).toContain("aria-label=\"Environment\"");
    expect(assistant).toContain("aria-label=\"Context\"");
    expect(assistant).not.toContain("aria-label=\"Changes\"");
    expect(assistant).toContain("aria-label=\"Sessions\"");
  });
});

describe("a chat that just started", () => {
  it("retries a failed read quietly, each second, until its time is up", () => {
    const started = 1_000_000;
    // the injected clock: no waiting in the test
    expect(startingRetry(started, started)).toBe(1000);
    expect(startingRetry(started, started + STARTING_MS - 300)).toBe(300);
    expect(startingRetry(started, started + STARTING_MS)).toBeNull();
    expect(startingRetry(undefined, started)).toBeNull();
  });

  it("keeps retrying a failed read after the quiet time, every few seconds, so it recovers by itself", () => {
    const started = 1_000_000;
    expect(chatRetry(started, started)).toBe(1000);
    expect(chatRetry(started, started + STARTING_MS + 60_000)).toBe(LATER_RETRY_MS);
    expect(chatRetry(undefined, started)).toBeNull();
  });
});
