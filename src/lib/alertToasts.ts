/**
 * The in-app alert, as herdr-app tells one (src/window.rs `alert`, the toast mod): "X needs you" or
 * "X finished", with where it is (workspace / tab), in a card at the corner of the app; a click on
 * it opens the agent. Drawn by components/AlertToasts.tsx.
 */
import { useSyncExternalStore } from "react";

export type AlertToastKind = "blocked" | "done" | "ended";

/**
 * What an alert does, as herdr-app decides it: a question (blocked) always sounds, since it holds
 * the agent until someone answers, also for the pane in front of the user; a finish sounds only
 * for a pane the user is not looking at. The card is never for the pane in front. Each pane is
 * one agent here (a sub-agent runs inside its pane, and is not told apart), so a sub-agent never
 * alerts by itself.
 */
export function alertDecision(kind: AlertToastKind, looking: boolean): { sound: boolean; toast: boolean } {
  return { sound: kind === "blocked" || !looking, toast: !looking };
}

export interface AlertToast {
  /** one card per pane and kind: a newer alert of the same replaces it */
  key: string;
  kind: AlertToastKind;
  title: string;
  /** "workspace / tab" */
  place: string | null;
  open: () => void;
}

/** How long a card stays when nobody clicks it. A question stays until it is answered or dismissed. */
export const TOAST_MS = 8_000;
const SHOWN = 3;

let toasts: readonly AlertToast[] = [];
const listeners = new Set<() => void>();
function set(next: readonly AlertToast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

export function showAlertToast(toast: AlertToast): void {
  set([...toasts.filter((other) => other.key !== toast.key), toast].slice(-SHOWN));
}

export function dismissAlertToast(key: string): void {
  if (toasts.some((toast) => toast.key === key)) set(toasts.filter((toast) => toast.key !== key));
}

export function useAlertToasts(): readonly AlertToast[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => toasts, () => toasts);
}
