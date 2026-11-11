import { GitFork } from "lucide-react";
import type { OmoTask } from "../../shared/protocol.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";
import { useActivityClock } from "../lib/useActivityClock.ts";
import { useAgentActivity } from "../lib/useAgentActivity.ts";
import "./AgentStrip.css";

const SHOWN = 3;

/** The running subagents of a Claude Code session, as its footer lists them: shells stay in the background-task chip. */
export function runningSubagents(tasks: readonly OmoTask[]): OmoTask[] {
  return tasks.filter(task => task.status === "running" && task.detail_kind === "claude-subagent");
}

/**
 * A Claude pane's running subagents over the composer, so one can keep chatting while they work
 * and see what runs. It shares the agent panel's poll (useAgentActivity); a row opens the agent in
 * the panel's drawer (the selected pane only). An agent that stops leaves the strip: its ended card
 * is in the transcript.
 */
export function AgentStrip({ paneId, agent, online, count, onOpen }: { paneId: string; agent: string; online: boolean; count: number; onOpen?: (taskId: string | null) => void }) {
  const t = useT();
  const activity = useAgentActivity(paneId, agent, false, false, online, 0, count);
  const running = runningSubagents(activity.tasks);
  const now = useActivityClock(running.length > 0, activity.clockOffset);
  if (running.length === 0) return null;
  const extra = running.length - SHOWN;
  return <section className="agent-strip" aria-label={t("Running agents")}>
    <ul>
      {running.slice(0, extra > 0 ? SHOWN - 1 : SHOWN).map(task => {
        const elapsed = taskElapsedMs(task, now);
        return <li key={task.id}>
          <button type="button" className="agent-strip-row" disabled={!onOpen} onClick={() => onOpen?.(task.id)} title={task.title}>
            <span className="agent-strip-dot" aria-hidden="true" />
            <span className="agent-strip-title">{task.title}</span>
            {task.category && <span className="agent-strip-meta">{task.category}</span>}
            {elapsed !== null && <span className="agent-strip-meta agent-strip-num">{formatElapsed(elapsed)}</span>}
            {task.tokens !== null && <span className="agent-strip-meta agent-strip-num">↓ {formatTokens(task.tokens)}</span>}
          </button>
        </li>;
      })}
      {extra > 0 && <li><button type="button" className="agent-strip-row agent-strip-more" disabled={!onOpen} onClick={() => onOpen?.(null)}>
        <GitFork aria-hidden="true" /><span className="agent-strip-title">{t("+{n} more", { n: extra + 1 })}</span>
      </button></li>}
    </ul>
  </section>;
}
