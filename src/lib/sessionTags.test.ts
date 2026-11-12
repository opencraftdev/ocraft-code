import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { expandSessionTags, filterSessions, machineHost, machineLabel, machineNamesOf, parseSessionTags, removeTag, resolveTag, sessionPicker, sessionTag, tagBefore } from "./sessionTags.ts";

const pane = (pane_id: string, cwd: string, title: string, agent_status: HerdrPane["agent_status"] = "idle", workspace_id = "w1"): HerdrPane =>
  ({ pane_id, cwd, label: title, agent: "claude", agent_status, workspace_id, tab_id: "t1", terminal_id: pane_id, focused: false, revision: 1 }) as HerdrPane;
const machine = (id: string, name: string, panes: HerdrPane[], extra: Partial<Machine> = {}): Machine => ({
  id, name, kind: "ssh", enabled: true, state: "connected", error: null,
  snapshot: { panes, workspaces: [{ workspace_id: "w1", label: "Potenlab work" }] } as unknown as Machine["snapshot"],
  ...extra,
});

const pro = machine("m-pro", "macbook-pro", [pane("wV:p1", "/Users/potenlab/repo/trina-ax", "MCP progress", "working"), pane("wV:p2", "/Users/potenlab/repo/kiyoo", "Fix \"quoted\" checkout flow in the cart page")], { target: { destination: "potenlab@potenlab-macbookpro" } });
const air = machine("local", "Muhammads-MacBook-Air-2.local", [pane("w2:p4", "/Users/m/ovis", "Release notes", "blocked")], { kind: "local" });
const groups = sessionPicker([pro, air]).groups;

const names = new Map([["muhammads-macbook-air-2", "muhammad-macbook"]]);
const SESSION_ONE = "@session(machine=\"macbook-pro\" host=\"potenlab-macbookpro\" pane=\"wV:p1\" folder=\"/Users/potenlab/repo/trina-ax\" agent=\"claude\" title=\"MCP progress\")";

