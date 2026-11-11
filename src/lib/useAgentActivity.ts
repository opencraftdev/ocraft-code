import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConversationTurn, OmoRun, OmoTask, PlanStep } from "../../shared/protocol.ts";
import { clockOffsetMs } from "./omoTasks.ts";
import { dagrGraph, transcriptAgents, type AgentGraph, type AgentGraphNode } from "./agentGraph.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
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
  /** the first read has taken longer than SLOW_MS: a cold read on a remote PC can take ten seconds */
  slow: boolean;
  stale: boolean;
  dagrFailed: boolean;
}
type Polled = Omit<AgentActivity, "dagr" | "dagrFailed">;
const EMPTY: Polled = { tasks: [], runs: [], clockOffset: 0, steps: null, agents: [], moreRunning: 0, loading: true, slow: false, stale: false };

export const POLL_MS = 4000;
export const SLOW_MS = 10_000;
/** A PC's first answer reads its session files cold; later reads are incremental and fast. */
export const FIRST_TIMEOUT_MS = 30_000;
export const TIMEOUT_MS = 10_000;

export interface ActivityFetchers {
  tasks: ((signal: AbortSignal) => Promise<{ tasks: OmoTask[]; runs: OmoRun[]; serverTime: string | null; moreRunning: number }>) | null;
  plan: (signal: AbortSignal) => Promise<{ steps: PlanStep[] | null }>;
  conversation: (() => Promise<{ history_id?: string | null; turns: ConversationTurn[] } | null>) | null;
}

/**
 * One poll per (PC, pane, agent), shared by every reader (the agent panel, the composer's agent
 * strip). Each answer is applied as it arrives, so a slow plan never holds back the task list. A
 * nudge (a changed count, Refresh) never aborts the read in flight: it only starts the next one
 * as soon as that read ends.
 */
export class ActivityPoll {
  value: Polled = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private slowTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  private reading = false;
  private again = false;
  private answered = false;
  private history: string | null = null;
  constructor(private readonly fetchers: ActivityFetchers, private readonly now = Date.now) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => { this.listeners.delete(listener); if (this.listeners.size === 0) this.stop(); };
  }

  nudge(): void {
    if (this.listeners.size === 0) return;
    if (this.reading) { this.again = true; return; }
    clearTimeout(this.timer);
    void this.read();
  }

  private set(patch: Partial<Polled>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    if (!this.answered) this.slowTimer = setTimeout(() => { if (!this.answered) this.set({ slow: true }); }, SLOW_MS);
    void this.read();
  }

  private stop(): void {
    clearTimeout(this.timer); clearTimeout(this.slowTimer);
    this.controller?.abort(); this.controller = null;
    this.reading = false; this.again = false;
  }

  private async read(): Promise<void> {
    const request = new AbortController();
    this.controller = request;
    this.reading = true;
    const timeout = setTimeout(() => request.abort(), this.answered ? TIMEOUT_MS : FIRST_TIMEOUT_MS);
    const live = () => this.controller === request;
    const settle = () => { if (!this.answered) { this.answered = true; clearTimeout(this.slowTimer); } };
    const tasks = this.fetchers.tasks?.(request.signal).then(answer => {
      if (!live()) return;
      settle();
      this.set({ tasks: answer.tasks, runs: answer.runs, moreRunning: answer.moreRunning, clockOffset: clockOffsetMs(answer.serverTime, this.now()), loading: false, slow: false });
    });
    const plan = this.fetchers.plan(request.signal).then(answer => { if (live()) this.set({ steps: answer.steps }); });
    const conversation = this.fetchers.conversation?.().then(answer => {
      if (!live()) return;
      settle();
      const identity = answer?.history_id ?? this.history;
      const changed = this.history !== null && this.history !== identity;
      this.history = identity;
      this.set({ agents: transcriptAgents(answer?.turns ?? [], changed ? [] : this.value.agents), loading: false, slow: false });
    });
    const results = await Promise.allSettled([tasks, plan, conversation]);
    clearTimeout(timeout);
    if (!live()) return;
    const failed = results.some(result => result.status === "rejected");
    // nothing that lists agents is asked of this pane: the plan alone ends the loading
    if (!this.fetchers.tasks && !this.fetchers.conversation) settle();
    // a first read that failed stops reading as loading: the reader says it is unavailable instead
    if (failed) clearTimeout(this.slowTimer);
    this.set({ stale: failed, loading: !this.answered && !failed, slow: this.answered || failed ? false : this.value.slow });
    this.reading = false;
    if (this.again) { this.again = false; void this.read(); }
    else this.timer = setTimeout(() => void this.read(), POLL_MS);
  }
}

const polls = new Map<string, { poll: ActivityPoll; users: number }>();
const TASK_AGENTS = ["claude", "opencode", "omo"];

/** The shared poll of one pane: made on first use (the readers of one render must find the same one), dropped with its last reader. */
function usePoll(paneId: string, agent: string | null): ActivityPoll {
  const api = useMachineApi();
  const machineId = useMachineId();
  const key = JSON.stringify([machineId, paneId, agent]);
  let held = polls.get(key);
  if (!held) {
    held = { users: 0, poll: new ActivityPoll({
      tasks: TASK_AGENTS.includes(agent ?? "") ? signal => api.fetchPaneOmoActivity(paneId, signal) : null,
      plan: signal => api.fetchPanePlan(paneId, signal),
      conversation: agent === "codex" ? () => api.fetchPaneConversation(paneId) : null,
    }) };
    polls.set(key, held);
  }
  const poll = held.poll;
  useEffect(() => {
    const entry = polls.get(key) ?? { poll, users: 0 };
    entry.users += 1;
    polls.set(key, entry);
    return () => { entry.users -= 1; if (entry.users === 0 && polls.get(key) === entry) polls.delete(key); };
  }, [key, poll]);
  return poll;
}

/** The pane's tasks, plan and agents, polled while the page is visible and its PC online. */
export function useAgentActivity(paneId: string, agent: string | null, graphShown: boolean, watching: boolean, online: boolean, refresh: number, runningCount: number): AgentActivity {
  const api = useMachineApi();
  const visible = usePageVisible();
  const poll = usePoll(paneId, agent);
  // stable while the pane stays readable: a new subscribe each render would stop and restart the poll
  const subscribe = useCallback((listener: () => void) => visible && online ? poll.subscribe(listener) : () => undefined, [poll, visible, online]);
  const value = useSyncExternalStore(subscribe, () => poll.value);
  // a new count or an explicit Refresh asks again once the read in flight ends
  useEffect(() => { poll.nudge(); }, [poll, refresh, runningCount]);
  const [graph, setGraph] = useState<{ dagr: AgentGraph | null; failed: boolean }>({ dagr: null, failed: false });
  useEffect(() => {
    if (!graphShown || watching || !visible || !online) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), TIMEOUT_MS);
      try {
        const doc = await api.fetchPaneDagr(paneId, request.signal);
        if (alive) setGraph({ dagr: doc === null ? null : dagrGraph(doc), failed: false });
      } catch {
        if (alive) setGraph(before => ({ ...before, failed: true }));
      } finally {
        clearTimeout(timeout);
        if (alive) timer = setTimeout(() => void read(), POLL_MS);
      }
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, paneId, graphShown, watching, visible, online, refresh]);
  return { ...value, dagr: graph.dagr, dagrFailed: graph.failed, stale: value.stale || !online };
}
