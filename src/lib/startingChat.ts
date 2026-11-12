/**
 * A chat that just started (the Assistant's New chat) has no pane in the snapshot and no transcript
 * for its first seconds. In that time the chat says Starting… and a failed read is retried quietly,
 * so only a read that still fails after it shows its error. A cold agent on a small VM can take most
 * of a minute; after that the error shows, and the read is still retried every few seconds, so a
 * dropped connection or a late agent recovers without a click.
 */
export const STARTING_MS = 60_000;
const RETRY_MS = 1000;
export const LATER_RETRY_MS = 5000;

/** ms until the next retry of a failed read in a chat started at `startedAt`: quietly at first, then with its error shown */
export function chatRetry(startedAt: number | undefined, now: number): number | null {
  if (startedAt === undefined) return null;
  return startingRetry(startedAt, now) ?? LATER_RETRY_MS;
}

/** ms until the next quiet retry of a chat started at `startedAt`, or null once it has had its time */
export function startingRetry(startedAt: number | undefined, now: number): number | null {
  if (startedAt === undefined) return null;
  const left = startedAt + STARTING_MS - now;
  return left > 0 ? Math.min(RETRY_MS, left) : null;
}
