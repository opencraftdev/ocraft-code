import { describe, expect, it } from "bun:test";
import { agentWorkBlocks, type AgentWorkEvent } from "./agentWork.ts";
const event = (kind: AgentWorkEvent["kind"], text: string): AgentWorkEvent => ({ kind, text, at: null });
describe("agent detail reading order", () => {
  it("folds consecutive tools while preserving the narration between batches", () => {
    const events = [event("text", "Reading the test."), event("tool", 'Read {"path":"test.ts"}'), event("tool", 'Bash {"command":"bun test"}'), event("text", "The test passes."), event("tool", 'Write {"path":"report.md"}')];
    const blocks = agentWorkBlocks(events);
    expect(blocks.map(block => block.kind)).toEqual(["text", "tools", "text", "tools"]);
    expect(blocks[1]).toEqual({ kind: "tools", events: events.slice(1, 3) });
    expect(blocks[2]).toEqual({ kind: "text", event: events[3]! });
    expect(events.length).toBe(5);
  });
  it("counts only recorded calls, even when narration mentions commands or failures", () => {
    const text = event("text", "Ran 21 commands (1 failed). This is narration, not 21 recorded tool events.");
    expect(agentWorkBlocks([text])).toEqual([{ kind: "text", event: text }]);
    expect(agentWorkBlocks([])).toEqual([]);
  });
});
