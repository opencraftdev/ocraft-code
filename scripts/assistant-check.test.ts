import { describe, expect, it } from "bun:test";
import type { AssistantState } from "../shared/assistant.ts";
import { assessState, tailnetOf } from "./assistant-check.ts";

const state = (machines: AssistantState["machines"], pane: string | null = "w1:p1"): AssistantState => ({
  machines, projects: [], tasks: [],
  sessions: [{ name: "20261112-0707", agent: "claude", started_at: 1, pane_id: pane }],
});
const healthy = { id: "a", name: "air", state: "connected", maxRunning: 3, health: { checked_at: 1, problems: [], agents: ["claude"] } } as AssistantState["machines"][number];

describe("assistant-check", () => {
  it("passes connected machines with no problems and a chat with a pane", () => {
    expect(assessState(state([healthy])).every((result) => result.ok)).toBe(true);
  });
  it("fails no machines, a disconnected or unhealthy one, and a chat without a pane", () => {
    expect(assessState(state([]))[0]!.ok).toBe(false);
    expect(assessState(state([{ ...healthy, state: "disconnected" }]))[0]!.detail).toContain("air: disconnected");
    expect(assessState(state([{ ...healthy, health: { checked_at: 1, problems: ["not_connected"], agents: [] } }]))[0]!.ok).toBe(false);
    expect(assessState(state([{ ...healthy, health: null }]))[0]!.ok).toBe(false);
    expect(assessState(state([healthy], null))[1]!.ok).toBe(false);
  });
  it("reads the tailnet of a ts.net address only", () => {
    expect(tailnetOf("raka-devs.tail38376d.ts.net")).toBe("tail38376d.ts.net");
    expect(tailnetOf("a.b.tail1.ts.net")).toBeNull();
    expect(tailnetOf("example.com")).toBeNull();
  });
});
