import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AssistantState, AssistantTask } from "../../shared/assistant.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { chatRetry, LATER_RETRY_MS, STARTING_MS, startingRetry } from "../lib/startingChat.ts";
import { AssistantView, type AssistantChat } from "./AssistantView.tsx";

type Props = Parameters<typeof AssistantView>[0];
const render = (props: Props) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(AssistantView, props) }));

const empty: AssistantState = { machines: [], projects: [], sessions: [], tasks: [] };
const task = (id: string, status: AssistantTask["status"], title: string): AssistantTask => ({
  id, title, brief: "", project: "web", machine: "m1", agent: "claude", status, paneId: null, worktree: null, workspaceId: null,
  branch: `task-${id}`, review: false, autoMerge: false, createdAt: Number(id),
});

describe("Assistant mode", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterAll(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("shows the setup page on an Ovis that is not the Assistant VM", () => {
    const page = render({ vm: false });
    expect(page).toContain("data-testid=\"assistant-setup\"");
    expect(page).toContain("scripts/install-assistant.sh | bash");
    expect(page).toContain("Assistant VM address");
    expect(page).not.toContain("assistant-layout");
  });

  it("starts empty as the Claude app does: New chat in the sidebar, the greeting in the middle", () => {
    const page = render({ vm: true, initial: empty });
    expect(page).toContain("data-testid=\"assistant-layout\"");
    for (const section of ["Sessions", "Projects", "Machines"]) expect(page).toContain(`>${section}</h2>`);
    expect(page).toContain("<span>New chat</span>");
    expect(page).toContain("What should the Assistant do?</h1>");
    expect(page).toContain("0 machines · 0 projects");
    // one short line each, the machines' how-to folded
    expect(page.match(/None yet/g)).toHaveLength(3);
    expect(page).toContain("<summary>How to add</summary>");
    expect(page).toContain("No tasks yet");
    expect(page).not.toContain("assistant-setup");
  });

  it("lists the chats with the current one selected, and names it in the bar", () => {
    const started = Date.parse("2026-11-12T09:14:00");
    const page = render({ vm: true, initial: { ...empty, sessions: [
      { name: "20261112-0914", agent: "claude", started_at: started, pane_id: "p2" },
      { name: "20261112-0402", agent: "claude", started_at: started - 5 * 3_600_000, pane_id: null, archived_at: started },
    ] } });
    const rows = [...page.matchAll(/<button[^>]*title="(\d{8}-\d{4})"[^>]*>/g)];
    expect(rows.map((row) => row[1])).toEqual(["20261112-0914", "20261112-0402"]);
    expect(rows[0]![0]).toContain("aria-current=\"true\"");
    expect(rows[1]![0]).not.toContain("aria-current");
    expect(page).toContain(">Current</span>");
    expect(page).toContain("class=\"assistant-crumb-current\" title=\"20261112-0914\"");
  });

  it("hands the chat lens the Assistant's greeting and its start, and says Starting… until its pane shows", () => {
    const now = Date.now();
    const seen: AssistantChat[] = [];
    const state = (started_at: number): AssistantState => ({ ...empty, machines: [{ id: "m1", name: "laptop", state: "connected", health: null, maxRunning: 3 }], sessions: [{ name: "x", agent: "claude", started_at, pane_id: "p1" }] });
    const shown = render({ vm: true, initial: state(now), renderChat: (paneId, chat) => { seen.push(chat); return createElement("div", { id: paneId }); } });
    expect(shown).toContain("id=\"p1\"");
    expect(seen[0]).toEqual({ greeting: { title: "What should the Assistant do?", where: "1 machine · 0 projects" }, startedAt: now });
    // just started: no pane in the snapshot yet
    expect(render({ vm: true, initial: state(now), renderChat: () => null })).toContain("Starting…");
    expect(render({ vm: true, initial: state(now - STARTING_MS - 1), renderChat: () => null })).toContain("The Assistant&#x27;s pane is not open");
  });

  it("groups the tasks by status, what needs the user first, each head with its count", () => {
    const page = render({ vm: true, initial: { ...empty,
      machines: [{ id: "m1", name: "laptop", state: "connected", health: { checked_at: 0, problems: [], agents: ["claude"] }, maxRunning: 3 }],
      projects: [{ id: "web", machine: "m1", path: "/code/web", mergeMode: "pr", defaultAgent: "claude" }],
      tasks: [task("5", "working", "Fix login"), task("4", "needs_you", "Pick a font"), task("3", "working", "Add tests"), task("2", "done", "Bump deps")],
    } });
    const groups = [...page.matchAll(/data-column="(\w+)"><h3 class="agent-panel-section-label">([^<]+)<span>(\d+)<\/span>/g)].map((match) => [match[1], match[2], match[3]]);
    expect(groups).toEqual([["needs_you", "Needs you", "1"], ["working", "Working", "2"], ["done", "Done", "1"]]);
    expect(page).toContain("#5 · web · laptop");
    expect(page).toContain("class=\"assistant-pill is-blocked\">Needs you</span>");
    expect(page).not.toContain("No tasks yet");
  });

  it("draws no header or second app name in the frame: the embedding Ovis's header names the app", () => {
    const framed = render({ vm: true, embedded: true, initial: empty });
    expect(framed).not.toContain("app-header");
    expect(framed).not.toContain("assistant-brand");
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
