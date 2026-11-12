import { describe, expect, it } from "bun:test";
import type { AssistantSessionInfo, AssistantState } from "../shared/assistant.ts";
import { age, assessState, tailnetOf } from "./assistant-check.ts";

const NOW = 10 * 86_400_000;
const running: AssistantSessionInfo = { agent: "claude", pane_id: "w1:p1", started_at: NOW - 3 * 86_400_000 - 4 * 3_600_000, last_compaction: NOW - 7 * 60_000, state: "running" };
const state = (machines: AssistantState["machines"], session: AssistantSessionInfo | null = running): AssistantState => ({ machines, session });
const healthy = { id: "a", name: "air", state: "connected", maxRunning: 3, health: { checked_at: 1, problems: [], agents: ["claude"] } } as AssistantState["machines"][number];

describe("assistant-check", () => {
  it("passes connected machines with no problems and a long-lived session with a live pane", () => {
    const results = assessState(state([healthy]), NOW);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[1]).toEqual({ name: "long-lived", ok: true, detail: "pane w1:p1, running, claude for 3d 4h, compacted 7m ago" });
  });
  it("fails no machines, a disconnected or unhealthy one, and a session without a pane or restarting", () => {
    expect(assessState(state([]), NOW)[0]!.ok).toBe(false);
    expect(assessState(state([{ ...healthy, state: "disconnected" }]), NOW)[0]!.detail).toContain("air: disconnected");
    expect(assessState(state([{ ...healthy, health: { checked_at: 1, problems: ["not_connected"], agents: [] } }]), NOW)[0]!.ok).toBe(false);
    expect(assessState(state([{ ...healthy, health: null }]), NOW)[0]!.ok).toBe(false);
    expect(assessState(state([healthy], null), NOW)[1]).toMatchObject({ ok: false, detail: "no Assistant session yet" });
    expect(assessState(state([healthy], { ...running, pane_id: null }), NOW)[1]!.ok).toBe(false);
    expect(assessState(state([healthy], { ...running, state: "restarting" }), NOW)[1]!.ok).toBe(false);
    // a prompt waiting is shown, not failed
    expect(assessState(state([healthy], { ...running, state: "prompt", last_compaction: null }), NOW)[1]).toMatchObject({ ok: true, detail: expect.stringContaining("prompt") });
    expect(assessState(state([healthy], { ...running, last_compaction: null }), NOW)[1]!.detail).toContain("never compacted");
  });
  it("reads ages and the tailnet of a ts.net address only", () => {
    expect([age(30_000), age(125 * 60_000), age(26 * 3_600_000)]).toEqual(["0m", "2h 5m", "1d 2h"]);
    expect(tailnetOf("raka-devs.tail38376d.ts.net")).toBe("tail38376d.ts.net");
    expect(tailnetOf("a.b.tail1.ts.net")).toBeNull();
    expect(tailnetOf("example.com")).toBeNull();
  });
});
