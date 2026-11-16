/**
 * herdr-app's navigation commands over the selected PC's session (its tab.next, space.next,
 * agent.next, space.select:N, tab.select:N, space.rename), registered in lib/commands.ts so the
 * keys, the palette and the keys dialog share them. A step lands on the pane in front of the tab
 * or workspace it goes to (herdr's focused pane there), and only ever selects it in the browser:
 * herdr's own focus stays where it is.
 */
import { useEffect } from "react";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { renameWorkspace } from "./api.ts";
import { registerCommands, setPromptOpener, type AppCommand } from "./commands.ts";
import { rosterPanes } from "./dagPane.ts";
import { useT } from "./i18n.ts";
import { tabLabel } from "./tabName.ts";

type Snapshot = Pick<SessionSnapshot, "panes" | "tabs" | "workspaces" | "layouts">;

/** The panes the sidebar lists, workspace by workspace in its order. */
function orderedPanes(snapshot: Snapshot, selectedPaneId: string | null): HerdrPane[] {
  const panes = rosterPanes(snapshot.panes, selectedPaneId);
  return snapshot.workspaces.flatMap((workspace) => panes.filter((pane) => pane.workspace_id === workspace.workspace_id));
}

/** The pane in front of a tab: herdr's focused one there, else its first. */
function paneOfTab(snapshot: Snapshot, panes: readonly HerdrPane[], tabId: string): string | null {
  const focused = snapshot.layouts?.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
  const inTab = panes.filter((pane) => pane.tab_id === tabId);
  return (inTab.find((pane) => pane.pane_id === focused) ?? inTab[0])?.pane_id ?? null;
}

function paneOfWorkspace(snapshot: Snapshot, panes: readonly HerdrPane[], workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === workspaceId);
  return (workspace && paneOfTab(snapshot, panes, workspace.active_tab_id)) ?? panes.find((pane) => pane.workspace_id === workspaceId)?.pane_id ?? null;
}

/** The workspaces the sidebar shows (those with a pane), and the selected pane's workspace's tabs that have one. */
function places(snapshot: Snapshot, selectedPaneId: string | null) {
  const panes = orderedPanes(snapshot, selectedPaneId);
  const workspaces = snapshot.workspaces.filter((workspace) => panes.some((pane) => pane.workspace_id === workspace.workspace_id));
  const selected = panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  const tabs = selected === null ? [] : snapshot.tabs.filter((tab) => tab.workspace_id === selected.workspace_id && panes.some((pane) => pane.tab_id === tab.tab_id));
  return { panes, workspaces, tabs, selected };
}

const wrap = (index: number, length: number) => ((index % length) + length) % length;

/** The pane a step lands on: the next tab of this workspace, the next workspace, or the next agent; wraps around. */
export function stepTarget(kind: "tab" | "workspace" | "agent", snapshot: Snapshot, selectedPaneId: string | null, direction: -1 | 1): string | null {
  const { panes, workspaces, tabs, selected } = places(snapshot, selectedPaneId);
  if (kind === "agent") {
    const agents = panes.filter((pane) => pane.agent);
    if (agents.length === 0) return null;
    const at = agents.findIndex((pane) => pane.pane_id === selectedPaneId);
    // from a pane that is not an agent's, the first step goes to the nearest one that way
    if (at < 0) {
      const from = selected === null ? -1 : panes.indexOf(selected);
      const ahead = direction === 1 ? agents.find((pane) => panes.indexOf(pane) > from) ?? agents[0] : [...agents].reverse().find((pane) => panes.indexOf(pane) < from) ?? agents.at(-1);
      return ahead?.pane_id ?? null;
    }
    return agents[wrap(at + direction, agents.length)]!.pane_id;
  }
  if (kind === "tab") {
    if (selected === null || tabs.length < 2) return null;
    const at = tabs.findIndex((tab) => tab.tab_id === selected.tab_id);
    return paneOfTab(snapshot, panes, tabs[wrap(at + direction, tabs.length)]!.tab_id);
  }
  if (workspaces.length === 0) return null;
  const at = selected === null ? -1 : workspaces.findIndex((workspace) => workspace.workspace_id === selected.workspace_id);
  const next = at < 0 ? (direction === 1 ? workspaces[0] : workspaces.at(-1)) : workspaces[wrap(at + direction, workspaces.length)];
  return next ? paneOfWorkspace(snapshot, panes, next.workspace_id) : null;
}

