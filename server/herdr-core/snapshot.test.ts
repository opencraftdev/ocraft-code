import { describe, expect, test } from "bun:test";
import { applyCoreEvent, coreSnapshot, LOOSE_WORKSPACE_ID, type CoreTerminal, type LayoutDoc } from "./snapshot.ts";

const term = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({ address, state: "live", cwd: `/w/${address}`, cols: 80, rows: 24, ...extra });

// herdr-app's document shape (src/mirror.rs Document, src/layout.rs Node)
const doc: LayoutDoc = {
  spaces: [
    {
      id: "s1", name: "", folder: "/Users/can/api",
      tabs: [
        {
          id: "tab1", name: "work",
          root: { id: "tab1", type: "row", children: [
            { id: "p1", type: "block", content: { terminal: "t1" } },
            { id: "col", type: "column", children: [
              { id: "p2", type: "block", content: { terminal: "t2" } },
              { id: "p3", type: "block", content: { terminal: "t3" } },
            ] },
          ] },
        },
        { id: "tab2", name: "", root: { id: "tab2", type: "row", children: [{ id: "p9", type: "block", content: { terminal: "t9" } }] } },
      ],
    },
    { id: "s2", name: "docs", folder: "/d", tabs: [{ id: "tab3", name: "x", root: { id: "tab3", type: "stack", active: "p5", children: [
      { id: "p4", type: "block", content: { terminal: "t4" } },
      { id: "p5", type: "block", content: { terminal: "t5" } },
    ] } }] },
  ],
};

describe("coreSnapshot", () => {
  const terminals = [
    term("t1", { status: { state: "working", app: "claude-code" }, reported: true, turn: 3 }),
    term("t2", { cols: 40, rows: 10, status: { state: "error" }, reported: true }),
    term("t3", { cols: 40, rows: 13 }),
    term("t4"), term("t5", { title: "vim" }),
    term("t6", { name: "server" }),
    term("t7", { state: "finished" }),
  ];
  const snap = coreSnapshot({ doc, terminals, version: "herdr-core 0.1.11", protocol: 1 });

  test("spaces, tabs and terminal blocks become workspaces, tabs and panes", () => {
    expect(snap.workspaces.map((w) => [w.workspace_id, w.label, w.number, w.tab_count, w.pane_count])).toEqual([
      ["s1", "api", 1, 1, 3],
      ["s2", "docs", 2, 1, 2],
      [LOOSE_WORKSPACE_ID, "Terminals", 3, 1, 1],
    ]);
    // tab2's only terminal is gone: the tab is dropped
    expect(snap.tabs.map((t) => [t.tab_id, t.label, t.number])).toEqual([["tab1", "work", 1], ["tab3", "x", 1], [`${LOOSE_WORKSPACE_ID}:t6`, "server", 1]]);
    expect(snap.panes.map((p) => [p.pane_id, p.terminal_id, p.tab_id])).toEqual([
      ["p1", "t1", "tab1"], ["p2", "t2", "tab1"], ["p3", "t3", "tab1"], ["p4", "t4", "tab3"], ["p5", "t5", "tab3"], [`${LOOSE_WORKSPACE_ID}:t6`, "t6", `${LOOSE_WORKSPACE_ID}:t6`],
    ]);
  });

  test("7501 words become herdr statuses and roll up; reporting programs are agents", () => {
    expect(snap.panes.find((p) => p.pane_id === "p1")).toMatchObject({ agent_status: "working", agent: "claude-code", revision: 3 });
    expect(snap.panes.find((p) => p.pane_id === "p2")?.agent_status).toBe("blocked");
    expect(snap.panes.find((p) => p.pane_id === "p3")?.agent_status).toBe("unknown");
    expect(snap.workspaces[0]?.agent_status).toBe("blocked");
    expect(snap.agents.map((a) => a.pane_id)).toEqual(["p1", "p2"]);
  });

  test("rects follow each terminal's grid and an n-way split is binary", () => {
    const layout = snap.layouts.find((l) => l.tab_id === "tab1")!;
    expect(layout.area).toEqual({ x: 0, y: 0, width: 121, height: 24 });
    expect(layout.panes.map((p) => [p.pane_id, p.rect])).toEqual([
      ["p1", { x: 0, y: 0, width: 80, height: 24 }],
      ["p2", { x: 81, y: 0, width: 40, height: 10 }],
      ["p3", { x: 81, y: 11, width: 40, height: 13 }],
    ]);
    expect(layout.splits.map((s) => [s.direction, Number(s.ratio.toFixed(3))])).toEqual([["right", 0.667], ["down", 0.435]]);
  });

  test("a stack lays out its active child only", () => {
    const layout = snap.layouts.find((l) => l.tab_id === "tab3")!;
    expect(layout.panes.map((p) => p.pane_id)).toEqual(["p5"]);
    expect(layout.focused_pane_id).toBe("p5");
  });

  test("the first space, tab and pane read as focused", () => {
    expect([snap.focused_workspace_id, snap.focused_tab_id, snap.focused_pane_id]).toEqual(["s1", "tab1", "p1"]);
    expect(snap.panes.filter((p) => p.focused).map((p) => p.pane_id)).toEqual(["p1"]);
  });

  test("no document: every live terminal is loose", () => {
    const loose = coreSnapshot({ doc: null, terminals: [term("t1")], version: "v", protocol: 1 });
    expect(loose.workspaces.map((w) => w.workspace_id)).toEqual([LOOSE_WORKSPACE_ID]);
    expect(loose.focused_pane_id).toBe(`${LOOSE_WORKSPACE_ID}:t1`);
  });
});

describe("applyCoreEvent", () => {
  test("applies each event type as herdr-core's README says", () => {
    const list = [term("t1")];
    expect(applyCoreEvent(list, { type: "created", terminal: "t2", data: term("t2") })).toBe(true);
    applyCoreEvent(list, { type: "status", terminal: "t1", data: { status: { state: "done" }, records: {}, reported: true } });
    expect(list[0]?.status?.state).toBe("done");
    applyCoreEvent(list, { type: "size", terminal: "t1", data: { cols: 120, rows: 40 } });
    expect([list[0]?.cols, list[0]?.rows]).toEqual([120, 40]);
    applyCoreEvent(list, { type: "finished", terminal: "t1", data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 5 } });
    expect(list[0]?.state).toBe("finished");
    applyCoreEvent(list, { type: "removed", terminal: "t2", data: {} });
    expect(list.map((t) => t.address)).toEqual(["t1"]);
    expect(applyCoreEvent(list, { type: "status", terminal: "t9", data: {} })).toBe(false);
  });
});
