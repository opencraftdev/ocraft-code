import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConversationTurn } from "../shared/protocol.ts";

export interface NativeForkPoint { kind: "claude" | "codex"; hash: string; message?: string }
const points = new WeakMap<ConversationTurn, NativeForkPoint>();
const key = randomBytes(32);
export function markForkPoint(turn: ConversationTurn | undefined, kind: NativeForkPoint["kind"], entry: unknown, message?: unknown): void {
  if (!turn || (kind === "claude" && (typeof message !== "string" || !/^[\da-f-]{36}$/i.test(message)))) return;
  points.set(turn, { kind, hash: nativeRecordHash(entry), ...(typeof message === "string" ? { message } : {}) });
}
export const nativeRecordHash = (entry: unknown): string => createHash("sha256").update(JSON.stringify(entry)).digest("base64url");
export function copyForkPoints(before: readonly ConversationTurn[], after: readonly ConversationTurn[]): void {
  for (let i = 0; i < before.length; i++) { const point = points.get(before[i]!); if (point && after[i]) points.set(after[i]!, point); }
}
export function forkableTurns(paneId: string, history: string, turns: readonly ConversationTurn[]): ConversationTurn[] {
  return turns.map(turn => {
    const point = points.get(turn);
    if (!point || !turn.parts.some(part => part.kind === "text")) return turn;
    const payload = Buffer.from(JSON.stringify({ pane: paneId, history, point })).toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    return { ...turn, fork_ref: `${payload}.${signature}` };
  });
}
export function readForkPoint(ref: unknown, pane: string): { history: string; point: NativeForkPoint } | null {
  if (typeof ref !== "string" || ref.length > 4096) return null;
  const [payload, signature, extra] = ref.split(".");
  if (!payload || !signature || extra) return null;
  const wanted = createHmac("sha256", key).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (value.pane !== pane || typeof value.history !== "string" || !["claude", "codex"].includes(value.point?.kind) || !/^[\w-]{43}$/.test(value.point?.hash)) return null;
    return { history: value.history, point: value.point };
  } catch { return null; }
}
