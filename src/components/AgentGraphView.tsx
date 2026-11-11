import { useMemo, type CSSProperties } from "react";
import { Bot, Circle, CircleCheck, CircleX, GitMerge, RotateCcw } from "lucide-react";
import { layoutAgentGraph, type AgentGraph, type AgentGraphNode, type GraphState } from "../lib/agentGraph.ts";
import { useT } from "../lib/i18n.ts";

export function graphStateWord(state: GraphState, t: ReturnType<typeof useT>): string {
  switch (state) {
    case "working": return t("running");
    case "done": return t("done");
    case "failed": return t("failed");
    case "blocked": return t("blocked");
    case "queued": return t("waiting");
    case "cancelled": return t("cancelled");
    case "review": return t("In review");
    case "idle": return t("Ready");
    default: return t("Status not recorded");
  }
}

/** A scrollable, keyboard-operable graph. The SVG is decoration; every fact is in a real button. */
export function AgentGraphView({ graph, selected, onSelect }: { graph: AgentGraph; selected: string | null; onSelect: (node: AgentGraphNode) => void }) {
  const t = useT();
  const nodes = useMemo(() => layoutAgentGraph(graph), [graph]);
  const positions = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const activeEdges = useMemo(() => new Set(graph.edges.filter(edge => edge.from === selected || edge.to === selected).map(edge => `${edge.from}:${edge.to}`)), [graph, selected]);
  return <div className="agent-graph-scroll" tabIndex={0} role="region" aria-label={t("Agent graph")}>
    <div className="agent-graph" style={{ height: `${nodes.length * 76 + 12}px` }}>
      <svg className="agent-graph-lines" width="100%" height="100%" aria-hidden="true">
        {graph.edges.map((edge, index) => {
          const from = positions.get(edge.from), to = positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = 24 + from.depth * 12, y1 = from.row * 76 + 35;
          const x2 = 24 + to.depth * 12, y2 = to.row * 76 + 35;
          const back = y2 <= y1 || edge.kind === "planned";
          const rail = back ? 6 + index % 3 * 5 : Math.max(10, Math.min(x1, x2) - 9);
          const d = `M ${x1} ${y1} C ${rail} ${y1}, ${rail} ${y2}, ${x2} ${y2}`;
          return <path key={`${edge.from}:${edge.to}:${index}`} d={d} className={`is-${edge.kind} state-${to.state}${activeEdges.has(`${edge.from}:${edge.to}`) ? " is-highlighted" : ""}`} />;
        })}
      </svg>
      <ol className="agent-graph-nodes" aria-label={t("Workflow nodes")}>
        {nodes.map(node => {
          const Icon = node.kind === "gate" ? GitMerge : node.kind === "attempt" ? RotateCcw : node.state === "done" ? CircleCheck : node.state === "failed" ? CircleX : node.kind === "agent" ? Bot : Circle;
          const dependencies = graph.edges.filter(edge => edge.to === node.id && edge.kind === "dependency").map(edge => positions.get(edge.from)?.label).filter(Boolean);
          return <li key={node.id} style={{ "--node-depth": node.depth, top: `${node.row * 76 + 5}px` } as CSSProperties}>
            <button type="button" className={`agent-graph-node state-${node.state}${node.kind === "future" ? " is-planned" : ""}`} aria-pressed={selected === node.id} onClick={() => onSelect(node)}
              title={[node.label, graphStateWord(node.state, t), dependencies.length ? `${t("Depends on")}: ${dependencies.join(", ")}` : null].filter(Boolean).join(" · ")}>
              <span className="agent-graph-dot" aria-hidden="true" />
              <span className="agent-graph-node-head"><Icon aria-hidden="true" /><strong>{node.label}</strong>{node.progress && <span>{node.progress}</span>}</span>
              <span className="agent-graph-node-meta"><span className="agent-state-word">{node.condition ? t(node.condition === "pass" ? "If passed" : "If failed") : graphStateWord(node.state, t)}</span>{node.model && <span>{node.model}</span>}</span>
            </button>
          </li>;
        })}
      </ol>
    </div>
  </div>;
}
