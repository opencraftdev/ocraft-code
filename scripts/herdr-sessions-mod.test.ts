import { describe, expect, test } from "bun:test";
// @ts-expect-error a plain JS mod module
import { attachArgv, paneTitle, sessionGroups, statusOf } from "../herdr-mods/ovis-sessions/sessions.js";

const pane = (over: Record<string, unknown>) => ({ pane_id: "w1:p1", workspace_id: "w1", terminal_id: "term_abc", agent: "claude", agent_status: "idle", ...over });
const machine = (over: Record<string, unknown>) => ({
  id: "local", name: "air", kind: "local", state: "connected",
  snapshot: { workspaces: [{ workspace_id: "w1", label: "ovis" }, { workspace_id: "w2", label: "empty" }], panes: [] as unknown[] },
  ...over,
});

describe("ovis-sessions", () => {
  test("groups connected PCs' panes per workspace, agents first and urgent first", () => {
    const m = machine({});
    m.snapshot.panes = [pane({ pane_id: "w1:p1", agent: null }), pane({ pane_id: "w1:p2", agent_status: "done" }), pane({ pane_id: "w1:p3", agent_status: "blocked" })];
    const off = machine({ id: "x", state: "error" });
    off.snapshot.panes = [pane({})];
    const all = sessionGroups([m, off]);
    expect(all).toHaveLength(1);
    expect(all[0].workspaces.map((w: { label: string }) => w.label)).toEqual(["ovis"]);
    expect(all[0].workspaces[0].panes.map((p: { pane_id: string }) => p.pane_id)).toEqual(["w1:p3", "w1:p2", "w1:p1"]);
    expect(sessionGroups([m], true)[0].workspaces[0].panes).toHaveLength(2);
  });

  test("attaches with herdr's own terminal attach, over ssh for another PC, never --takeover", () => {
    expect(attachArgv(machine({}), pane({}))).toEqual(["sh", "-lc", `PATH="$HOME/.local/bin:$PATH"; exec herdr terminal attach 'term_abc'`]);
    const ssh = machine({ id: "m2", kind: "ssh", target: { destination: "potenlab-macbookpro" } });
    expect(attachArgv(ssh, pane({}))).toEqual(["ssh", "-t", "potenlab-macbookpro", `PATH="$HOME/.local/bin:$PATH"; exec herdr terminal attach 'term_abc'`]);
    expect(attachArgv(ssh, pane({})).join(" ")).not.toContain("takeover");
    expect(attachArgv(ssh, pane({ terminal_id: "x; rm -rf ~" }))).toBeNull();
    expect(attachArgv(machine({ id: "m3", kind: "ssh", target: { destination: "-oProxyCommand=x" } }), pane({}))).toBeNull();
    expect(attachArgv(machine({ kind: "ssh", id: "m4" }), pane({}))).toBeNull();
  });

  test("names and statuses", () => {
    expect(paneTitle(pane({ terminal_title_stripped: " Fix it " }))).toBe("Fix it");
    expect(paneTitle(pane({ display_agent: "Claude Code" }))).toBe("Claude Code");
    expect(paneTitle(pane({ agent: null, cwd: "/Users/a/repo/" }))).toBe("repo");
    expect(statusOf(pane({ agent_status: "blocked" })).word).toBe("Needs input");
    expect(statusOf(pane({ agent: null })).color).toBeNull();
  });
});
