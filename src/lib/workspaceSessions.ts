import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";

/** The label server/conversation-fork.ts gives a fork's tab: `Fork · <source title>`. */
export const FORK_TAB_PREFIX = "Fork · ";

type Tab = SessionSnapshot["tabs"][number];
export interface WorkspaceSession { tab: Tab; pane: PaneInfo; fork: boolean; title: string | null }

/**
 * A workspace's agent sessions as the sidebar lists them (Claude-desktop style): the first tab is the
 * workspace's own row, every other tab running an agent sits under it, a fork as "title (fork)".
 * `title` is null where the row should say the pane's own title.
 */
export function workspaceSessions(tabs: readonly Tab[], panes: readonly PaneInfo[], workspaceId: string): { base: string | null; others: WorkspaceSession[] } {
  const own = tabs.filter((tab) => tab.workspace_id === workspaceId).sort((a, b) => a.number - b.number);
  const base = own[0]?.tab_id ?? null;
  const others = own.slice(1).flatMap((tab): WorkspaceSession[] => {
    const pane = panes.find((candidate) => candidate.tab_id === tab.tab_id && candidate.agent) ?? null;
    if (pane === null) return [];
    const fork = tab.label.startsWith(FORK_TAB_PREFIX);
    return [{ tab, pane, fork, title: fork ? `${tab.label.slice(FORK_TAB_PREFIX.length)} (fork)` : null }];
  });
  return { base, others };
}
