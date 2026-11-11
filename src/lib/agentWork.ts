import type { PaneBackgroundAgentDetail } from "../../shared/protocol.ts";

export type AgentWorkEvent = PaneBackgroundAgentDetail["events"][number];
export type AgentWorkBlock = { kind: "text"; event: AgentWorkEvent } | { kind: "tools"; events: AgentWorkEvent[] };

/** Preserve the agent's narration; fold only consecutive recorded tool calls together. */
export function agentWorkBlocks(events: readonly AgentWorkEvent[]): AgentWorkBlock[] {
  const blocks: AgentWorkBlock[] = [];
  for (const event of events) {
    if (event.kind === "text") { blocks.push({ kind: "text", event }); continue; }
    const last = blocks.at(-1);
    if (last?.kind === "tools") last.events.push(event);
    else blocks.push({ kind: "tools", events: [event] });
  }
  return blocks;
}
