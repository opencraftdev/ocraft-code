import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, CircleX, Clock, Terminal, Workflow } from "lucide-react";
import type { OmoRun, OmoRunNode } from "../../shared/protocol.ts";
import type { AgentGraphNode } from "../lib/agentGraph.ts";
import { graphStateWord } from "./AgentGraphView.tsx";
import type { BackgroundTaskReceipt } from "../lib/backgroundTaskReceipts.ts";
import { formatElapsed, runGoing, spanMs, taskElapsedMs } from "../lib/omoTasks.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";

function TaskCard({ node, receipt, selected, now }: { node: AgentGraphNode; receipt?: BackgroundTaskReceipt; selected: boolean; now: number }) {
  const t = useT();
  const [open, setOpen] = useState(selected);
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (selected) { setOpen(true); root.current?.scrollIntoView({ block: "nearest" }); } }, [selected]);
  const task = node.task;
  const elapsed = task ? taskElapsedMs(task, now) : null;
  const failed = node.state === "failed";
  const hasContent = !!(receipt?.command || receipt?.output);
  const Icon = failed ? CircleX : node.state === "done" ? CircleCheck : Terminal;
  return <details ref={root} className={`background-job-card state-${node.state}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronDown aria-hidden="true" /><span className="background-job-title">{node.label}</span><span className="background-job-time">{failed ? t("failed") : elapsed === null ? graphStateWord(node.state, t) : formatElapsed(elapsed)}</span><Icon className="background-job-status" aria-label={graphStateWord(node.state, t)} /></summary>
    <div className="background-job-body">
      {receipt?.command && <pre className="background-job-command"><code>{`$ ${receipt.command}`}</code></pre>}
      {receipt?.output && <><h3>{t("Reported output")}</h3><pre className="background-job-output"><code>{receipt.output}</code></pre></>}
      {receipt?.truncated && <p className="agent-panel-note">{t("Some task details are truncated.")}</p>}
      {!receipt?.command && !receipt?.output && <p className="agent-panel-note">{t("Command and output have not been reported for this task.")}</p>}
      {task && (!hasContent || task.tool_calls !== null || task.tokens !== null) && <dl className="agent-task-metrics">
        {!hasContent && <div><dt>{t("Status")}</dt><dd>{graphStateWord(node.state, t)}</dd></div>}
        {!hasContent && task.started_at && Number.isFinite(Date.parse(task.started_at)) && <div><dt>{t("Started")}</dt><dd><time dateTime={task.started_at}>{new Date(task.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></dd></div>}
        {!hasContent && elapsed !== null && <div><dt>{t("Elapsed")}</dt><dd>{formatElapsed(elapsed)}</dd></div>}
        {task.tool_calls !== null && <div><dt>{t("Tool calls")}</dt><dd>{task.tool_calls}</dd></div>}
        {task.tokens !== null && <div><dt>{t("Tokens")}</dt><dd>{formatTokens(task.tokens)}</dd></div>}
      </dl>}
    </div>
  </details>;
}

function WorkflowCard({ run, now }: { run: OmoRun; now: number }) {
  const t = useT();
  const nodes = run.waves.flat();
  const done = nodes.filter(node => node.state === "completed").length;
  const elapsed = spanMs(run.started_at, run.ended_at, runGoing(run), now);
  const words: Record<OmoRunNode["state"], string> = { pending: t("waiting"), scheduled: t("waiting"), running: t("running"), blocked: t("blocked"), completed: t("done"), failed: t("failed"), skipped: t("skipped"), cancelled: t("cancelled") };
  return <section className={`background-workflow-card is-${run.status}`} aria-label={run.name}>
    <header><Workflow aria-hidden="true" /><span><strong>{run.name}</strong><small>{t("{done} of {total} done", { done, total: nodes.length })}{["pending", "paused", "cancelled", "failed"].includes(run.status) && ` · ${run.status === "paused" ? t("paused") : run.status === "pending" ? t("waiting") : run.status === "failed" ? t("failed") : t("cancelled")}`}</small></span><span className="background-job-time">{elapsed === null ? null : formatElapsed(elapsed)}</span></header>
    {run.waves.map((wave, index) => <details key={index} className="background-workflow-wave"><summary><ChevronDown aria-hidden="true" /><span>{wave.length === 1 ? wave[0]!.label : t("Stage {n}", { n: index + 1 })}</span><span className="background-job-time">{wave.filter(node => node.state === "completed").length}/{wave.length}</span></summary><ul>{wave.map(node => <li key={node.id} className={`is-${node.state}`}><span>{node.label}</span><small>{words[node.state]}</small>{node.error && <pre>{node.error}</pre>}</li>)}</ul></details>)}
  </section>;
}

export function BackgroundTaskCards({ running, ended, runs, receipts, selectedId, showEnded, onShowEnded, now, loading, moreRunning }: {
  running: AgentGraphNode[]; ended: AgentGraphNode[]; runs: OmoRun[]; receipts: ReadonlyMap<string, BackgroundTaskReceipt>; selectedId: string | null;
  showEnded: boolean; onShowEnded: (open: boolean) => void; now: number; loading: boolean; moreRunning: number;
}) {
  const t = useT();
  const activeRuns = runs.filter(runGoing), endedRuns = runs.filter(run => !runGoing(run));
  const runningCount = running.length + activeRuns.length, endedCount = ended.length + endedRuns.length;
  const card = (node: AgentGraphNode) => <li key={node.id}><TaskCard node={node} receipt={node.task ? receipts.get(node.task.id) : undefined} selected={node.id === selectedId} now={now} /></li>;
  return <div className="background-task-cards">
    <h2 className="background-task-group-heading">{t("Running")} <span>{runningCount}</span><Clock aria-hidden="true" /></h2>
    {runningCount === 0 && <p className="agent-panel-note">{t(loading ? "Loading agent activity" : "No background tasks reported.")}</p>}
    <ul className="background-job-list">{running.map(card)}{activeRuns.map(run => <li key={`run:${run.id}`}><WorkflowCard run={run} now={now} /></li>)}</ul>
    {moreRunning > 0 && <p className="agent-panel-note">{t("{count} more background tasks are not listed", { count: moreRunning })}</p>}
    {endedCount > 0 && <details className="background-finished-group" open={showEnded || ended.some(node => node.id === selectedId)} onToggle={event => onShowEnded(event.currentTarget.open)}>
      <summary><ChevronDown aria-hidden="true" />{t("Finished")} <span>{endedCount}</span></summary>
      <ul className="background-job-list">{ended.map(card)}{endedRuns.map(run => <li key={`run:${run.id}`}><WorkflowCard run={run} now={now} /></li>)}</ul>
    </details>}
  </div>;
}
