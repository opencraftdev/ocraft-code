import type { ConversationTurn, OmoTask, PlanStep } from "../../shared/protocol.ts";

export type GraphState = "working" | "done" | "failed" | "blocked" | "queued" | "cancelled" | "review" | "unknown" | "idle";
export interface AgentGraphNode {
  id: string;
  label: string;
  kind: "agent" | "task" | "gate" | "attempt" | "future";
  state: GraphState;
  model?: string;
  actor?: string;
  note?: string;
  evidence?: string;
  progress?: string;
  task?: OmoTask;
  paneId?: string;
  condition?: "pass" | "fail";
}
export interface AgentGraphEdge { from: string; to: string; kind: "spawn" | "dependency" | "attempt" | "retry" | "planned" }
export interface AgentGraph { title: string; source: "session" | "dagr"; nodes: AgentGraphNode[]; edges: AgentGraphEdge[]; hidden: number }
/** Native agents and background jobs stay distinct; a foreground plan is neither. */
export function agentActivityGroups(graph: AgentGraph): { agents: AgentGraphNode[]; tasks: AgentGraphNode[] } {
  const children = graph.nodes.filter(node => !node.paneId && !node.id.startsWith("plan:"));
  return { agents: children.filter(node => node.kind === "agent"), tasks: children.filter(node => node.kind === "task") };
}
export interface PositionedAgentNode extends AgentGraphNode { depth: number; row: number }
const MAX_NODES = 240;
const MAX_ITEMS = 4096;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const words = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.slice(0, 2000) : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const stateOf = (value: unknown): GraphState => {
  if (value === "working" || value === "running" || value === "in_progress") return "working";
  if (value === "completed" || value === "done") return "done";
  if (value === "failed" || value === "rejected" || value === "lost" || value === "errored") return "failed";
  if (value === "blocked" || value === "review") return value;
  if (value === "cancelled" || value === "canceled" || value === "skipped") return "cancelled";
  if (value === "pending" || value === "queued" || value === "scheduled") return "queued";
  return "unknown";
};

function bounded(graph: AgentGraph): AgentGraph {
  const ids = new Set(graph.nodes.slice(0, MAX_NODES).map(node => node.id));
  return { ...graph, hidden: graph.nodes.length - ids.size, nodes: graph.nodes.slice(0, MAX_NODES), edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) };
}

/** Only structured spawn receipts and status records count as evidence, never tool prose. */
export function transcriptAgents(turns: readonly ConversationTurn[], known: readonly AgentGraphNode[] = []): AgentGraphNode[] {
  const agents = new Map<string, AgentGraphNode>(known.map(node => [node.id.slice("agent:".length), { ...node }]));
  for (const turn of turns) for (const part of turn.parts) {
    if (part.kind !== "tool") continue;
    const name = part.name.split(/[./]/).at(-1);
    let input: Record<string, unknown> | null = null, output: Record<string, unknown> | null = null;
    try { input = record(JSON.parse(part.input)); } catch { /* Non-JSON calls supply no graph facts. */ }
    try { output = record(JSON.parse(part.output)); } catch { /* Text alone never settles an agent. */ }
    if (name === "spawn_agent" && output !== null && !part.error) {
      const id = words(output["agent_id"]) ?? words(output["id"]);
      if (!id || agents.has(id)) continue;
      agents.set(id, {
        id: `agent:${id}`, label: words(input?.["task_name"]) ?? words(output["nickname"]) ?? words(input?.["agent_type"]) ?? id,
        kind: "agent", state: "unknown", ...(words(input?.["model"]) ? { model: words(input?.["model"])! } : {}),
        ...(words(input?.["message"]) ? { note: words(input?.["message"])! } : {}),
      });
    }
    // Codex wait receipts use {status: {agent_id: {completed: ...} | "running"}}.
    if ((name === "wait" || name === "wait_agent") && output !== null) {
      for (const [id, value] of Object.entries(record(output["status"]) ?? {})) {
        const node = agents.get(id);
        if (!node) continue;
        const status = record(value);
        node.state = status && "completed" in status ? "done" : status && "errored" in status ? "failed" : stateOf(value);
      }
    }
  }
  return [...agents.values()];
}

