import { describe, expect, it } from "bun:test";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { BackgroundTaskReceiptStore, taskReceipts } from "./backgroundTaskReceipts.ts";
const turn = (...parts: ConversationPart[]): ConversationTurn => ({ role: "assistant", ts: null, parts });
const launch = (id = "bjob", command = "bun test"): ConversationPart => ({ kind: "tool", name: "Bash", summary: "Background tests", input: JSON.stringify({ command, run_in_background: true }), output: `Command running in background with ID: ${id}. Output is being written to a file.` });
describe("background task transcript receipts", () => {
  it("pairs a native launch with its exact task ID and reported output", () => {
    const facts = taskReceipts([turn(launch(), { kind: "tool", name: "TaskOutput", summary: "Read job", input: '{"task_id":"bjob"}', output: "20 tests passed" })]);
    expect(facts.get("bjob")).toEqual({ command: "bun test", output: "20 tests passed", truncated: false });
  });
  it("does not turn prose, quoted receipts, other tools, or malformed inputs into commands", () => {
    const tool = launch() as Extract<ConversationPart, { kind: "tool" }>;
    expect(taskReceipts([turn({ kind: "text", text: tool.output }, { ...tool, output: `Example: ${tool.output}` }, { ...tool, name: "Read" }, { ...tool, input: "null" }, { ...tool, input: "{" })]).size).toBe(0);
  });
  it("isolates machines/sessions and drops old history after a rewind or restart", () => {
    const store = new BackgroundTaskReceiptStore();
    store.publish("local:pane", { history_id: "one", turns: [turn(launch())] });
    expect(store.read("remote:pane").size).toBe(0);
    store.publish("local:pane", { history_id: "one", turns: [] });
    expect(store.read("local:pane").get("bjob")?.command).toBe("bun test");
    store.publish("local:pane", { history_id: "two", turns: [] });
    expect(store.read("local:pane").size).toBe(0);
  });
  it("keeps stable snapshots and bounds both records and retained sessions", () => {
    const store = new BackgroundTaskReceiptStore(); let updates = 0;
    store.subscribe(() => updates++);
    const conversation = { turns: [turn(launch())] };
    store.publish("p", conversation); const snapshot = store.read("p");
    store.publish("p", conversation); expect(store.read("p")).toBe(snapshot); expect(updates).toBe(1);
    store.publish("many", { turns: Array.from({ length: 40 }, (_, i) => turn(launch(`b${i}`, "x".repeat(9000)))) });
    expect(store.read("many").size).toBe(32); expect(store.read("many").get("b39")?.command?.length).toBe(8000); expect(store.read("many").get("b39")?.truncated).toBe(true);
    for (let i = 0; i < 16; i++) store.publish(`pane${i}`, conversation);
    expect(store.read("p").size).toBe(0);
  });
});
