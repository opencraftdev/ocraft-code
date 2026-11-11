import { useEffect, useRef, useState } from "react";
import type { OmoRun, OmoTask, PlanStep } from "../../shared/protocol.ts";
import { clockOffsetMs } from "./omoTasks.ts";
import { dagrGraph, transcriptAgents, type AgentGraph, type AgentGraphNode } from "./agentGraph.ts";
import { useMachineApi } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";

export interface AgentActivity {
  tasks: OmoTask[];
  runs: OmoRun[];
  clockOffset: number;
  steps: PlanStep[] | null;
  agents: AgentGraphNode[];
  dagr: AgentGraph | null;
  moreRunning: number;
  loading: boolean;
  stale: boolean;
  dagrFailed: boolean;
}
const EMPTY: AgentActivity = { tasks: [], runs: [], clockOffset: 0, steps: null, agents: [], dagr: null, moreRunning: 0, loading: true, stale: false, dagrFailed: false };

/** One sequential poll while visible. A panel is keyed by machine and pane session in App. */
export function useAgentActivity(paneId: string, agent: string | null, graphShown: boolean, watching: boolean, online: boolean, refresh: number, runningCount: number): AgentActivity {
  const api = useMachineApi();
  const visible = usePageVisible();
  const [value, setValue] = useState<AgentActivity>(EMPTY);
  const history = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !online) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const read = async () => {
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 10000);
      try {
        const [tasks, plan, conversation, workflow] = await Promise.allSettled([
          (["claude", "opencode", "omo"].includes(agent ?? "") ? api.fetchPaneOmoActivity(paneId, request.signal) : Promise.resolve({ tasks: [], runs: [], moreRunning: 0, serverTime: null })).then(value => ({ ...value, receivedAt: Date.now() })),
          api.fetchPanePlan(paneId, request.signal),
          agent === "codex" ? api.fetchPaneConversation(paneId) : Promise.resolve(null),
          graphShown && !watching ? api.fetchPaneDagr(paneId, request.signal).then(doc => doc === null ? null : dagrGraph(doc)) : Promise.resolve(null),
        ]);
        if (!alive) return;
        const identity = conversation.status === "fulfilled" ? conversation.value?.history_id ?? null : history.current;
        const changed = history.current !== null && history.current !== identity;
        history.current = identity;
        setValue(previous => ({
          tasks: tasks.status === "fulfilled" ? tasks.value.tasks : previous.tasks,
          runs: tasks.status === "fulfilled" ? tasks.value.runs : previous.runs,
          clockOffset: tasks.status === "fulfilled" ? clockOffsetMs(tasks.value.serverTime, tasks.value.receivedAt) : previous.clockOffset,
          steps: plan.status === "fulfilled" ? plan.value.steps : previous.steps,
          agents: conversation.status === "fulfilled" ? transcriptAgents(conversation.value?.turns ?? [], changed ? [] : previous.agents) : previous.agents,
          dagr: !graphShown ? previous.dagr : workflow.status === "fulfilled" ? workflow.value : previous.dagr,
          moreRunning: tasks.status === "fulfilled" ? tasks.value.moreRunning : previous.moreRunning,
          loading: false,
          stale: tasks.status === "rejected" || plan.status === "rejected" || conversation.status === "rejected",
          dagrFailed: workflow.status === "rejected",
        }));
      } finally {
        clearTimeout(timeout);
        if (alive) timer = setTimeout(() => void read(), 4000);
      }
    };
    void read();
    return () => { alive = false; clearTimeout(timer); controller?.abort(); };
  }, [api, visible, online, paneId, agent, graphShown, watching, refresh, runningCount]);
  return online ? value : { ...value, stale: true };
}
