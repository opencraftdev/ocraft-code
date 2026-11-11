import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationForkResponse } from "../../shared/protocol.ts";
import { ApiError, forkConversation } from "./api.ts";
import { useMachineId } from "./machineContext.tsx";

/** One click creates one branch. A late reply never navigates a different pane or computer. */
export function useConversationFork(paneId: string, active: boolean, onCreated?: (result: ConversationForkResponse) => void, historyId?: string) {
  const machineId = useMachineId();
  const owner = useRef({ key: `${machineId}:${paneId}:${historyId ?? ""}` });
  const key = `${machineId}:${paneId}:${historyId ?? ""}`;
  if (owner.current.key !== key) owner.current = { key };
  const callback = useRef(onCreated); callback.current = onCreated;
  const visible = useRef(active); visible.current = active;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = useRef<object | null>(null);
  const settled = useRef<Promise<void> | null>(null);
  const retry = useRef<{ point: string; id: string } | null>(null);
  const [working, setWorking] = useState<object | null>(null);
  const run = useCallback(async (ref: string): Promise<void> => {
    const mine = owner.current;
    if (pending.current === mine) { await settled.current; return; }
    pending.current = mine; setWorking(mine);
    const id = retry.current?.point === ref ? retry.current.id : crypto.randomUUID();
    retry.current = { point: ref, id };
    try {
      const request = forkConversation({ pane_id: paneId, fork_ref: ref, request_id: id }, machineId);
      settled.current = request.then(() => undefined, () => undefined);
      const result = await request;
      retry.current = null;
      if (mounted.current && owner.current === mine && visible.current) callback.current?.(result);
    } catch (error) {
      // An answered refusal can be retried as a new intent. An uncertain network reply reuses its ID.
      if (error instanceof ApiError) retry.current = null;
      throw error;
    } finally {
      if (pending.current === mine) pending.current = null;
      if (mounted.current && owner.current === mine) setWorking(null);
    }
  }, [paneId, machineId, historyId]);
  const busy = working === owner.current;
  return useMemo(() => ({ run, busy }), [run, busy]);
}
