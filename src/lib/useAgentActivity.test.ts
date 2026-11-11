import { describe, expect, test } from "bun:test";
import type { OmoTask } from "../../shared/protocol.ts";
import { ActivityPoll } from "./useAgentActivity.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => queueMicrotask(() => resolve(undefined)));
const task = { id: "a1", title: "Build", status: "running", detail_kind: "claude-subagent" } as OmoTask;

describe("ActivityPoll", () => {
  test("shows the task list before a slow plan answers", async () => {
    const plan = deferred<{ steps: null }>();
    const poll = new ActivityPoll({ tasks: async () => ({ tasks: [task], runs: [], serverTime: null, moreRunning: 0 }), plan: () => plan.promise, conversation: null });
    const stop = poll.subscribe(() => undefined);
    await flush(); await flush();
    expect(poll.value.loading).toBe(false);
    expect(poll.value.tasks).toEqual([task]);
    plan.resolve({ steps: null });
    stop();
  });

  test("a nudge during a read never aborts it", async () => {
    const answers: ReturnType<typeof deferred<{ tasks: OmoTask[]; runs: []; serverTime: null; moreRunning: number }>>[] = [];
    const signals: AbortSignal[] = [];
    const poll = new ActivityPoll({
      tasks: signal => { signals.push(signal); const next = deferred<{ tasks: OmoTask[]; runs: []; serverTime: null; moreRunning: number }>(); answers.push(next); return next.promise; },
      plan: async () => ({ steps: null }), conversation: null,
    });
    const stop = poll.subscribe(() => undefined);
    poll.nudge(); poll.nudge();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    answers[0]!.resolve({ tasks: [task], runs: [], serverTime: null, moreRunning: 0 });
    for (let i = 0; i < 5; i++) await flush();
    expect(poll.value.tasks).toEqual([task]);
    // the nudges asked once more, straight after the read ended
    expect(signals).toHaveLength(2);
    stop();
  });

  test("a failed first read says unavailable, not loading", async () => {
    const poll = new ActivityPoll({ tasks: async () => { throw new Error("offline"); }, plan: async () => ({ steps: null }), conversation: null });
    const stop = poll.subscribe(() => undefined);
    for (let i = 0; i < 5; i++) await flush();
    expect(poll.value.loading).toBe(false);
    expect(poll.value.stale).toBe(true);
    stop();
  });
});

describe("runningSubagents", () => {
  test("keeps running Claude subagents and leaves shells and ended agents out", async () => {
    const { runningSubagents } = await import("../components/AgentStrip.tsx");
    const shell = { ...task, id: "b1", detail_kind: null } as OmoTask;
    const ended = { ...task, id: "a2", status: "completed" } as OmoTask;
    expect(runningSubagents([task, shell, ended])).toEqual([task]);
  });
});
