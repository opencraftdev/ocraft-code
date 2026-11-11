import { describe, expect, it } from "bun:test";
import { agentActivityGroups, dagrGraph, layoutAgentGraph, sessionGraph, transcriptAgents } from "./agentGraph.ts";
import type { ConversationTurn, OmoTask } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/agent-run.json";

const task = (id: string, status: OmoTask["status"]): OmoTask => ({ id, title: id, status, category: null, model: null, started_at: null, ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: "claude-subagent" });
const tool = (name: string, input: unknown, output: unknown): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "tool", name, summary: "", input: JSON.stringify(input), output: JSON.stringify(output) }] });

describe("agent graph facts", () => {
  it("shows real children and explicit plan dependencies without treating a ready agent as verified work", () => {
    const graph = sessionGraph({ paneId: "p1", title: "Parent", status: "done", tasks: [task("one", "running"), task("two", "failed")], steps: [
      { id: "a", label: "Build", active: null, status: "completed", blocked_by: [], owner: null, started_at: null, ended_at: null },
      { id: "b", label: "Test", active: null, status: "pending", blocked_by: ["a", "missing"], owner: null, started_at: null, ended_at: null },
    ] });
    expect(graph.nodes[0]?.state).toBe("idle");
    expect(graph.edges).toContainEqual({ from: "pane:p1", to: "task:one", kind: "spawn" });
    expect(graph.edges).toContainEqual({ from: "plan:a", to: "plan:b", kind: "dependency" });
    expect(graph.edges.some(edge => edge.from.includes("missing"))).toBe(false);
  });

  it("uses structured spawn and wait receipts, retaining unknown status instead of guessing from prose", () => {
    const turns = [tool("collaboration.spawn_agent", { task_name: "review", model: "test-model" }, { agent_id: "child" })];
    expect(transcriptAgents(turns)[0]?.state).toBe("unknown");
    turns.push(tool("wait", { ids: ["child"] }, { status: { child: { completed: "Review finished" } } }));
    expect(transcriptAgents(turns)[0]).toMatchObject({ id: "agent:child", label: "review", model: "test-model", state: "done" });
    expect(transcriptAgents([tool("read", {}, { agent_id: "not-a-spawn" })])).toEqual([]);
    expect(transcriptAgents([tool("spawn_agent", {}, "agent_id: guessed")])).toEqual([]);
    const known = transcriptAgents(turns.slice(0, 1));
    const updated = transcriptAgents(turns.slice(1), known);
    expect(updated[0]?.state).toBe("done");
    expect(known[0]?.state).toBe("unknown");
  });

  it("bounds a large list and drops edges to nodes outside the visible window", () => {
    const graph = sessionGraph({ paneId: "p", title: "Parent", status: "working", tasks: Array.from({ length: 300 }, (_, index) => task(String(index), "running")), steps: null });
    expect(graph.nodes).toHaveLength(240);
    expect(graph.hidden).toBe(61);
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
  });
});

describe("dagr projection", () => {
  it("renders fan-in gates, recorded rework, planned futures and evidence as separate facts", () => {
    const graph = dagrGraph(fixture);
    expect(graph.source).toBe("dagr");
    expect(graph.nodes.find(node => node.id === "dagr:gate")?.kind).toBe("gate");
    expect(graph.edges).toContainEqual({ from: "dagr:tests", to: "dagr:gate", kind: "dependency" });
    expect(graph.edges).toContainEqual({ from: "attempt:review-a1", to: "attempt:build-a2", kind: "retry" });
    expect(graph.edges).toContainEqual({ from: "dagr:build", to: "dagr:review", kind: "planned" });
    expect(graph.nodes.find(node => node.id === "attempt:research-a1")?.evidence).toBe("reported");
    expect(graph.nodes.find(node => node.id === "attempt:review-a1")?.evidence).toBe("verified");
    expect(graph.nodes.find(node => node.id === "dagr:build")?.progress).toBe("2/3");
  });

  it("lays out a planned loop-back deterministically without recursive traversal", () => {
    const input = structuredClone(fixture);
    input.tasks[1]!.policy!.futures.push({ on: "fail", ref: "research" });
    const graph = dagrGraph(input), layout = layoutAgentGraph(graph);
    expect(layout).toHaveLength(graph.nodes.length);
    expect(new Set(layout.map(node => node.row)).size).toBe(graph.nodes.length);
    expect(layout.every(node => Number.isFinite(node.depth) && node.depth <= 4)).toBe(true);
    expect(layoutAgentGraph(graph)).toEqual(layout);
  });

  it("does not manufacture terminal evidence or queued policy branches", () => {
    const graph = dagrGraph({ dagr: 3, run: { id: "r" }, tasks: [{ id: "a", title: "A", kind: "impl", state: "queued", attempts: [], policy: { futures: [{ on: "pass", node: { id: "b" } }] } }] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.evidence).toBeUndefined();
  });

  it("rejects broken, duplicate and cyclic run documents instead of replacing valid graph facts", () => {
    expect(() => dagrGraph({ dagr: 4, run: { id: "r" }, tasks: [] })).toThrow();
    const tasks = [{ id: "a", title: "A", kind: "impl", state: "queued", deps: ["b"] }, { id: "b", title: "B", kind: "impl", state: "queued", deps: ["a"] }];
    expect(() => dagrGraph({ dagr: 3, run: { id: "r" }, tasks })).toThrow("dagr_dependency_cycle");
    expect(() => dagrGraph({ dagr: 3, run: { id: "r" }, tasks: [tasks[0], tasks[0]] })).toThrow();
    expect(() => dagrGraph({ dagr: 3, run: { id: "r" }, tasks: [tasks[0]] })).toThrow("invalid_dagr_dependency");
    expect(() => dagrGraph({ dagr: 3, run: { id: "r" }, tasks: Array.from({ length: 4100 }, (_, index) => ({ id: String(index) })) })).toThrow("dagr_too_large");
  });
});


describe("separate agent and background task activity", () => {
  it("separates a native subagent from background work without duplicating the parent or its plan", () => {
    const task = (id: string, detail_kind: "claude-subagent" | null) => ({ id, title: id, category: null, model: null, status: "running", started_at: null, ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind }) as OmoTask;
    const graph = sessionGraph({ paneId: "p", title: "Parent", status: "working", tasks: [task("agent-child", "claude-subagent"), task("background-test", null)], steps: [{ id: "foreground-plan", label: "Plan", status: "pending", owner: null, active: null, blocked_by: [], started_at: null, ended_at: null }] });
    const groups = agentActivityGroups(graph);
    expect(groups.agents.map(node => node.id)).toEqual(["task:agent-child"]);
    expect(groups.tasks.map(node => node.id)).toEqual(["task:background-test"]);
  });
  it("keeps structured Codex spawns in Agents rather than Background tasks", () => {
    const graph = sessionGraph({ paneId: "p", title: "Parent", status: "working", tasks: [], steps: null, turns: [tool("spawn_agent", {task_name:"Research"}, {agent_id:"child"})] });
    const groups = agentActivityGroups(graph);
    expect(groups.agents.map(node => node.id)).toEqual(["agent:child"]);
    expect(groups.tasks).toEqual([]);
  });
});
