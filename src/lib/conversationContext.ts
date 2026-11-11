import { useSyncExternalStore } from "react";
import type { ConversationMetadata, ConversationTurn, HerdrPane } from "../../shared/protocol.ts";

import { reportedContextBreakdown, type ContextCategoryUsage } from "./contextBreakdown.ts";

export interface ConversationContext { used: number; window: number | null; breakdown?: ContextCategoryUsage[] }
export function conversationContextKey(machineId: string, pane: HerdrPane | null, epoch?: string): string | null {
  return pane ? JSON.stringify([machineId, pane.pane_id, pane.terminal_id, pane.agent_session?.value, epoch]) : null;
}

/** Share the chat's reported usage with the rail, without fetching a second transcript. */
export class ConversationContextStore {
  private readonly values = new Map<string, ConversationContext>();
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly read = (key: string | null): ConversationContext | null => key === null ? null : this.values.get(key) ?? null;
  publish(key: string, metadata: ConversationMetadata | null, turns?: readonly ConversationTurn[]): void {
    const reported = metadata?.context;
    const context: ConversationContext | null = reported && Number.isFinite(reported.used) && reported.used >= 0
      ? { used: reported.used, window: reported.window !== null && Number.isFinite(reported.window) && reported.window > 0 ? reported.window : null } : null;
    if (context && turns) {
      const breakdown = reportedContextBreakdown(turns, context.used, context.window);
      if (breakdown) Object.assign(context, { breakdown });
    }
    const before = this.read(key);
    if (context?.used === before?.used && context?.window === before?.window && JSON.stringify(context?.breakdown) === JSON.stringify(before?.breakdown)) return;
    this.values.delete(key);
    if (context) this.values.set(key, context);
    // Recent panes only; neither transcripts nor token counts are persisted to storage.
    while (this.values.size > 64) this.values.delete(this.values.keys().next().value!);
    for (const listener of this.listeners) listener();
  }
}
export const conversationContexts = new ConversationContextStore();
export function useConversationContext(key: string | null): ConversationContext | null {
  return useSyncExternalStore(conversationContexts.subscribe, () => conversationContexts.read(key), () => null);
}
