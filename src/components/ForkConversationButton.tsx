import { useId, useState } from "react";
import { GitFork, LoaderCircle } from "lucide-react";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";

export interface ConversationForkAction { run: (ref: string) => Promise<void>; busy: boolean }
export function ForkConversationButton({ point, action, live = false }: { point?: string; action: ConversationForkAction; live?: boolean }) {
  const t = useT();
  const id = useId();
  const [attempting, setAttempting] = useState(false);
  const [error, setError] = useState<"changed" | "failed" | null>(null);
  const label = t(action.busy ? "Forking conversation…" : live ? "Wait for this response to finish before forking" : !point ? "Forking is unavailable for this message" : "Fork conversation from here");
  return <span className="chat-fork-control"><button type="button" className="icon-button chat-copy chat-fork" aria-label={label} title={label} aria-busy={attempting} aria-describedby={error ? id : undefined} disabled={!point || live || action.busy} onClick={async () => {
    if (!point) return;
    setError(null); setAttempting(true);
    try { await action.run(point); } catch (reason) { setError(reason instanceof ApiError && reason.status === 409 ? "changed" : "failed"); } finally { setAttempting(false); }
  }}>{attempting ? <LoaderCircle className="chat-fork-spinner" aria-hidden="true" /> : <GitFork aria-hidden="true" />}</button>
    {error && <span id={id} role="alert" className="chat-fork-error">{t(error === "changed" ? "This conversation changed. Refresh and try again." : "Couldn't fork this message. Try again.")}</span>}
  </span>;
}