/** The selected session owns these children. Plan dependencies come from explicit blocked_by IDs. */
export function sessionGraph(input: { paneId: string; title: string; status: string | null | undefined; tasks: readonly OmoTask[]; steps: readonly PlanStep[] | null; turns?: readonly ConversationTurn[]; agents?: readonly AgentGraphNode[] }): AgentGraph {
  const root: AgentGraphNode = { id: `pane:${input.paneId}`, label: input.title, kind: "agent", paneId: input.paneId, state: input.status === "working" ? "working" : input.status === "blocked" ? "blocked" : "idle" };
  const tasks: AgentGraphNode[] = input.tasks.map(task => ({ id: `task:${task.id}`, label: task.title, kind: task.detail_kind === "claude-subagent" ? "agent" : "task", state: stateOf(task.status), task,
    ...(task.model ? { model: task.model } : {}), ...(task.category ? { actor: task.category } : {}) }));
  const spawned = transcriptAgents(input.turns ?? [], input.agents);
  const steps: AgentGraphNode[] = (input.steps ?? []).map(step => ({ id: `plan:${step.id}`, label: step.label, kind: "task", state: stateOf(step.status), ...(step.owner ? { actor: step.owner } : {}), ...(step.active ? { note: step.active } : {}) }));
  const edges: AgentGraphEdge[] = [...tasks, ...spawned].map(node => ({ from: root.id, to: node.id, kind: "spawn" }));
  const stepIds = new Set((input.steps ?? []).map(step => step.id));
  for (const step of input.steps ?? []) {
    const dependencies = step.blocked_by.filter(id => stepIds.has(id) && id !== step.id);
    if (dependencies.length === 0) edges.push({ from: root.id, to: `plan:${step.id}`, kind: "dependency" });
    for (const id of dependencies) edges.push({ from: `plan:${id}`, to: `plan:${step.id}`, kind: "dependency" });
  }
  return bounded({ title: input.title, source: "session", nodes: [root, ...tasks, ...spawned, ...steps], edges, hidden: 0 });
}

