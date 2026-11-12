import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AssistantState, AssistantTask } from "../../shared/assistant.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { chatRetry, LATER_RETRY_MS, STARTING_MS, startingRetry } from "../lib/startingChat.ts";
import { AssistantPanel, AssistantSetup } from "./AssistantView.tsx";

const wrap = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
const panel = (initial: AssistantState) => wrap(createElement(AssistantPanel, { initial }));

const empty: AssistantState = { machines: [], projects: [], sessions: [], tasks: [] };
const task = (id: string, status: AssistantTask["status"], title: string): AssistantTask => ({
  id, title, brief: "", project: "web", machine: "m1", agent: "claude", status, paneId: null, worktree: null, workspaceId: null,
  branch: `task-${id}`, review: false, autoMerge: false, createdAt: Number(id),
});

describe("the Assistant", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterAll(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("sets up from a page with the install command, the VM address and a way back to Code", () => {
    const page = wrap(createElement(AssistantSetup, { onBack: () => {} }));
    expect(page).toContain("data-testid=\"assistant-setup\"");
    expect(page).toContain("scripts/install-assistant.sh | bash");
    expect(page).toContain("Assistant VM address");
    expect(page).toContain("Back to Code");
    expect(page).not.toContain("<iframe");
  });

  it("puts New chat, the tasks, the projects and the machines in the right panel", () => {
    const page = panel(empty);
    expect(page).toContain("data-testid=\"assistant-panel\"");
    expect(page).toContain("<span>New chat</span>");
    for (const section of ["Projects", "Machines"]) expect(page).toContain(`>${section}</h2>`);
    expect(page).toContain("No tasks yet");
    expect(page).toContain("<summary>How to add</summary>");
    // no earlier chats yet: no list for them, and the panel has no close of its own (the header's button toggles it)
    expect(page).not.toContain("Earlier chats");
    expect(page).not.toContain("Hide tasks");
  });

  it("lists only the earlier chats, the current one being the pane beside it", () => {
    const started = Date.parse("2026-11-12T09:14:00");
    const page = panel({ ...empty, sessions: [
      { name: "20261112-0914", agent: "claude", started_at: started, pane_id: "p2" },
      { name: "20261112-0402", agent: "claude", started_at: started - 5 * 3_600_000, pane_id: null, archived_at: started },
    ] });
    expect(page).toContain(">Earlier chats</h2>");
    const rows = [...page.matchAll(/<button[^>]*title="(\d{8}-\d{4})"[^>]*>/g)].map((row) => row[1]);
    expect(rows).toEqual(["20261112-0402"]);
  });

  it("groups the tasks by status, what needs the user first, each head with its count", () => {
    const page = panel({ ...empty,
      machines: [{ id: "m1", name: "laptop", state: "connected", health: { checked_at: 0, problems: [], agents: ["claude"] }, maxRunning: 3 }],
      projects: [{ id: "web", machine: "m1", path: "/code/web", mergeMode: "pr", defaultAgent: "claude" }],
      tasks: [task("5", "working", "Fix login"), task("4", "needs_you", "Pick a font"), task("3", "working", "Add tests"), task("2", "done", "Bump deps")],
    });
    const groups = [...page.matchAll(/data-column="(\w+)"><h3 class="agent-panel-section-label">([^<]+)<span>(\d+)<\/span>/g)].map((match) => [match[1], match[2], match[3]]);
    expect(groups).toEqual([["needs_you", "Needs you", "1"], ["working", "Working", "2"], ["done", "Done", "1"]]);
    expect(page).toContain("#5 · web · laptop");
    expect(page).toContain("class=\"assistant-pill is-blocked\">Needs you</span>");
    expect(page).not.toContain("No tasks yet");
  });
});

describe("a chat that just started", () => {
  it("retries a failed read quietly, each second, until its time is up", () => {
    const started = 1_000_000;
    // the injected clock: no waiting in the test
    expect(startingRetry(started, started)).toBe(1000);
    expect(startingRetry(started, started + STARTING_MS - 300)).toBe(300);
    expect(startingRetry(started, started + STARTING_MS)).toBeNull();
    expect(startingRetry(undefined, started)).toBeNull();
  });

  it("keeps retrying a failed read after the quiet time, every few seconds, so it recovers by itself", () => {
    const started = 1_000_000;
    expect(chatRetry(started, started)).toBe(1000);
    expect(chatRetry(started, started + STARTING_MS + 60_000)).toBe(LATER_RETRY_MS);
    expect(chatRetry(undefined, started)).toBeNull();
  });
});
