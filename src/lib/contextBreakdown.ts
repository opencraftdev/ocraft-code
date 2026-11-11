import type { ConversationTurn } from "../../shared/protocol.ts";

export type ContextCategory = "messages" | "tools" | "skills" | "system" | "memory" | "update" | "buffer" | "free";
export interface ContextCategoryUsage { category: ContextCategory; tokens: number }
const CATEGORIES: Record<string, ContextCategory> = {
  messages: "messages", "system tools": "tools", skills: "skills", "system prompt": "system",
  "memory files": "memory", "since last update": "update", "autocompact buffer": "buffer", "free space": "free",
};
function tokens(text: string): { value: number; tolerance: number } | null {
  const m = /^([\d,]+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text.trim());
  if (!m) return null;
  const scale = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
  const value = Number(m[1]!.replaceAll(",", "")) * scale;
  return Number.isFinite(value) ? { value, tolerance: scale / 10 ** (m[1]!.split(".")[1]?.length ?? 0) / 2 } : null;
}

/** Native /context tables only, valid until the next assistant request. Never estimate categories. */
export function reportedContextBreakdown(turns: readonly ConversationTurn[], used: number, window: number | null): ContextCategoryUsage[] | undefined {
  if (window === null) return undefined;
  let report: string | undefined;
  for (const turn of turns.slice(-100)) {
    if (turn.role === "assistant" && turn.parts.some(part => ["text", "thinking", "tool", "compact"].includes(part.kind))) report = undefined;
    for (const part of turn.parts) if (part.kind === "notice" && part.source === "local-command" && /\bcontext usage\b/i.test(part.text)) report = part.text;
  }
  if (!report) return undefined;
  const ratio = /([\d,.]+\s*[kKmM]?)\s*\/\s*([\d,.]+\s*[kKmM]?)/.exec(report);
  const reportedUsed = ratio && tokens(ratio[1]!), reportedWindow = ratio && tokens(ratio[2]!);
  if (!reportedUsed || !reportedWindow || Math.abs(reportedUsed.value - used) > reportedUsed.tolerance || Math.abs(reportedWindow.value - window) > reportedWindow.tolerance) return undefined;
  const rows: ContextCategoryUsage[] = [];
  let tolerance = 0;
  for (const line of report.split("\n")) {
    const cells = line.replaceAll("**", "").trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
    const category = CATEGORIES[cells[0]?.toLowerCase() ?? ""];
    const count = category && cells[1] ? tokens(cells[1].replace(/\s+tokens?$/i, "")) : null;
    if (!category || !count || rows.some(row => row.category === category)) continue;
    rows.push({ category, tokens: count.value }); tolerance += count.tolerance;
  }
  const consumed = rows.filter(row => row.category !== "buffer" && row.category !== "free").reduce((sum, row) => sum + row.tokens, 0);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (rows.length < 2 || !rows.some(row => row.category === "free") || Math.abs(consumed - used) > tolerance || Math.abs(total - window) > tolerance) return undefined;
  return rows;
}