/** Read-only dagr v1–v3 projection. Policies stay dotted; evidence and unknown states stay distinct. */
export function dagrGraph(value: unknown): AgentGraph {
  const doc = record(value), run = record(doc?.["run"]);
  if (!doc || ![1, 2, 3].includes(Number(doc["dagr"])) || !words(run?.["id"]) || !Array.isArray(doc["tasks"])) throw new Error("invalid_dagr");
  const tasks = list(doc["tasks"]);
  const size = tasks.reduce<number>((sum, value) => sum + 1 + list(record(value)?.["attempts"]).length + list(record(record(value)?.["policy"])?.["futures"]).length, 0);
  if (size > MAX_ITEMS) throw new Error("dagr_too_large");
  const nodes: AgentGraphNode[] = [], edges: AgentGraphEdge[] = [], ids = new Set<string>();
  const connect = (edge: AgentGraphEdge) => { if (edges.length >= MAX_ITEMS) throw new Error("dagr_too_large"); edges.push(edge); };
  const taskIds = new Set(tasks.map(value => words(record(value)?.["id"])).filter((id): id is string => id !== undefined));
  const add = (node: AgentGraphNode) => { if (ids.has(node.id)) throw new Error("duplicate_dagr_id"); ids.add(node.id); nodes.push(node); };
  for (const value of tasks) {
    const task = record(value), id = words(task?.["id"]), label = words(task?.["title"]);
    if (!task || !id || !label) throw new Error("invalid_dagr_task");
    const attempts = list(task["attempts"]);
    const latest = record(attempts.at(-1)), progress = record(latest?.["progress"]);
    add({ id: `dagr:${id}`, label, kind: task["kind"] === "gate" ? "gate" : "task", state: stateOf(task["state"]),
      ...(words(task["owner"]) ? { actor: words(task["owner"])! } : {}), ...(words(task["note"]) ? { note: words(task["note"])! } : {}),
      ...(words(latest?.["model"]) ? { model: words(latest?.["model"])! } : {}),
      ...(progress && typeof progress["done"] === "number" && typeof progress["total"] === "number" ? { progress: `${progress["done"]}/${progress["total"]}` } : {}),
    });
    const deps = [...new Set([...list(task["deps"]), ...(task["kind"] === "gate" ? list(task["inputs"]) : [])])];
    for (const dep of deps) {
      if (typeof dep !== "string" || !taskIds.has(dep) || dep === id) throw new Error("invalid_dagr_dependency");
      connect({ from: `dagr:${dep}`, to: `dagr:${id}`, kind: "dependency" });
    }
    let previous: string | null = null;
    for (const value of attempts) {
      const attempt = record(value), attemptId = words(attempt?.["id"]);
      if (!attempt || !attemptId) throw new Error("invalid_dagr_attempt");
      const cause = record(attempt["cause"]), outcome = record(attempt["outcome"]), locator = record(attempt["locator"]);
      const nodeId = `attempt:${attemptId}`;
      add({ id: nodeId, label: words(attempt["actor"]) ?? attemptId, kind: "attempt", state: stateOf(attempt["state"]),
        ...(words(attempt["model"]) ? { model: words(attempt["model"])! } : {}),
        ...(words(cause?.["reason"]) ? { note: words(cause?.["reason"])! } : {}),
        ...(words(outcome?.["evidence"]) ? { evidence: words(outcome?.["evidence"])! } : {}),
        ...(words(locator?.["pane"]) ? { paneId: words(locator?.["pane"])! } : {}),
      });
      connect({ from: previous ?? `dagr:${id}`, to: nodeId, kind: previous ? "retry" : "attempt" });
      if (words(cause?.["ref"])) connect({ from: `attempt:${words(cause?.["ref"])!}`, to: nodeId, kind: "retry" });
      previous = nodeId;
    }
    if (task["state"] !== "working" && task["state"] !== "blocked" && task["state"] !== "review") continue;
    for (const value of list(record(task["policy"])?.["futures"])) {
      const future = record(value), node = record(future?.["node"]), ref = words(future?.["ref"]);
      if (!future || (future["on"] !== "pass" && future["on"] !== "fail")) continue;
      let to: string;
      if (ref && taskIds.has(ref)) to = `dagr:${ref}`;
      else {
        const futureId = words(node?.["id"]);
        if (!futureId) continue;
        to = `future:${id}:${futureId}`;
        add({ id: to, label: words(node?.["title"]) ?? futureId, kind: "future", state: "queued", condition: future["on"] as "pass" | "fail", ...(words(node?.["model"]) ? { model: words(node?.["model"])! } : {}) });
      }
      connect({ from: `dagr:${id}`, to, kind: "planned" });
    }
  }
  const presentEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  // A broken partial producer write must not replace the last valid graph with invented layout.
  const dependencyEdges = presentEdges.filter(edge => edge.kind === "dependency");
  if (topological(nodes, dependencyEdges).cyclic) throw new Error("dagr_dependency_cycle");
  return bounded({ title: words(run?.["title"]) ?? words(run?.["id"])!, source: "dagr", nodes, edges: presentEdges, hidden: 0 });
}

function topological(nodes: readonly AgentGraphNode[], edges: readonly AgentGraphEdge[]): { ordered: string[]; depths: Map<string, number>; cyclic: boolean } {
  const indegree = new Map(nodes.map(node => [node.id, 0])), children = new Map<string, string[]>(), depths = new Map<string, number>();
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to) || edge.from === edge.to) continue;
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id), ordered: string[] = [];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    ordered.push(id);
    for (const child of children.get(id) ?? []) {
      depths.set(child, Math.max(depths.get(child) ?? 0, (depths.get(id) ?? 0) + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  return { ordered, depths, cyclic: ordered.length !== nodes.length };
}

/** Deterministic, bounded layout. Planned loop-backs never participate in the topological sort. */
export function layoutAgentGraph(graph: AgentGraph): PositionedAgentNode[] {
  const result = topological(graph.nodes, graph.edges.filter(edge => edge.kind !== "planned" || edge.to.startsWith("future:")));
  const position = new Map(result.ordered.map((id, index) => [id, index]));
  return graph.nodes.map((node, index) => ({ ...node, depth: Math.min(result.depths.get(node.id) ?? 0, 4), row: position.get(node.id) ?? result.ordered.length + index })).sort((a, b) => a.row - b.row).map((node, row) => ({ ...node, row }));
}
