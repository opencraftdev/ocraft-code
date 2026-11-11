import { useEffect, useState } from "react";
import type { PanePullRequest } from "../../shared/protocol.ts";
import { lookupPrs } from "./api.ts";
import { useMachineApi } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";

const POLL_MS = 60_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * The session's pull requests with their CI, read on entry, after each turn, on Refresh and every minute
 * while shown. A PC whose bridge has no PR route has them found from this one: by the commit its branch
 * is on and the PR links its conversation holds (server/pane-prs.ts lookup).
 */
export function usePanePrs(paneId: string, directory: string, online: boolean, finish: number | undefined, refresh: number): PanePullRequest[] {
  const { fetchPanePrs, fetchRepoDiffFiles, fetchPaneConversation } = useMachineApi();
  const visible = usePageVisible();
  const [prs, setPrs] = useState<{ paneId: string; list: PanePullRequest[] }>({ paneId, list: [] });
  useEffect(() => {
    if (!online || !visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const request = new AbortController();
      try {
        let list = await fetchPanePrs(paneId, request.signal);
        if (list === null) {
          const [files, conversation] = await Promise.allSettled([
            directory ? fetchRepoDiffFiles({ paneId, directory, scope: "workspace", base: null, head: null, comparison: null }) : Promise.reject(new Error("no folder")),
            fetchPaneConversation(paneId),
          ]);
          const sha = files.status === "fulfilled" ? files.value.repository.head : null;
          const texts = conversation.status === "fulfilled" ? conversation.value.turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : [])) : [];
          const urls = [...new Set(texts.reverse().flatMap((text) => [...text.matchAll(PR_URL)].map((match) => match[0])))].slice(0, 6);
          list = sha || urls.length > 0 ? await lookupPrs(sha, urls, request.signal) : [];
        }
        if (alive) setPrs({ paneId, list });
      } catch { /* the last list stays until the next read */ }
      if (alive) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [fetchPanePrs, fetchRepoDiffFiles, fetchPaneConversation, paneId, directory, online, visible, finish, refresh]);
  return prs.paneId === paneId ? prs.list : [];
}