/** The pane in front of the nth workspace, or the nth tab of the selected pane's workspace (1-based). */
export function numberedTarget(kind: "tab" | "workspace", snapshot: Snapshot, selectedPaneId: string | null, number: number): string | null {
  const { panes, workspaces, tabs } = places(snapshot, selectedPaneId);
  if (kind === "tab") {
    const tab = tabs[number - 1];
    return tab ? paneOfTab(snapshot, panes, tab.tab_id) : null;
  }
  const workspace = workspaces[number - 1];
  return workspace ? paneOfWorkspace(snapshot, panes, workspace.workspace_id) : null;
}

const NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface AppCommandsParams {
  snapshot: Snapshot | null;
  machineId: string;
  selectedPaneId: string | null;
  selectPane: (paneId: string) => void;
  /** opens the palette, for a command's question (lib/commands.ts prompt) */
  openPalette: () => void;
}

export function useAppCommands({ snapshot, machineId, selectedPaneId, selectPane, openPalette }: AppCommandsParams): void {
  const t = useT();
  useEffect(() => {
    setPromptOpener(openPalette);
    return () => setPromptOpener(null);
  }, [openPalette]);
  useEffect(() => {
    if (snapshot === null) return;
    const go = (paneId: string | null) => { if (paneId !== null && paneId !== selectedPaneId) selectPane(paneId); };
    const step = (id: string, label: string, kind: "tab" | "workspace" | "agent", direction: -1 | 1): AppCommand =>
      ({ id, label, run: () => go(stepTarget(kind, snapshot, selectedPaneId, direction)) });
    const { workspaces, tabs, selected } = places(snapshot, selectedPaneId);
    const selectedWorkspace = selected === null ? undefined : snapshot.workspaces.find((workspace) => workspace.workspace_id === selected.workspace_id);
    const commands: AppCommand[] = [
      step("previous-tab", t("Previous tab"), "tab", -1),
      step("next-tab", t("Next tab"), "tab", 1),
      step("previous-workspace", t("Previous workspace"), "workspace", -1),
      step("next-workspace", t("Next workspace"), "workspace", 1),
      step("previous-agent", t("Previous agent"), "agent", -1),
      step("next-agent", t("Next agent"), "agent", 1),
      {
        id: "workspace.select",
        label: t("Go to workspace"),
        choices: () => workspaces.map((workspace) => ({ label: workspace.label, value: workspace.workspace_id })),
        run: (workspaceId) => { if (workspaceId) go(paneOfWorkspace(snapshot, orderedPanes(snapshot, selectedPaneId), workspaceId)); },
      },
      {
        id: "tab.select",
        label: t("Go to tab"),
        choices: () => tabs.map((tab, index) => ({ label: tabLabel(tab, t, index + 1), value: tab.tab_id })),
        run: (tabId) => { if (tabId) go(paneOfTab(snapshot, orderedPanes(snapshot, selectedPaneId), tabId)); },
      },
      // herdr-app's Alt+1–9 (Ctrl+1–9 on a Mac) and Ctrl+1–9 (a Mac's Cmd+1–9 is the browser's)
      ...NUMBERS.map((number): AppCommand => ({ id: `workspace.${number}`, label: t("Go to workspace {n}", { n: number }), hidden: true, keys: { mac: [`ctrl+${number}`], other: [`alt+${number}`] }, run: () => go(numberedTarget("workspace", snapshot, selectedPaneId, number)) })),
      ...NUMBERS.map((number): AppCommand => ({ id: `tab.${number}`, label: t("Go to tab {n}", { n: number }), hidden: true, keys: { other: [`ctrl+${number}`] }, run: () => go(numberedTarget("tab", snapshot, selectedPaneId, number)) })),
      ...(selectedWorkspace ? [{
        id: "workspace.rename",
        label: t("Rename this workspace"),
        prompt: t("New workspace name"),
        keys: { mac: ["shift+F2"], other: ["shift+F2"] },
        run: (name?: string) => {
          const label = name?.trim();
          if (label) void renameWorkspace(selectedWorkspace.workspace_id, label, machineId).catch(() => undefined);
        },
      } satisfies AppCommand] : []),
    ];
    return registerCommands(commands);
  }, [snapshot, machineId, selectedPaneId, selectPane, t]);
}
