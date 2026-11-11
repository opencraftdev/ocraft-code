import { describe, expect, test } from "bun:test";
import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { workspaceSessions } from "./workspaceSessions.ts";

type Tab = SessionSnapshot["tabs"][number];
const tab = (tab_id: string, number: number, label: string, workspace_id = "w1") => ({ tab_id, workspace_id, number, label, focused: false, pane_count: 1, agent_status: "idle" }) as Tab;
const pane = (pane_id: string, tab_id: string, agent: string | null) => ({ pane_id, tab_id, workspace_id: "w1", agent }) as PaneInfo;

describe("workspaceSessions", () => {
  test("keeps the first tab as the row and nests other agent tabs, a fork named as one", () => {
    const tabs = [tab("w1:t2", 2, "Fork · trina ax"), tab("w1:t1", 1, "trina ax"), tab("w1:t3", 3, "Shell"), tab("w2:t1", 1, "other", "w2")];
    const panes = [pane("p1", "w1:t1", "claude"), pane("p2", "w1:t2", "claude"), pane("p3", "w1:t3", null)];
    const { base, others } = workspaceSessions(tabs, panes, "w1");
    expect(base).toBe("w1:t1");
    expect(others.map((session) => [session.pane.pane_id, session.fork, session.title])).toEqual([["p2", true, "trina ax (fork)"]]);
  });
});
