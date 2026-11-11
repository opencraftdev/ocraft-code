import { useEffect, useState } from "react";
import type { RepoDiffFileList } from "../../shared/protocol.ts";
import { useMachineApi } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";

/** Read git's real working-tree changes on entry, a completed turn, and explicit Refresh. */
export function useRepoChangesSummary(paneId: string, directory: string, online: boolean, finish: number | undefined) {
  const { fetchRepoDiffFiles } = useMachineApi();
  const visible = usePageVisible();
  const [refresh, setRefresh] = useState(0);
  const target = JSON.stringify([paneId, directory]);
  const [answer, setAnswer] = useState<{ target: string; listing: RepoDiffFileList | null; error: unknown; loading: boolean } | null>(null);
  useEffect(() => {
    if (!online || !visible) return;
    let alive = true;
    setAnswer(before => ({ target, listing: before?.target === target ? before.listing : null, error: null, loading: true }));
    fetchRepoDiffFiles({ paneId, directory, scope: "workspace", base: null, head: null, comparison: null }).then(
      listing => { if (alive) setAnswer({ target, listing, error: null, loading: false }); },
      error => { if (alive) setAnswer(before => ({ target, listing: before?.target === target ? before.listing : null, error, loading: false })); },
    );
    return () => { alive = false; };
  }, [fetchRepoDiffFiles, paneId, directory, target, online, visible, finish, refresh]);
  return { listing: answer?.target === target ? answer.listing : null, error: answer?.target === target ? answer.error : null,
    loading: online && (answer?.target !== target || answer.loading), refresh: () => setRefresh(value => value + 1) };
}
