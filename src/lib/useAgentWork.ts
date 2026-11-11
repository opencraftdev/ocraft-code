import { useEffect, useRef, useState } from "react";
import type { PaneBackgroundAgentDetail } from "../../shared/protocol.ts";
import type { AgentGraphNode } from "./agentGraph.ts";
import { ApiError } from "./api.ts";
import { useMachineApi } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";

/** Running and finished Claude subagents use the same bounded, session-checked read API. */
export function useAgentWork(paneId: string, node: AgentGraphNode, online: boolean, watching: boolean, refresh: number) {
  const { fetchPaneBackgroundAgent } = useMachineApi();
  const visible = usePageVisible();
  const [detail, setDetail] = useState<PaneBackgroundAgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const session = useRef<string | null>(null);
  const supported = !watching && node.task?.detail_kind === "claude-subagent";
  const running = node.task?.status === "running";
  useEffect(() => {
    if (!supported || !visible || !online || !node.task) { setLoading(false); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setLoading(true);
      let retry = running;
      try {
        const next = await fetchPaneBackgroundAgent(paneId, node.task!.id);
        if (!alive) return;
        if (session.current !== null && session.current !== next.session_id) { setDetail(null); setFailed(true); retry = false; return; }
        session.current = next.session_id;
        setDetail(next); setFailed(false);
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && [403, 404, 409, 501].includes(error.status)) { setDetail(null); retry = false; }
        setFailed(true);
      } finally {
        if (alive) {
          setLoading(false);
          if (retry) timer = setTimeout(() => void read(), 4000);
        }
      }
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [paneId, node.task?.id, supported, running, online, visible, refresh, fetchPaneBackgroundAgent]);
  return { detail, loading, failed };
}
