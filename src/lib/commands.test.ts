import { describe, expect, it } from "bun:test";

import { commandForChord, fuzzyScore, rankCommands, registerCommands, runCommand, setPromptOpener, takePromptRequest, type AppCommand } from "./commands.ts";
import { matchShortcut, shortcutDisplayKeys, shortcutKeys, type ShortcutEventLike } from "./shortcuts.ts";
import { alertDecision } from "./alertToasts.ts";
import { numberedTarget, stepTarget } from "./useAppCommands.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

const rows = (titles: string[]) => titles.map((title) => ({ item: title, title, recentId: title }));

describe("fuzzy ranking", () => {
  it("matches letters in order and nothing else", () => {
    expect(fuzzyScore("ntb", "New tab")).not.toBeNull();
    expect(fuzzyScore("btn", "New tab")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks word starts above letters inside words", () => {
    expect(rankCommands("nt", rows(["Rename tab", "Next tab", "Toggle sidebar"]))).toEqual(["Next tab", "Rename tab"]);
    expect(rankCommands("sp", rows(["Settings", "Split pane right"]))[0]).toBe("Split pane right");
    // "ts" at the starts of Toggle Sidebar beats the t…s inside "Settings"
    expect(rankCommands("ts", rows(["Settings", "Toggle sidebar"]))[0]).toBe("Toggle sidebar");
  });

  it("puts the commands run last first on a blank query, then the rest in order", () => {
    expect(rankCommands("", rows(["A", "B", "C", "D"]), ["C", "A"])).toEqual(["C", "A", "B", "D"]);
  });

  it("finds a command by an alias after every title match", () => {
    const list = [{ item: "Theme", title: "Toggle theme", aliases: "dark light" }, { item: "Dark", title: "Darken" }];
    expect(rankCommands("dark", list)).toEqual(["Dark", "Theme"]);
  });
});

describe("command registry", () => {
  it("resolves a registered command's key per platform and forgets it on removal", () => {
    const ran: string[] = [];
    const command: AppCommand = { id: "test.go", label: "Go", keys: { mac: ["ctrl+1"], other: ["alt+1"] }, run: () => ran.push("go") };
    const remove = registerCommands([command]);
    expect(commandForChord("alt+1", false)?.id).toBe("test.go");
    expect(commandForChord("alt+1", true)).toBeNull();
    expect(commandForChord("ctrl+1", true)?.id).toBe("test.go");
    expect(runCommand("test.go")).toBe(true);
    expect(ran).toEqual(["go"]);
    remove();
    expect(commandForChord("alt+1", false)).toBeNull();
    expect(runCommand("test.go")).toBe(false);
  });

  it("opens the palette on a command's question and runs it with the answer", () => {
    const names: (string | undefined)[] = [];
    let opened = 0;
    setPromptOpener(() => { opened += 1; });
    const remove = registerCommands([{ id: "test.name", label: "Name it", prompt: "Name", run: (name) => names.push(name) }]);
    runCommand("test.name");
    expect(opened).toBe(1);
    expect(names).toEqual([]);
    expect(takePromptRequest()?.id).toBe("test.name");
    expect(takePromptRequest()).toBeNull();
    runCommand("test.name", "api");
    expect(names).toEqual(["api"]);
    remove();
    setPromptOpener(null);
  });
});

describe("herdr-app key defaults", () => {
  const key = (key: string, patch: Partial<ShortcutEventLike>): ShortcutEventLike => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch });
  it("opens the commands with Mod+Shift+P and the keys dialog with Ctrl+Shift+/ or ⌘/", () => {
    expect(matchShortcut(key("P", { ctrlKey: true, shiftKey: true }), false)).toBe("commands");
    expect(matchShortcut(key("P", { metaKey: true, shiftKey: true }), true)).toBe("commands");
    expect(matchShortcut(key("?", { ctrlKey: true, shiftKey: true, code: "Slash" }), false)).toBe("help");
    expect(matchShortcut(key("/", { metaKey: true, code: "Slash" }), true)).toBe("help");
  });

  it("steps tabs with Alt+[ / ], agents with Alt+↑/↓ (⌘[ / ] on a Mac), workspaces with ⌘⌥[ / ]", () => {
    expect(matchShortcut(key("]", { altKey: true, code: "BracketRight" }), false)).toBe("next-tab");
    // Option+] types a quote on a Mac: the key is read by where it sits
    expect(matchShortcut(key("‘", { altKey: true, code: "BracketRight" }), true)).toBe("next-tab");
    expect(matchShortcut(key("ArrowDown", { altKey: true }), false)).toBe("next-agent");
    expect(matchShortcut(key("ArrowUp", { altKey: true }), false)).toBe("previous-agent");
    expect(matchShortcut(key("[", { metaKey: true, code: "BracketLeft" }), true)).toBe("previous-agent");
    expect(matchShortcut(key("[", { metaKey: true, altKey: true, code: "BracketLeft" }), true)).toBe("previous-workspace");
    expect(matchShortcut(key("F2", { code: "F2" }), false)).toBe("rename-tab");
    expect(matchShortcut(key("d", { metaKey: true, code: "KeyD" }), true)).toBe("split-right");
    expect(matchShortcut(key("d", { metaKey: true, code: "KeyD" }), false)).toBeNull();
  });

  it("lets a changed or removed binding replace the default", () => {
    expect(matchShortcut(key("ArrowDown", { altKey: true }), false, { "next-agent": null })).toBeNull();
    expect(shortcutKeys("next-agent", {}, false)).toEqual(["alt+ArrowDown"]);
    expect(shortcutDisplayKeys("next-agent", {}, true)).toEqual(["Meta", "]"]);
    expect(shortcutDisplayKeys("split-down", {}, true)).toEqual(["Shift", "Meta", "D"]);
    expect(shortcutDisplayKeys("help", {}, false)).toEqual(["Mod", "Shift", "/"]);
  });
});

