import { describe, expect, test } from "bun:test";

import { agentGroups, agentRank, cleanAgentTitle, clearUnread, stepAgent, trackChanges, unreadKey } from "./agentList.ts";
import type { KnownStatus } from "./status.ts";

interface Row { key: string; status: KnownStatus; space: string; kids?: KnownStatus[]; since?: number }
const groups = (view: "priority" | "space", rest: Row[], pinned: Row[] = []) => agentGroups({
  view, pinned, rest,
  rankOf: (row) => agentRank(row.status, row.kids),
  sinceOf: (row) => row.since ?? 0,
  spaceOf: (row) => ({ id: row.space, label: row.space.toUpperCase() }),
}).map((group) => ({ id: group.id, label: group.label, rank: group.rank, keys: group.members.map((row) => row.key) }));

describe("rollup", () => {
  test("blocked > done > working > idle; waiting counts as working, unknown as idle", () => {
    const order = (["idle", "working", "blocked", "done", "waiting", "unknown"] as const).map((status) => [status, agentRank(status)]);
    expect(order).toEqual([["idle", 1], ["working", 2], ["blocked", 4], ["done", 3], ["waiting", 2], ["unknown", 1]]);
  });

  test("a parent takes its most urgent sub-agent's rank, never a lower one", () => {
    expect(agentRank("idle", ["working", "idle"])).toBe(2);
    expect(agentRank("done", ["working"])).toBe(3);
    expect(agentRank("idle", ["blocked"])).toBe(4);
  });
});

describe("priority view", () => {
  test("sections by urgency, the latest change first in each, then the roster's order; pins first in pin order", () => {
    const rest: Row[] = [
      { key: "a", status: "idle", space: "w1" },
      { key: "b", status: "working", space: "w1", since: 10 },
      { key: "c", status: "working", space: "w2", since: 20 },
      { key: "d", status: "blocked", space: "w2" },
      { key: "e", status: "idle", space: "w1", kids: ["working"], since: 5 },
      { key: "f", status: "done", space: "w2" },
      { key: "g", status: "idle", space: "w2" },
    ];
    expect(groups("priority", rest, [{ key: "p2", status: "idle", space: "w1" }, { key: "p1", status: "blocked", space: "w1" }])).toEqual([
      { id: "pinned", label: "", rank: null, keys: ["p2", "p1"] },
      { id: "rank-4", label: "", rank: 4, keys: ["d"] },
      { id: "rank-3", label: "", rank: 3, keys: ["f"] },
      { id: "rank-2", label: "", rank: 2, keys: ["c", "b", "e"] },
      { id: "rank-1", label: "", rank: 1, keys: ["a", "g"] },
    ]);
  });
});

describe("by space view", () => {
  test("one group per space in the order spaces first come, rows in the roster's order, even when interleaved", () => {
    const rest: Row[] = [
      { key: "a", status: "idle", space: "w2" },
      { key: "b", status: "blocked", space: "w1" },
      { key: "c", status: "working", space: "w2" },
    ];
    expect(groups("space", rest)).toEqual([
      { id: "w2", label: "W2", rank: null, keys: ["a", "c"] },
      { id: "w1", label: "W1", rank: null, keys: ["b"] },
    ]);
  });
});

describe("seen", () => {
  test("a change is stamped once; done and idle are one state, so looking at a finish does not move it", () => {
    const first = trackChanges({}, [{ key: "a", status: "working" }], 100)!;
    expect(first).toEqual({ a: { s: "working", at: 100 } });
    const done = trackChanges(first, [{ key: "a", status: "done" }], 200)!;
    expect(done).toEqual({ a: { s: "idle", at: 200 } });
    expect(trackChanges(done, [{ key: "a", status: "idle" }], 300)).toBeNull();
  });

  test("a row gone for a month leaves with the next change; one gone less long stays", () => {
    const month = 30 * 86_400_000;
    const changed = { old: { s: "idle", at: 0 }, recent: { s: "idle", at: month } };
    expect(Object.keys(trackChanges(changed, [{ key: "new", status: "working" }], month + 1)!)).toEqual(["recent", "new"]);
  });

  test("mark unread is for one finish; opening the row clears its marks only", () => {
    const keys = [unreadKey("pc:p1", 3), unreadKey("pc:p10", 1)];
    expect(clearUnread(keys, "pc:p1")).toEqual(["pc:p10#1"]);
  });
});

describe("titles", () => {
  test("strips a leading status glyph, spinner or Codex mark, keeping brackets, quotes and paths", () => {
    expect(cleanAgentTitle("✦  Working")).toBe("Working");
    expect(cleanAgentTitle("⠋ - Thinking")).toBe("Thinking");
    expect(cleanAgentTitle("[ ! ] fix login")).toBe("fix login");
    expect(cleanAgentTitle("[web] login")).toBe("[web] login");
    expect(cleanAgentTitle("“quoted” title")).toBe("“quoted” title");
    expect(cleanAgentTitle("● ~/src/api")).toBe("~/src/api");
    expect(cleanAgentTitle("✳")).toBe("✳");
  });
});

describe("stepping", () => {
  test("next and previous wrap round; with no row selected they start at an end", () => {
    expect(stepAgent(["a", "b", "c"], "b", 1)).toBe("c");
    expect(stepAgent(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepAgent(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepAgent(["a", "b", "c"], null, 1)).toBe("a");
    expect(stepAgent(["a", "b", "c"], "gone", -1)).toBe("c");
    expect(stepAgent([], "a", 1)).toBeNull();
  });
});