describe("session tags", () => {
  it("is @machine/folder, the VM's name for the PC when it has one, else its host", () => {
    expect(sessionTag({ machine: pro, pane: pro.snapshot!.panes[0]! }, groups)).toBe("@macbook-pro/trina-ax");
    expect(sessionTag({ machine: air, pane: air.snapshot!.panes[0]! }, groups)).toBe("@muhammads-macbook-air-2/ovis");
    expect(sessionTag({ machine: air, pane: air.snapshot!.panes[0]! }, groups, names)).toBe("@muhammad-macbook/ovis");
    expect(machineLabel(air, machineNamesOf({ machines: [{ name: "muhammad-macbook", host: "muhammads-macbook-air-2", id: "x" }, { name: 3 }] }))).toBe("muhammad-macbook");
    expect(machineNamesOf(null).size).toBe(0);
  });

  it("writes the pane out when another session of that PC has the same folder", () => {
    const twin = machine("m-pro", "macbook-pro", [pane("wV:p1", "/r/ovis", "A"), pane("wV:p2", "/other/ovis", "B")], { target: { destination: "potenlab@potenlab-macbookpro" } });
    const twinGroups = sessionPicker([twin]).groups;
    expect(sessionTag({ machine: twin, pane: twin.snapshot!.panes[1]! }, twinGroups)).toBe("@macbook-pro/ovis:wV:p2");
    const tag = parseSessionTags("see @macbook-pro/ovis:wV:p2.")[0]!;
    expect(tag).toMatchObject({ machine: "macbook-pro", folder: "ovis", pane: "wV:p2", text: "@macbook-pro/ovis:wV:p2" });
    expect(resolveTag(tag, twinGroups).map((item) => item.pane.pane_id)).toEqual(["wV:p2"]);
  });

  it("parses tags out of prose: punctuation after one is not its folder, an email or a path is no tag", () => {
    expect(parseSessionTags("ask @macbook-pro/trina-ax, then (@muhammad-macbook/ovis).").map((tag) => tag.text)).toEqual(["@macbook-pro/trina-ax", "@muhammad-macbook/ovis"]);
    expect(parseSessionTags("mail a@b/c and src/@x/y")).toEqual([]);
  });

  it("filters by title, folder, workspace label or PC name, words in any order, any case", () => {
    const panes = (query: string) => filterSessions(groups, query).flatMap((group) => group.panes.map((item) => item.pane_id));
    expect(panes("")).toEqual(["wV:p1", "wV:p2", "w2:p4"]);
    expect(panes("TRINA")).toEqual(["wV:p1"]);
    expect(panes("progress trina")).toEqual(["wV:p1"]);
    expect(panes("potenlab cart")).toEqual(["wV:p2"]);
    expect(panes("air release")).toEqual(["w2:p4"]);
    expect(panes("nothing")).toEqual([]);
  });

  it("lists PCs that are not connected apart, with no sessions", () => {
    const off = machine("m-off", "old-imac", [pane("w1:p1", "/x", "y")], { state: "disconnected" });
    const picker = sessionPicker([pro, off]);
    expect(picker.groups.map((group) => group.machine.name)).toEqual(["macbook-pro"]);
    expect(picker.offline.map((item) => item.name)).toEqual(["old-imac"]);
  });

  it("removes a known tag whole on Backspace right after it, and one doubled space with it; an unknown PC's is text", () => {
    const text = "ask @macbook-pro/trina-ax about it";
    const end = 4 + "@macbook-pro/trina-ax".length;
    expect(tagBefore(text, end, groups)).toMatchObject({ folder: "trina-ax" });
    expect(tagBefore(text, end + 1, groups)).toBeNull();
    expect(removeTag(text, tagBefore(text, end, groups)!)).toEqual({ text: "ask about it", caret: 4 });
    expect(tagBefore("@someone/else", 13, groups)).toBeNull();
  });

  it("names a PC's host: an SSH destination's without the tailnet suffix, this Ovis's own without .local", () => {
    expect(machineHost(pro)).toBe("potenlab-macbookpro");
    expect(machineHost(air)).toBe("muhammads-macbook-air-2");
    expect(machineHost({ ...pro, target: { destination: "opencraft@Raka-Devs.tail38376d.ts.net:22" } })).toBe("raka-devs");
  });

  it("expands tags to exact sessions: picked, by folder, closed, ambiguous; other text untouched", () => {
    const two = "@macbook-pro/kiyoo";
    const three = "@muhammad-macbook/ovis";
    expect(expandSessionTags(`compare @macbook-pro/trina-ax and ${two}, then ${three}; @macbook-pro/gone @nobody/x`, groups, [], new Map(), names)).toBe(
      `compare ${SESSION_ONE}`
      + " and @session(machine=\"macbook-pro\" host=\"potenlab-macbookpro\" pane=\"wV:p2\" folder=\"/Users/potenlab/repo/kiyoo\" agent=\"claude\" title=\"Fix \\\"quoted\\\" checkout flow in the cart page\")"
      + ", then @session(machine=\"muhammad-macbook\" host=\"muhammads-macbook-air-2\" pane=\"w2:p4\" folder=\"/Users/m/ovis\" agent=\"claude\" title=\"Release notes\")"
      + "; @macbook-pro/gone (closed) @nobody/x");
    // a picked tag is its own session even when the folder now has another; its pane gone, it is closed
    expect(expandSessionTags("@macbook-pro/trina-ax", groups, [], new Map([["@macbook-pro/trina-ax", { machineId: "m-pro", paneId: "wV:p1" }]]))).toBe(SESSION_ONE);
    expect(expandSessionTags("@macbook-pro/trina-ax", groups, [], new Map([["@macbook-pro/trina-ax", { machineId: "m-pro", paneId: "wV:p9" }]]))).toBe("@macbook-pro/trina-ax (closed)");
    const twin = machine("m-pro", "macbook-pro", [pane("wV:p1", "/r/ovis", "A"), pane("wV:p2", "/other/ovis", "B")], { target: { destination: "potenlab@potenlab-macbookpro" } });
    expect(expandSessionTags("@macbook-pro/ovis", sessionPicker([twin]).groups)).toContain("pane=\"wV:p1\"");
    expect(expandSessionTags("@macbook-pro/ovis", sessionPicker([twin]).groups)).toEndWith(" (ambiguous, also: wV:p2)");
    expect(expandSessionTags("no tags here", groups)).toBe("no tags here");
  });
});
