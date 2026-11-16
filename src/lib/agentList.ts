/**
 * The Agents list as herdr-app's agents sidebar orders it (its defaults/mods/agents/main.js): a
 * Priority view (most urgent first, then the latest change) or one grouped by workspace, the
 * pinned rows first in either; a parent ranks as its most urgent sub-agent; Alt+Down / Alt+Up
 * (⌘] / ⌘[ on a Mac) step through the rows in list order. Kept per device, in keys of their own.
 */
import { useState } from "react";

import type { KnownStatus } from "./status.ts";

export type AgentView = "priority" | "space";

const VIEW_KEY = "ovis:agents-view";
const CHANGED_KEY = "ovis:agents-changed";
const UNREAD_KEY = "ovis:agents-unread";

function read(key: string): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage denied: kept for the session */ }
}

/** Priority (herdr-app's default) or By space, as this device last chose. */
export function useAgentView(): [AgentView, (view: AgentView) => void] {
  const [view, setView] = useState<AgentView>(() => read(VIEW_KEY) === "space" ? "space" : "priority");
  return [view, (next) => { write(VIEW_KEY, next); setView(next); }];
}

/** herdr's roll-up order as a number: needs you, then finished and not seen, then working, then idle. */
export const AGENT_RANK: Readonly<Record<KnownStatus, number>> = { blocked: 4, done: 3, working: 2, waiting: 2, idle: 1, unknown: 1 };

/** A parent stands where its most urgent sub-agent would. */
export function agentRank(own: KnownStatus, kids: readonly KnownStatus[] = []): number {
  return Math.max(AGENT_RANK[own], ...kids.map((kid) => AGENT_RANK[kid]));
}

/**
 * Drops what an agent puts before its title: a status glyph or spinner and the separator after it
 * ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark. Stops at a letter,
 * a digit, an opening bracket or quote, or a path's start, so "[web] login" and "~/src" keep theirs.
 */
export function cleanAgentTitle(title: string): string {
  const cleaned = title.replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}~/\\.]+/u, "").replace(/^\[ [!.] \] /, "").trim();
  return cleaned || title.trim();
}

/** Each row's last state and when it changed (ms): done and idle count as one, since looking turns one into the other. */
export type AgentChanges = Readonly<Record<string, { s: string; at: number }>>;

const MONTH_MS = 30 * 86_400_000;

/** The changes with these rows' states stamped, or null when none changed; rows gone a month leave. */
export function trackChanges(changed: AgentChanges, rows: ReadonlyArray<{ key: string; status: KnownStatus }>, now: number): AgentChanges | null {
  let next: Record<string, { s: string; at: number }> | null = null;
  for (const { key, status } of rows) {
    const s = status === "done" ? "idle" : status;
    if (changed[key]?.s === s) continue;
    next ??= { ...changed };
    next[key] = { s, at: now };
  }
  if (next === null) return null;
  const listed = new Set(rows.map((row) => row.key));
  for (const [key, change] of Object.entries(next)) if (!listed.has(key) && now - change.at > MONTH_MS) delete next[key];
  return next;
}

export function loadChanges(): AgentChanges {
  try {
    const parsed: unknown = JSON.parse(read(CHANGED_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AgentChanges : {};
  } catch { return {}; }
}

export function saveChanges(changed: AgentChanges): void { write(CHANGED_KEY, JSON.stringify(changed)); }

/** One finish marked unread on this device: the row, then the finish it was (a later finish is news by itself). */
export const unreadKey = (rowKey: string, finishId: number): string => `${rowKey}#${finishId}`;

export function loadUnread(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(UNREAD_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch { return []; }
}

// ponytail: the last 200 marks only; a mark this old was read or replaced long ago
export function saveUnread(keys: readonly string[]): void { write(UNREAD_KEY, JSON.stringify(keys.slice(-200))); }

/** Whatever this row had marked unread goes once it is opened. */
export const clearUnread = (keys: readonly string[], rowKey: string): string[] => keys.filter((key) => !key.startsWith(`${rowKey}#`));

export interface AgentGroup<R> {
  /** `pinned`, `rank-<n>` for a Priority section, or the space's own id */
  id: string;
  /** the space's name; a section's word is the component's to translate */
  label: string;
  /** a Priority section's rank; null for the pinned card and a space */
  rank: number | null;
  members: R[];
}

export interface GroupOptions<R> {
  view: AgentView;
  /** in pin order */
  pinned: readonly R[];
  /** in the roster's order (by workspace, or Settings' Activity order) */
  rest: readonly R[];
  rankOf(row: R): number;
  /** when the row's state last changed (trackChanges), 0 when unknown */
  sinceOf(row: R): number;
  spaceOf(row: R): { id: string; label: string };
}

/**
 * The list's groups in drawing order: the pinned card, then Priority's sections (rank, then the
 * latest change, then the roster's order) or one group per space in the order the spaces first come.
 */
export function agentGroups<R>({ view, pinned, rest, rankOf, sinceOf, spaceOf }: GroupOptions<R>): AgentGroup<R>[] {
  const groups: AgentGroup<R>[] = pinned.length > 0 ? [{ id: "pinned", label: "", rank: null, members: [...pinned] }] : [];
  if (view === "priority") {
    const sorted = rest.map((row, index) => ({ row, index, rank: rankOf(row), since: sinceOf(row) }))
      .sort((a, b) => b.rank - a.rank || b.since - a.since || a.index - b.index);
    for (const { row, rank } of sorted) {
      const last = groups.at(-1);
      if (last?.rank === rank) last.members.push(row);
      else groups.push({ id: `rank-${rank}`, label: "", rank, members: [row] });
    }
    return groups;
  }
  const spaces = new Map<string, AgentGroup<R>>();
  for (const row of rest) {
    const { id, label } = spaceOf(row);
    const group = spaces.get(id);
    if (group) group.members.push(row);
    else spaces.set(id, { id, label, rank: null, members: [row] });
  }
  return [...groups, ...spaces.values()];
}

/** The row `delta` away from `current` in list order, round the ends; the first or last when none is current. */
export function stepAgent(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return delta > 0 ? order[0]! : order.at(-1)!;
  return order[(at + delta + order.length) % order.length]!;
}

let agentStepper: ((delta: 1 | -1) => void) | null = null;
/** The Agents list publishes how it steps, so the Next / Previous agent commands follow its order */
export function setAgentStepper(stepper: ((delta: 1 | -1) => void) | null): void { agentStepper = stepper; }
/** Steps the Agents list; false when no list is mounted */
export function stepAgentList(delta: 1 | -1): boolean {
  if (agentStepper === null) return false;
  agentStepper(delta);
  return true;
}
