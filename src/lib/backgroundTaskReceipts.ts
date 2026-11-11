import { useSyncExternalStore } from "react";
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";

export interface BackgroundTaskReceipt { command?: string; output?: string; truncated?: boolean }
const EMPTY: ReadonlyMap<string, BackgroundTaskReceipt> = new Map();

/** Exact runtime receipts only. Agent prose and arbitrary IDs inside output are never jobs. */
export function taskReceipts(turns: readonly ConversationTurn[]): Map<string, BackgroundTaskReceipt> {
  const receipts = new Map<string, BackgroundTaskReceipt>();
  const add = (id: string, receipt: BackgroundTaskReceipt) => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return;
    receipts.set(id, { ...receipts.get(id), ...receipt });
  };
  for (const turn of turns.slice(-200)) for (const part of turn.parts) {
    if (part.kind === "task_result") for (const task of part.tasks) {
      if (task.result) add(task.id, { output: task.result.slice(0, 16000), truncated: task.result_cut || task.result.length > 16000 });
    }
    if (part.kind !== "tool") continue;
    if (!["Bash", "bash", "TaskOutput"].includes(part.name)) continue;
    let input: Record<string, unknown>;
    try { input = JSON.parse(part.input); } catch { continue; }
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    if (part.name === "TaskOutput" && typeof input.task_id === "string" && part.output) {
      add(input.task_id, { output: part.output.slice(0, 16000), truncated: !!part.output_ref || part.output.length > 16000 });
    } else {
      const id = /^Command running in background with ID: ([a-zA-Z0-9_-]+)(?=[.\s]|$)/.exec(part.output)?.[1];
      if (id && typeof input.command === "string" && input.command.trim()) add(id, { command: input.command.slice(0, 8000), ...(input.command.length > 8000 ? { truncated: true } : {}) });
    }
  }
  return new Map([...receipts].slice(-32));
}

/** Bounded, session-scoped facts shared from the chat's existing read. No extra transcript poll. */
export class BackgroundTaskReceiptStore {
  private readonly values = new Map<string, { history: string | undefined; facts: ReadonlyMap<string, BackgroundTaskReceipt> }>();
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly read = (key: string | null): ReadonlyMap<string, BackgroundTaskReceipt> => key === null ? EMPTY : this.values.get(key)?.facts ?? EMPTY;
  publish(key: string, conversation: Pick<ConversationResponse, "turns" | "history_id">): void {
    const before = this.values.get(key);
    const facts = new Map(before && before.history === conversation.history_id ? before.facts : []);
    for (const [id, receipt] of taskReceipts(conversation.turns)) facts.set(id, { ...facts.get(id), ...receipt });
    while (facts.size > 32) facts.delete(facts.keys().next().value!);
    if (before && before.history === conversation.history_id && JSON.stringify([...facts]) === JSON.stringify([...before.facts])) return;
    this.values.delete(key);
    this.values.set(key, { history: conversation.history_id, facts });
    while (this.values.size > 16) this.values.delete(this.values.keys().next().value!);
    for (const listener of this.listeners) listener();
  }
}
export const backgroundTaskReceipts = new BackgroundTaskReceiptStore();
export function useBackgroundTaskReceipts(key: string | null): ReadonlyMap<string, BackgroundTaskReceipt> {
  return useSyncExternalStore(backgroundTaskReceipts.subscribe, () => backgroundTaskReceipts.read(key), () => EMPTY);
}
