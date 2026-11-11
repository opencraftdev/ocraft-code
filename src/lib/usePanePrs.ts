import { useEffect, useState } from "react";
import type { PanePullRequest } from "../../shared/protocol.ts";
import { useMachineApi } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";

const POLL_MS = 60_000;

/** The session's pull requests with their CI, read on entry, after each turn, on Refresh and every minute while shown. */
export function usePanePrs(paneId: string, online: boolean, finish: number | undefined, refresh: number): PanePullRequest[] {
  const { fetchPanePrs } = useMachineApi();
  const visible = usePageVisible();
  const [prs, setPrs] = useState<{ paneId: string; list: PanePullRequest[] }>({ paneId, list: [] });
  useEffect(() => {
    if (!online || !visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const request = new AbortController();
      try {
        const list = await fetchPanePrs(paneId, request.signal);
        if (alive) setPrs({ paneId, list });
      } catch { /* the last list stays until the next read */ }
      if (alive) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [fetchPanePrs, paneId, online, visible, finish, refresh]);
  return prs.paneId === paneId ? prs.list : [];
}