describe("alert decision", () => {
  it("sounds a question always, a finish only away from it, and shows a card only away from it", () => {
    expect(alertDecision("blocked", true)).toEqual({ sound: true, toast: false });
    expect(alertDecision("blocked", false)).toEqual({ sound: true, toast: true });
    expect(alertDecision("done", true)).toEqual({ sound: false, toast: false });
    expect(alertDecision("done", false)).toEqual({ sound: true, toast: true });
    expect(alertDecision("ended", true)).toEqual({ sound: false, toast: false });
  });
});

describe("navigation targets", () => {
  const pane = (pane_id: string, workspace_id: string, tab_id: string, agent: string | null = null) => ({ pane_id, workspace_id, tab_id, agent }) as unknown as HerdrPane;
  const snapshot = {
    workspaces: [
      { workspace_id: "w1", active_tab_id: "t2", label: "api" },
      { workspace_id: "w2", active_tab_id: "t3", label: "web" },
      { workspace_id: "w3", active_tab_id: "t4", label: "empty" },
    ],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "1", number: 1 },
      { tab_id: "t2", workspace_id: "w1", label: "2", number: 2 },
      { tab_id: "t3", workspace_id: "w2", label: "1", number: 1 },
    ],
    layouts: [{ tab_id: "t2", focused_pane_id: "p3" }],
    panes: [pane("p1", "w1", "t1", "claude"), pane("p2", "w1", "t2"), pane("p3", "w1", "t2", "codex"), pane("p4", "w2", "t3", "claude")],
  } as never;

  it("steps tabs within the workspace, landing on herdr's focused pane", () => {
    expect(stepTarget("tab", snapshot, "p1", 1)).toBe("p3");
    expect(stepTarget("tab", snapshot, "p3", 1)).toBe("p1");
    expect(stepTarget("tab", snapshot, "p4", 1)).toBeNull();
  });

  it("steps workspaces with panes, wrapping around", () => {
    expect(stepTarget("workspace", snapshot, "p1", 1)).toBe("p4");
    expect(stepTarget("workspace", snapshot, "p4", 1)).toBe("p3");
    expect(stepTarget("workspace", snapshot, "p1", -1)).toBe("p4");
  });

  it("steps agents only, from a shell to the nearest agent that way", () => {
    expect(stepTarget("agent", snapshot, "p1", 1)).toBe("p3");
    expect(stepTarget("agent", snapshot, "p4", 1)).toBe("p1");
    expect(stepTarget("agent", snapshot, "p2", 1)).toBe("p3");
    expect(stepTarget("agent", snapshot, "p2", -1)).toBe("p1");
  });

  it("goes to the nth workspace or tab", () => {
    expect(numberedTarget("workspace", snapshot, "p1", 2)).toBe("p4");
    expect(numberedTarget("workspace", snapshot, "p1", 3)).toBeNull();
    expect(numberedTarget("tab", snapshot, "p4", 1)).toBe("p4");
    expect(numberedTarget("tab", snapshot, "p1", 2)).toBe("p3");
  });
});
