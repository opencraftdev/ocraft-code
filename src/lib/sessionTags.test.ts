import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { expandSessionTags, filterSessions, machineHost, parseSessionTags, removeTag, sessionPicker, sessionTag, tagBefore } from "./sessionTags.ts";

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

describe("session tags", () => {
  it("formats a tag that parses back to its machine and pane, the title cut", () => {
    const tag = sessionTag({ machine: pro, pane: pro.snapshot!.panes[1]! });
    expect(tag).toBe("@[macbook-pro wV:p2 · kiyoo · Fix \"quoted\" checkout f…]");
    expect(parseSessionTags(`see ${tag} now`)).toEqual([{ text: tag, start: 4, end: 4 + tag.length, machine: "macbook-pro", pane: "wV:p2", label: "macbook-pro · kiyoo · Fix \"quoted\" checkout f…" }]);
    expect(parseSessionTags("@[Muhammads MacBook p1 · x · y]")[0]).toMatchObject({ machine: "Muhammads MacBook", pane: "p1" });
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

  it("removes a tag whole on Backspace right after it, and one doubled space with it", () => {
    const tag = sessionTag({ machine: pro, pane: pro.snapshot!.panes[0]! });
    const text = `ask ${tag} about it`;
    expect(tagBefore(text, 4 + tag.length)).toMatchObject({ pane: "wV:p1" });
    expect(tagBefore(text, 5 + tag.length)).toBeNull();
    expect(removeTag(text, tagBefore(text, 4 + tag.length)!)).toEqual({ text: "ask about it", caret: 4 });
  });

  it("names a PC's host: an SSH destination's without the tailnet suffix, this Ovis's own without .local", () => {
    expect(machineHost(pro)).toBe("potenlab-macbookpro");
    expect(machineHost(air)).toBe("muhammads-macbook-air-2");
    expect(machineHost({ ...pro, target: { destination: "opencraft@Raka-Devs.tail38376d.ts.net:22" } })).toBe("raka-devs");
  });

  it("expands present tags to exact sessions, quotes escaped, and a gone one as typed with (closed)", () => {
    const one = sessionTag({ machine: pro, pane: pro.snapshot!.panes[0]! });
    const two = sessionTag({ machine: pro, pane: pro.snapshot!.panes[1]! });
    const three = sessionTag({ machine: air, pane: air.snapshot!.panes[0]! });
    const gone = "@[macbook-pro wV:p9 · old · Gone]";
    expect(expandSessionTags(`compare ${one} and ${two}, then ${three}; ${gone}`, groups)).toBe(
      "compare @session(machine=\"macbook-pro\" host=\"potenlab-macbookpro\" pane=\"wV:p1\" folder=\"/Users/potenlab/repo/trina-ax\" agent=\"claude\" title=\"MCP progress\")"
      + " and @session(machine=\"macbook-pro\" host=\"potenlab-macbookpro\" pane=\"wV:p2\" folder=\"/Users/potenlab/repo/kiyoo\" agent=\"claude\" title=\"Fix \\\"quoted\\\" checkout flow in the cart page\")"
      + ", then @session(machine=\"Muhammads-MacBook-Air-2.local\" host=\"muhammads-macbook-air-2\" pane=\"w2:p4\" folder=\"/Users/m/ovis\" agent=\"claude\" title=\"Release notes\")"
      + `; ${gone} (closed)`);
    expect(expandSessionTags("no tags here", groups)).toBe("no tags here");
  });
});
