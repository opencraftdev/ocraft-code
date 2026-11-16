import type { AgentInfo, AgentStatus, PaneInfo, PaneLayoutSnapshot, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";

/**
 * herdr-core's world as Ovis's herdr 0.9 snapshot. herdr-core keeps terminals only; the
 * spaces > tabs > split tree the desktop app shows lives in the core document `herdr-app`
 * (herdr-app src/mirror.rs `Document`): `{spaces: [{id, name, folder, tabs: [{id, name, root}]}]}`,
 * where `root` is a layout node (herdr-app src/layout.rs `Node`): `{id, type: "row"|"column"|
 * "stack"|"block", children?, content?: {terminal: "t7"}, size?: {weight}|{px}, title?}`.
 * Space -> workspace, tab -> tab, a terminal block -> pane (its node id is the pane id, its
 * terminal address the pane's terminal_id).
 */

export const LAYOUT_DOC = "herdr-app";
/** A workspace for live terminals no tab places (started with `hc run`, or a doc not written yet). */
export const LOOSE_WORKSPACE_ID = "hc:loose";

/** herdr-core's Terminal record (schema hc.openrpc.json), the fields read here. */
export interface CoreTerminal {
  address: string;
  name?: string | null;
  state?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
  turn?: number;
  labels?: Record<string, string>;
  status?: { state?: string; app?: string; title?: string; msg?: string } | null;
  reported?: boolean;
  foreground?: { cwd?: string | null; name?: string | null } | null;
  [key: string]: unknown;
}

interface LayoutNode {
  id?: string;
  type?: string;
  children?: LayoutNode[];
  content?: { terminal?: string };
  active?: string;
  title?: string;
}

interface DocTab {
  id?: string;
  name?: string;
  root?: LayoutNode;
}

interface DocSpace {
  id?: string;
  name?: string;
  folder?: string;
  tabs?: DocTab[];
}

export interface LayoutDoc {
  spaces?: DocSpace[];
}

const STATUS_PRIORITY: Record<string, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

/**
 * A 7501 word as herdr 0.9's status: `error` needs the person as `blocked` does (herdr-app's
 * Alert::Blocked covers both); a program that never reported is `unknown`.
 */
export function coreStatus(terminal: CoreTerminal | undefined): AgentStatus {
  const word = terminal?.status?.state;
  if (!word) return "unknown";
  if (word === "error") return "blocked";
  return word;
}

function rollup(statuses: AgentStatus[]): AgentStatus {
  let best: AgentStatus = "unknown";
  for (const status of statuses) if ((STATUS_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[best] ?? 0)) best = status;
  return best;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

interface Rect { x: number; y: number; width: number; height: number }
interface Placed { paneId: string; terminal: string; title?: string; rect: Rect | null }

/** Each block's natural grid: its terminal's own size; containers add their children up. */
function naturalSize(node: LayoutNode, terminals: Map<string, CoreTerminal>): { width: number; height: number } {
  const kids = shownChildren(node);
  if (node.type === "block" || kids.length === 0) {
    const terminal = node.content?.terminal ? terminals.get(node.content.terminal) : undefined;
    return { width: terminal?.cols || 80, height: terminal?.rows || 24 };
  }
  const sizes = kids.map((child) => naturalSize(child, terminals));
  if (node.type === "column") return { width: Math.max(...sizes.map((s) => s.width)), height: sizes.reduce((sum, s) => sum + s.height, 0) + kids.length - 1 };
  return { width: sizes.reduce((sum, s) => sum + s.width, 0) + kids.length - 1, height: Math.max(...sizes.map((s) => s.height)) };
}

/** A stack shows only its active child; rows and columns show them all. */
function shownChildren(node: LayoutNode): LayoutNode[] {
  const kids = node.children ?? [];
  if (node.type !== "stack") return kids;
  const active = kids.find((child) => child.id === node.active) ?? kids[0];
  return active ? [active] : [];
}

/**
 * Walks a tab's tree: every terminal block is a pane; rects follow each terminal's own grid, and an
 * n-way row or column becomes n-1 binary splits (herdr 0.9's layouts are binary).
 */
function placeTab(root: LayoutNode, terminals: Map<string, CoreTerminal>): { placed: Placed[]; layout: Omit<PaneLayoutSnapshot, "tab_id" | "workspace_id" | "focused_pane_id" | "zoomed"> } {
  const placed: Placed[] = [];
  const splits: PaneLayoutSnapshot["splits"] = [];
  const area = { x: 0, y: 0, ...naturalSize(root, terminals) };
  const visit = (node: LayoutNode, rect: Rect | null): void => {
    if (node.content?.terminal) {
      placed.push({ paneId: node.id || node.content.terminal, terminal: node.content.terminal, ...(node.title ? { title: node.title } : {}), rect });
      return;
    }
    const shown = new Set(rect ? shownChildren(node) : []);
    const kids = node.children ?? [];
    const sizes = kids.map((child) => (shown.has(child) ? naturalSize(child, terminals) : null));
    const right = node.type !== "column";
    let offset = 0;
    const shownKids = kids.filter((child) => shown.has(child));
    for (const [index, child] of kids.entries()) {
      const size = sizes[index];
      if (!rect || !size) {
        visit(child, null);
        continue;
      }
      const childRect = right
        ? { x: rect.x + offset, y: rect.y, width: size.width, height: rect.height }
        : { x: rect.x, y: rect.y + offset, width: rect.width, height: size.height };
      const position = shownKids.indexOf(child);
      if (position < shownKids.length - 1 && node.type !== "stack") {
        const rest = shownKids.slice(position).map((kid) => naturalSize(kid, terminals));
        const total = rest.reduce((sum, s) => sum + (right ? s.width : s.height), 0);
        splits.push({
          id: `${node.id ?? ""}:${position}`,
          direction: right ? "right" : "down",
          ratio: total > 0 ? (right ? size.width : size.height) / total : 0.5,
          rect: right ? { x: childRect.x, y: rect.y, width: rect.x + rect.width - childRect.x, height: rect.height } : { x: rect.x, y: childRect.y, width: rect.width, height: rect.y + rect.height - childRect.y },
        });
      }
      visit(child, childRect);
      offset += (right ? size.width : size.height) + 1;
    }
  };
  visit(root, area);
  return { placed, layout: { area, panes: [], splits } };
}

export interface CoreSnapshotInput {
  doc: LayoutDoc | null;
  terminals: CoreTerminal[];
  version: string;
  protocol: number;
}

/**
 * The herdr 0.9 snapshot of a herdr-core session. Focus is not shared state in herdr-core (each
 * screen keeps its own), so the first space, its first tab and that tab's first pane read as focused.
 * Only live terminals become panes; a tab left without one is dropped, as is a space without tabs.
 */
export function coreSnapshot({ doc, terminals, version, protocol }: CoreSnapshotInput): SessionSnapshot {
  const live = new Map(terminals.filter((t) => (t.state ?? "live") === "live").map((t) => [t.address, t]));
  const placedTerminals = new Set<string>();
  const workspaces: WorkspaceInfo[] = [];
  const tabs: TabInfo[] = [];
  const panes: PaneInfo[] = [];
  const agents: AgentInfo[] = [];
  const layouts: PaneLayoutSnapshot[] = [];

  const addTab = (workspaceId: string, tabId: string, label: string, root: LayoutNode): TabInfo | null => {
    const { placed, layout } = placeTab(root, live);
    const kept = placed.filter((p) => live.has(p.terminal));
    if (kept.length === 0) return null;
    const tab: TabInfo = { tab_id: tabId, workspace_id: workspaceId, label, number: 0, focused: false, pane_count: kept.length, agent_status: rollup(kept.map((p) => coreStatus(live.get(p.terminal)))) };
    for (const p of kept) {
      placedTerminals.add(p.terminal);
      const terminal = live.get(p.terminal)!;
      const status = coreStatus(terminal);
      const cwd = terminal.foreground?.cwd || terminal.cwd || null;
      const pane: PaneInfo = {
        pane_id: p.paneId,
        terminal_id: terminal.address,
        tab_id: tabId,
        workspace_id: workspaceId,
        agent_status: status,
        agent: terminal.status?.app ?? null,
        focused: false,
        revision: terminal.turn ?? 0,
        cwd,
        foreground_cwd: terminal.foreground?.cwd ?? null,
        label: p.title ?? terminal.name ?? null,
        title: terminal.title || null,
        terminal_title: terminal.title || null,
      };
      panes.push(pane);
      if (terminal.reported || terminal.status?.app) {
        agents.push({
          pane_id: pane.pane_id, terminal_id: pane.terminal_id, tab_id: tabId, workspace_id: workspaceId,
          agent: pane.agent ?? null, agent_status: status, focused: false, revision: pane.revision, cwd,
          name: terminal.name ?? null, title: pane.title ?? null, terminal_title: pane.terminal_title ?? null,
        });
      }
    }
    const shown = kept.filter((p) => p.rect);
    layouts.push({
      ...layout,
      tab_id: tabId,
      workspace_id: workspaceId,
      panes: shown.map((p) => ({ pane_id: p.paneId, rect: p.rect!, focused: false })),
      focused_pane_id: shown[0]?.paneId ?? kept[0]!.paneId,
      zoomed: false,
    });
    tabs.push(tab);
    return tab;
  };

  const addWorkspace = (workspaceId: string, label: string, made: TabInfo[]): void => {
    if (made.length === 0) return;
    made.forEach((tab, index) => (tab.number = index + 1));
    const workspacePanes = panes.filter((pane) => pane.workspace_id === workspaceId);
    workspaces.push({
      workspace_id: workspaceId,
      label,
      number: workspaces.length + 1,
      focused: false,
      active_tab_id: made[0]!.tab_id,
      tab_count: made.length,
      pane_count: workspacePanes.length,
      agent_status: rollup(workspacePanes.map((pane) => pane.agent_status)),
    });
  };

  for (const [spaceIndex, space] of (doc?.spaces ?? []).entries()) {
    const workspaceId = space.id || `space-${spaceIndex + 1}`;
    const made: TabInfo[] = [];
    for (const [tabIndex, docTab] of (space.tabs ?? []).entries()) {
      if (!docTab.root) continue;
      const tab = addTab(workspaceId, docTab.id || `${workspaceId}:tab-${tabIndex + 1}`, docTab.name || String(tabIndex + 1), docTab.root);
      if (tab) made.push(tab);
    }
    addWorkspace(workspaceId, space.name || (space.folder ? basename(space.folder) : `Space ${spaceIndex + 1}`), made);
  }

  // live terminals no tab places: one tab each, so `hc run --bg` work shows up too
  const loose: TabInfo[] = [];
  for (const terminal of live.values()) {
    if (placedTerminals.has(terminal.address)) continue;
    const tab = addTab(LOOSE_WORKSPACE_ID, `${LOOSE_WORKSPACE_ID}:${terminal.address}`, terminal.name || terminal.address, {
      id: `${LOOSE_WORKSPACE_ID}:${terminal.address}`, type: "block", content: { terminal: terminal.address },
    });
    if (tab) loose.push(tab);
  }
  addWorkspace(LOOSE_WORKSPACE_ID, "Terminals", loose);

  const focusedWorkspace = workspaces[0];
  const focusedTab = tabs.find((tab) => tab.tab_id === focusedWorkspace?.active_tab_id);
  const focusedPaneId = layouts.find((layout) => layout.tab_id === focusedTab?.tab_id)?.focused_pane_id;
  if (focusedWorkspace) focusedWorkspace.focused = true;
  if (focusedTab) focusedTab.focused = true;
  for (const pane of panes) if (pane.pane_id === focusedPaneId) pane.focused = true;
  for (const agent of agents) if (agent.pane_id === focusedPaneId) agent.focused = true;
  for (const layout of layouts) for (const entry of layout.panes) entry.focused = entry.pane_id === layout.focused_pane_id;

  return {
    version,
    protocol,
    workspaces,
    tabs,
    panes,
    agents,
    layouts,
    focused_workspace_id: focusedWorkspace?.workspace_id ?? null,
    focused_tab_id: focusedTab?.tab_id ?? null,
    focused_pane_id: focusedPaneId ?? null,
  };
}

/**
 * Applies one `events.subscribe` event to the terminal list (herdr-core schema/README.md, Events).
 * Returns whether the terminal set or a record changed.
 */
export function applyCoreEvent(terminals: CoreTerminal[], event: { type?: string; terminal?: string; data?: Record<string, unknown> }): boolean {
  const { type, terminal: address } = event;
  const data = event.data ?? {};
  if (!address || !type) return false;
  const at = terminals.findIndex((t) => t.address === address);
  const whole = type === "created" || type === "restarted" ? data : type === "labels" ? data["record"] : undefined;
  if (whole && typeof whole === "object") {
    if (at === -1) terminals.push(whole as CoreTerminal);
    else terminals[at] = whole as CoreTerminal;
    return true;
  }
  if (at === -1) return false;
  if (type === "removed") {
    terminals.splice(at, 1);
    return true;
  }
  const t = terminals[at]!;
  const set = (...keys: string[]) => { for (const key of keys) t[key] = data[key]; };
  switch (type) {
    case "finished":
    case "lost":
      set("reason", "exit_code", "signal", "finished_ms");
      t.state = type === "lost" ? "live" : "finished";
      if (type === "lost") t["pid"] = null;
      delete t.foreground;
      return true;
    case "status": set("status", "records", "reported"); return true;
    case "turn": set("turn"); return true;
    case "title": set("title"); return true;
    case "labels": set("labels"); return true;
    case "keep": set("keep"); return true;
    case "size": set("cols", "rows"); return true;
    case "foreground": t.foreground = (event.data ?? null) as CoreTerminal["foreground"]; return true;
    default: return false;
  }
}
