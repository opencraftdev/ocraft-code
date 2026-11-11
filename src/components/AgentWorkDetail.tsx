import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentGraphNode } from "../lib/agentGraph.ts";
import type { BackgroundTaskReceipt } from "../lib/backgroundTaskReceipts.ts";
import { agentWorkBlocks } from "../lib/agentWork.ts";
import { useAgentWork } from "../lib/useAgentWork.ts";
import { useT } from "../lib/i18n.ts";
import { formatTokens } from "../lib/compose.ts";
import { taskElapsedMs, formatElapsed } from "../lib/omoTasks.ts";
import { graphStateWord } from "./AgentGraphView.tsx";
import { Markdown } from "./Markdown.tsx";

/** A reading view: dispatch, model, narration and folded tool calls, following the supplied reference. */
export function AgentWorkDetail({ paneId, node, receipt, online, watching, refresh, now }: {
  paneId: string; node: AgentGraphNode; receipt?: BackgroundTaskReceipt; online: boolean; watching: boolean; refresh: number; now: number;
}) {
  const t = useT();
  const { detail, loading, failed } = useAgentWork(paneId, node, online, watching, refresh);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const prompt = detail?.prompt ?? node.note;
  const promptPreview = prompt?.split("\n").slice(0, 9).join("\n").slice(0, 500).trimEnd();
  const hasMorePrompt = !!prompt && promptPreview !== prompt;
  const blocks = useMemo(() => agentWorkBlocks(detail?.events ?? []), [detail?.events]);
  const model = node.model ?? node.task?.model;
  const elapsed = node.task ? taskElapsedMs(node.task, now) : null;
  return <article className="agent-work-detail" aria-label={t("Agent details")} aria-busy={loading}>
    {prompt && <section className="agent-work-prompt" aria-label={t("Dispatch prompt")}>
      <Markdown>{promptExpanded || !hasMorePrompt ? prompt : `${promptPreview}…`}</Markdown>
      {hasMorePrompt && <button type="button" className="agent-work-show-more" aria-expanded={promptExpanded} onClick={() => setPromptExpanded(value => !value)}>{t(promptExpanded ? "Show less" : "Show more")}</button>}
    </section>}
    <p className="agent-work-meta">{model && <span>{t("Model: {model}", { model })}</span>}<span className={`state-${node.state}`}>{graphStateWord(node.state, t)}{elapsed !== null && ` · ${formatElapsed(elapsed)}`}</span></p>
    {loading && !detail && <p className="agent-panel-note" role="status">{t("Reading agent activity…")}</p>}
    {failed && <p className="agent-panel-note" role="status">{t("Agent details are unavailable. Refresh to try again.")}</p>}
    {detail?.truncated && <p className="agent-panel-note">{t("Showing the most recent recorded activity.")}</p>}
    {detail?.incomplete && <p className="agent-panel-note">{t("Some records couldn't be read and are left out")}</p>}
    <ol className="agent-work-timeline">{blocks.map((block, index) => <li key={index}>
      {block.kind === "text" ? <Markdown>{block.event.text}</Markdown> : <details className="agent-work-tools"><summary>{t(block.events.length === 1 ? "{n} tool call" : "{n} tool calls", { n: block.events.length })}<ChevronRight aria-hidden="true" /></summary>
        <ol>{block.events.map((event, position) => <li key={position}><pre>{event.text}</pre></li>)}</ol>
      </details>}
    </li>)}</ol>
    {blocks.length === 0 && receipt?.output && <section className="agent-work-result" aria-label={t("Reported output")}><Markdown>{receipt.output}</Markdown>{receipt.truncated && <p className="agent-panel-note">{t("Some task details are truncated.")}</p>}</section>}
    {node.evidence && <p className="agent-panel-note">{t("Evidence")}: {node.evidence}</p>}
    {!loading && !failed && blocks.length === 0 && !receipt?.output && !node.evidence && <p className="agent-panel-note">{t("Activity has not been reported for this agent.")}</p>}
    {node.task && (node.task.tool_calls !== null || node.task.tokens !== null) && <details className="agent-work-metrics"><summary>{t("Usage details")}<ChevronRight aria-hidden="true" /></summary><dl className="agent-task-metrics">
      {node.task.tool_calls !== null && <div><dt>{t("Tool calls")}</dt><dd>{node.task.tool_calls}</dd></div>}
      {node.task.tokens !== null && <div><dt>{t("Tokens")}</dt><dd>{formatTokens(node.task.tokens)}</dd></div>}
    </dl></details>}
  </article>;
}
