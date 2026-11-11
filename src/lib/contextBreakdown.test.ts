import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { reportedContextBreakdown } from "./contextBreakdown.ts";
const text = `## Context Usage
**Tokens:** 49.1k / 100k (49%)
| Category | Tokens | Percentage |
| Messages | 38.4k | 38.4% |
| System tools | 1.7k | 1.7% |
| Skills | 1k | 1% |
| System prompt | 1k | 1% |
| Memory files | 200 | 0.2% |
| Since last update | 6.8k | 6.8% |
| Autocompact buffer | 3.3k | 3.3% |
| Free space | 47.6k | 47.6% |`;
const notice = (value = text): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "notice", source: "local-command", text: value }] });
describe("reported native context category tables", () => {
  it("reads eight reported categories and reconciles them to actual usage/capacity", () => {
    const rows = reportedContextBreakdown([notice()], 49100, 100000)!;
    expect(rows.length).toBe(8); expect(rows[0]).toEqual({ category: "messages", tokens: 38400 }); expect(rows.at(-1)?.tokens).toBe(47600);
  });
  it("never estimates categories or reads an assistant/user quote as a runtime report", () => {
    expect(reportedContextBreakdown([{ role: "assistant", ts: null, parts: [{ kind: "text", text }] }], 49100, 100000)).toBeUndefined();
    expect(reportedContextBreakdown([{ role: "user", ts: null, parts: [{ kind: "notice", text, source: "informational" }] }], 49100, 100000)).toBeUndefined();
    expect(reportedContextBreakdown([notice("No report")], 49100, 100000)).toBeUndefined();
  });
  it("expires stale breakdowns after another model request or different totals", () => {
    expect(reportedContextBreakdown([notice(), { role: "assistant", ts: null, parts: [{ kind: "text", text: "Next response" }] }], 49100, 100000)).toBeUndefined();
    expect(reportedContextBreakdown([notice()], 60000, 100000)).toBeUndefined();
    expect(reportedContextBreakdown([notice()], 49100, null)).toBeUndefined();
    expect(reportedContextBreakdown([notice()], 49100, 200000)).toBeUndefined();
  });
  it("rejects inconsistent category totals instead of drawing a misleading chart", () => {
    expect(reportedContextBreakdown([notice(text.replace("38.4k", "88.4k"))], 49100, 100000)).toBeUndefined();
    expect(reportedContextBreakdown([notice(text.replace("47.6k", "1k"))], 49100, 100000)).toBeUndefined();
  });
});
