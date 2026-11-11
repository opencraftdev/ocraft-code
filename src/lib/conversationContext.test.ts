import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { ConversationContextStore, conversationContextKey } from "./conversationContext.ts";

const metadata = (used: number, window: number | null) => ({ model: "reported-model", reasoning_effort: null, context: { used, window } });
describe("conversation context shared with the right rail", () => {
  it("isolates equal pane IDs by computer, terminal, agent session and server epoch", () => {
    const pane = { pane_id: "p1", terminal_id: "t1", agent_session: { value: "s1" } } as HerdrPane;
    const key = conversationContextKey("local", pane, "e1")!;
    const store = new ConversationContextStore();
    store.publish(key, metadata(54_000, 200_000));
    expect(store.read(key)).toEqual({ used: 54_000, window: 200_000 });
    for (const other of [conversationContextKey("remote", pane, "e1"), conversationContextKey("local", { ...pane, terminal_id: "t2" }, "e1"), conversationContextKey("local", { ...pane, agent_session: { ...pane.agent_session!, value: "s2" } }, "e1"), conversationContextKey("local", pane, "e2")]) expect(store.read(other)).toBeNull();
    expect(conversationContextKey("local", null)).toBeNull();
  });
  it("keeps unknown limits unknown and distinguishes reported zero from missing usage", () => {
    const store = new ConversationContextStore();
    expect(store.read("pane")).toBeNull();
    store.publish("pane", metadata(0, null));
    expect(store.read("pane")).toEqual({ used: 0, window: null });
    store.publish("pane", metadata(1234, 0));
    expect(store.read("pane")).toEqual({ used: 1234, window: null });
    store.publish("pane", null);
    expect(store.read("pane")).toBeNull();
  });
  it("notifies only for changed usage and keeps snapshots stable", () => {
    const store = new ConversationContextStore(); let calls = 0;
    const stop = store.subscribe(() => { calls++; });
    store.publish("pane", metadata(40, 100)); const before = store.read("pane");
    store.publish("pane", metadata(40, 100));
    expect(calls).toBe(1); expect(store.read("pane")).toBe(before);
    store.publish("pane", metadata(50, 100)); expect(calls).toBe(2);
    stop(); store.publish("pane", metadata(60, 100)); expect(calls).toBe(2);
  });
  it("drops malformed usage rather than displaying misleading percentages", () => {
    const store = new ConversationContextStore();
    for (const used of [-1, NaN, Infinity]) { store.publish("pane", metadata(used, 100)); expect(store.read("pane")).toBeNull(); }
    store.publish("pane", metadata(10, Infinity)); expect(store.read("pane")).toEqual({ used: 10, window: null });
  });
  it("bounds the in-memory cache of previous sessions", () => {
    const store = new ConversationContextStore();
    for (let i = 0; i < 65; i++) store.publish(`pane${i}`, metadata(i, 100));
    expect(store.read("pane0")).toBeNull(); expect(store.read("pane64")).toEqual({ used: 64, window: 100 });
  });
});
