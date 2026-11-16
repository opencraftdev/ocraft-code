/**
 * The app's command registry, as herdr-app's COMMANDS (src/commands.rs): one list the command
 * palette, the keyboard and the keys dialog all read, so a command added once is found by name,
 * run by its key and listed with it. The built-in shortcuts (lib/shortcuts.ts) keep their own
 * table, since Settings rebinds them; anything else registers here with `registerCommands` and
 * takes it back with the function that returns.
 *
 * A command can offer choices (each listed as "Label: choice", as herdr-app's "Layout: X") or ask
 * for a name first (`prompt`): the palette then turns its search field into that question.
 */
import { useSyncExternalStore } from "react";

export interface CommandChoice {
  label: string;
  value: string;
}

export interface AppCommand {
  /** dotted, as herdr-app names its actions: "workspace.next" */
  id: string;
  /** as shown, already in the user's language */
  label: string;
  /** default exact chords, per platform ("alt+1", "shift+F2"; lib/shortcutBindings.ts formatExactChord) */
  keys?: { mac?: readonly string[]; other?: readonly string[] };
  /** left out of the palette (a numbered key whose choice row the palette already has) */
  hidden?: boolean;
  /** one palette row per choice, run with its value */
  choices?: () => readonly CommandChoice[];
  /** asks for a name first; `run` gets what was typed */
  prompt?: string;
  run: (value?: string) => void;
}

const registry = new Map<string, AppCommand>();
const listeners = new Set<() => void>();
let snapshot: readonly AppCommand[] = [];

function changed(): void {
  snapshot = [...registry.values()];
  for (const listener of listeners) listener();
}

/** Adds commands (a later one with the same id replaces the earlier); returns their removal. */
export function registerCommands(commands: readonly AppCommand[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  changed();
  return () => {
    for (const command of commands) if (registry.get(command.id) === command) registry.delete(command.id);
    changed();
  };
}

export function commandList(): readonly AppCommand[] {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommandList(): readonly AppCommand[] {
  return useSyncExternalStore(subscribe, commandList, commandList);
}

export function commandKeys(command: AppCommand, platformIsMac: boolean): readonly string[] {
  return (platformIsMac ? command.keys?.mac : command.keys?.other) ?? [];
}

/** The command whose default key is `pressed` (an exact chord as formatExactChord writes it). */
export function commandForChord(pressed: string, platformIsMac: boolean, commands: readonly AppCommand[] = snapshot): AppCommand | null {
  return commands.find((command) => commandKeys(command, platformIsMac).includes(pressed)) ?? null;
}

/**
 * The palette's opener: a command that asks for a name opens it on its question. The palette takes
 * the request as it opens (`takePromptRequest`), as Settings takes its page from the palette.
 */
let openPalette: (() => void) | null = null;
let promptRequest: string | null = null;
export function setPromptOpener(opener: (() => void) | null): void {
  openPalette = opener;
}
export function takePromptRequest(): AppCommand | null {
  const id = promptRequest;
  promptRequest = null;
  return id === null ? null : registry.get(id) ?? null;
}

/** Runs a command; one that asks for a name and has none opens the palette on its question. */
export function runCommand(id: string, value?: string): boolean {
  const command = registry.get(id);
  if (!command) return false;
  if (command.prompt !== undefined && value === undefined) {
    if (openPalette === null) return false;
    promptRequest = id;
    openPalette();
    return true;
  }
  command.run(value);
  return true;
}

/**
 * Letters of the query in order (spaces ignored), as herdr-app's palette matches: a letter at a
 * word's start counts more, one right after the last more, and a shorter text wins a tie. null
 * when the letters are not all there in order.
 * ponytail: greedy, first-occurrence matching; a best-alignment pass (fzf's) if ranks feel off.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLocaleLowerCase().replace(/\s+/g, "");
  if (needle === "") return 0;
  const hay = text.toLocaleLowerCase();
  let score = 0;
  let at = 0;
  let previous = -2;
  for (let index = 0; index < hay.length && at < needle.length; index += 1) {
    if (hay[index] !== needle[at]) continue;
    const wordStart = index === 0 || !/[\p{L}\p{N}]/u.test(hay[index - 1]!);
    score += 1 + (wordStart ? 8 : 0) + (index === previous + 1 ? 4 : 0);
    previous = index;
    at += 1;
  }
  if (at < needle.length) return null;
  return score - hay.length / 100;
}

export interface RankedRow<T> {
  item: T;
  title: string;
  /** other words it is found by, after every title match */
  aliases?: string;
  /** the id it is remembered by among the recent commands */
  recentId?: string;
}

/**
 * The palette's command order. A blank query: the commands run last first, newest first, then the
 * rest in their own order. A query: the fuzzy title matches best first, then those found only by
 * an alias (every word of the query in it), each in their own order.
 */
export function rankCommands<T>(query: string, rows: readonly RankedRow<T>[], recent: readonly string[] = []): T[] {
  const recency = (row: RankedRow<T>) => { const at = row.recentId === undefined ? -1 : recent.indexOf(row.recentId); return at < 0 ? recent.length : at; };
  if (query.trim() === "") return rows.map((row, index) => ({ row, index })).sort((a, b) => recency(a.row) - recency(b.row) || a.index - b.index).map(({ row }) => row.item);
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  const found: { item: T; index: number; score: number }[] = [];
  rows.forEach((row, index) => {
    const score = fuzzyScore(query, row.title);
    if (score !== null) found.push({ item: row.item, index, score });
    else if (row.aliases && words.every((word) => row.aliases!.toLocaleLowerCase().includes(word))) found.push({ item: row.item, index, score: -1 });
  });
  return found.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
}

const RECENT_KEY = "ovis:recent-commands";
const RECENT_KEPT = 12;

export function loadRecentCommands(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

/** Puts `id` first among the recent commands; returns the new list. */
export function rememberCommand(id: string, recent: readonly string[] = loadRecentCommands()): string[] {
  const next = [id, ...recent.filter((other) => other !== id)].slice(0, RECENT_KEPT);
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode: this page keeps none */ }
  return next;
}

/** The keys dialog (components/ShortcutsHelp.tsx): open or not, toggled by its key, as herdr-app's app.help. */
let helpOpen = false;
const helpListeners = new Set<() => void>();
export function setHelpOpen(open: boolean): void {
  if (helpOpen === open) return;
  helpOpen = open;
  for (const listener of helpListeners) listener();
}
export function toggleHelp(): void {
  setHelpOpen(!helpOpen);
}
export function useHelpOpen(): boolean {
  return useSyncExternalStore((listener) => { helpListeners.add(listener); return () => helpListeners.delete(listener); }, () => helpOpen, () => false);
}
