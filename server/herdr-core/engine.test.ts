import { afterEach, describe, expect, test } from "bun:test";
import { agentGet, agentPrompt, herdrRpc, HerdrError, paneProcessInfo, paneSendKeys, sessionSnapshot, type EventFrame } from "../herdr/client.ts";
import { FakeCore, until } from "./core.fake.ts";
import { CoreAttachSession, CoreEngine, setCoreEngineForTests } from "./engine.ts";
import { CLOSE, DATA } from "./frames.ts";
import type { CoreTerminal, LayoutDoc } from "./snapshot.ts";

const EVENTS = 2;

function world() {
  const terminals: CoreTerminal[] = [
    { address: "t1", state: "live", cwd: "/w", cols: 80, rows: 24, reported: true, status: { state: "idle", app: "claude" } },
    { address: "t2", state: "live", cwd: "/w", cols: 80, rows: 24 },
  ];
  const foreground = { pid: 42, name: "claude", argv: ["claude", "--resume"], cwd: "/w/app" };
  let doc: LayoutDoc = { spaces: [{ id: "s1", name: "api", folder: "/w", tabs: [{ id: "tab1", name: "", root: { id: "tab1", type: "row", children: [
    { id: "p1", type: "block", content: { terminal: "t1" } },
  ] } }] }] };
  let nextChannel = 10;
  const core = new FakeCore((method, params) => {
    switch (method) {
      case "events.subscribe": return { seq: 1, terminals, channel: EVENTS };
      case "doc.get": return { value: doc, version: 1 };
      case "terminal.attach": return { channel: nextChannel++, terminal: terminals.find((t) => t.address === params["terminal"]), automatic_input: false, resize_notifications: false };
      case "terminal.read": return { text: "$ ls\n", complete: true, how: "screen" };
      case "terminal.keys": return { pressed: params["keys"] };
      case "terminal.get": return { ...terminals.find((t) => t.address === params["terminal"]), pid: 40, foreground: params["terminal"] === "t1" ? foreground : null };
      case "terminal.send": return { turn: 3, status: "idle", started: true };
      case "terminal.wait": return { terminal: params["terminal"], ended: true, reason: params["output"] === "ready" ? "output" : "timeout", turn: 3, children: [] };
      default: throw new Error(`unexpected ${method}`);
    }
  });
  const engine = new CoreEngine(() => core.transport());
  return { core, engine, setDoc: (next: LayoutDoc) => (doc = next) };
}

afterEach(() => {
  delete process.env["OVIS_ENGINE"];
  setCoreEngineForTests(null);
});

describe("CoreEngine", () => {
  test("reads the snapshot from the subscription and the layout document", async () => {
    const { engine, core } = world();
    const snap = await engine.sessionSnapshot();
    expect(snap.version).toBe("herdr-core 0.1.11");
    expect(snap.panes.map((p) => [p.pane_id, p.terminal_id])).toEqual([["p1", "t1"], ["hc:loose:t2", "t2"]]);
    expect(core.calls.map((c) => c.method)).toEqual(["events.subscribe", "doc.get"]);
    expect(await engine.ping()).toEqual({ version: "herdr-core 0.1.11", protocol: 1, terminal_attach: true });
    await engine.close();
  });

  test("answers herdr 0.9 subscriptions from herdr-core events", async () => {
    const { engine, core, setDoc } = world();
    const frames: EventFrame[] = [];
    let started = false;
    engine.subscribeEvents(
      [{ type: "pane.agent_status_changed", pane_id: "p1" }, { type: "layout.updated" }, { type: "pane.exited" }],
      { onEvent: (f) => frames.push(f), onStarted: () => (started = true) },
    );
    await until(() => started);

    core.event(EVENTS, { method: "event", params: { seq: 2, type: "status", terminal: "t1", data: { status: { state: "working", app: "codex" }, records: {}, reported: true } } });
    await until(() => frames.length === 1);
    expect(frames[0]).toEqual({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "working", agent: "codex" } });
    // an old seq is already in the snapshot
    core.event(EVENTS, { method: "event", params: { seq: 2, type: "status", terminal: "t1", data: { status: { state: "idle" } } } });

    setDoc({ spaces: [{ id: "s1", name: "api", folder: "/w", tabs: [{ id: "tab1", name: "", root: { id: "tab1", type: "row", children: [
      { id: "p1", type: "block", content: { terminal: "t1" } },
      { id: "p2", type: "block", content: { terminal: "t2" } },
    ] } }] }] });
    core.event(EVENTS, { method: "event", params: { seq: 3, type: "doc", data: { name: "herdr-app", version: 2 } } });
    await until(() => frames.length === 2);
    expect(frames[1]).toEqual({ event: "layout.updated", data: { type: "layout_updated" } });
    expect((await engine.sessionSnapshot()).panes.map((p) => p.pane_id)).toEqual(["p1", "p2"]);

    core.event(EVENTS, { method: "event", params: { seq: 4, type: "finished", terminal: "t1", data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 1 } } });
    await until(() => frames.length === 4);
    expect(frames[2]).toEqual({ event: "pane.exited", data: { type: "pane_exited", pane_id: "p1" } });
    expect((await engine.sessionSnapshot()).panes.map((p) => p.pane_id)).toEqual(["p2"]);
    await engine.close();
  });

  test("a lost core closes subscriptions, and the next use connects again", async () => {
    const first = world();
    let closed = false;
    let started = false;
    first.engine.subscribeEvents([{ type: "layout.updated" }], { onEvent: () => {}, onStarted: () => (started = true), onClose: () => (closed = true) });
    await until(() => started);
    first.core.drop();
    await until(() => closed);
  });

  test("an attach streams bytes both ways and reports the program's exit", async () => {
    const { engine, core } = world();
    const out: string[] = [];
    const exits: Array<number | null> = [];
    const session = new CoreAttachSession({ terminal: "t1", cols: 100, rows: 30, onData: (d) => out.push(d), onExit: (c) => exits.push(c) }, engine);
    session.write("echo hi\r"); // before the attach answered: it waits
    await until(() => core.calls.some((c) => c.method === "terminal.attach"));
    expect(core.calls.find((c) => c.method === "terminal.attach")?.params).toEqual({ terminal: "t1", cols: 100, rows: 30, history: 0 });
    await until(() => core.sent(10, DATA).length === 1);
    expect(new TextDecoder().decode(core.sent(10, DATA)[0])).toBe("echo hi\r");
    core.send(10, DATA, new TextEncoder().encode("hi\r\n"));
    await until(() => out.length === 1);
    expect(out).toEqual(["hi\r\n"]);
    core.send(10, CLOSE, new TextEncoder().encode('{"reason":"exited","exit_code":3}'));
    await session.exited;
    expect(exits).toEqual([3]);
    await engine.close();
  });

  test("kill detaches without an exit", async () => {
    const { engine, core } = world();
    const exits: Array<number | null> = [];
    const session = new CoreAttachSession({ terminal: "t1", cols: 80, rows: 24, onData: () => {}, onExit: (c) => exits.push(c) }, engine);
    await until(() => core.calls.some((c) => c.method === "terminal.attach"));
    await until(() => core.calls.length === 3 && (session as unknown as { stream: unknown }).stream !== null);
    session.kill();
    await session.exited;
    await until(() => core.sent(10, CLOSE).length === 1);
    expect(exits).toEqual([]);
    await engine.close();
  });

  test("text goes in through a short attach at the terminal's size; keys and reads by terminal", async () => {
    const { engine, core } = world();
    await engine.paneSendText("p1", "hello");
    await until(() => core.sent(10, CLOSE).length === 1);
    expect(core.calls.at(-1)?.params).toEqual({ terminal: "t1", cols: 80, rows: 24, history: 0, resumed: true });
    expect(new TextDecoder().decode(core.sent(10, DATA)[0])).toBe("hello");
    await engine.paneSendKeys("p1", ["enter"]);
    expect(core.calls.at(-1)).toEqual({ method: "terminal.keys", params: { terminal: "t1", keys: ["enter"] } });
    expect((await engine.paneRead({ paneId: "p1" })).text).toBe("$ ls\n");
    expect(((await engine.paneRead({ paneId: "nope" }).catch((e: unknown) => e)) as HerdrError).code).toBe("pane_not_found");
    await engine.close();
  });
});

describe("engine selection", () => {
  test("the herdr client dispatches to herdr-core, and refuses every herdr 0.9 call it does not map", async () => {
    const { engine, core } = world();
    setCoreEngineForTests(engine);
    process.env["OVIS_ENGINE"] = "herdr-core";
    expect((await sessionSnapshot()).panes[0]?.pane_id).toBe("p1");
    await paneSendKeys("p1", ["esc"]);
    expect(core.calls.at(-1)?.method).toBe("terminal.keys");
    const refused = await herdrRpc("pane.close", { pane_id: "p1" }).catch((e: unknown) => e);
    expect((refused as HerdrError).code).toBe("unsupported_engine");
    await engine.close();
  });

  test("process info, agents, prompts and output waits go to the pane's terminal", async () => {
    const { engine, core } = world();
    setCoreEngineForTests(engine);
    process.env["OVIS_ENGINE"] = "herdr-core";
    // what the chat's transcript lookup asks (server/conversation.ts): the foreground leader, by pane_id
    expect(await paneProcessInfo("p1")).toEqual({
      pane_id: "p1", shell_pid: 40, foreground_process_group_id: 42,
      foreground_processes: [{ pid: 42, name: "claude", argv: ["claude", "--resume"], argv0: "claude", cwd: "/w/app" }],
    });
    expect(core.calls.at(-1)).toEqual({ method: "terminal.get", params: { terminal: "t1" } });
    expect((await paneProcessInfo("hc:loose:t2"))?.foreground_processes).toEqual([]);

    const agent = await agentGet("p1");
    expect([agent.pane_id, agent.terminal_id, agent.agent, agent.agent_status, agent.agent_session]).toEqual(["p1", "t1", "claude", "idle", undefined]);
    expect(((await agentGet("hc:loose:t2").catch((e: unknown) => e)) as HerdrError).code).toBe("agent_not_found");
    expect((await herdrRpc<{ agents: { pane_id: string }[] }>("agent.list", {})).agents.map((a) => a.pane_id)).toEqual(["p1"]);

    await agentPrompt("p1", "fix the test");
    expect(core.calls.at(-1)).toEqual({ method: "terminal.send", params: { terminal: "t1", text: "fix the test" } });
    expect(((await agentPrompt("p1", "late", undefined, () => false).catch((e: unknown) => e)) as HerdrError).code).toBe("cancelled");
    expect(core.calls.at(-1)?.method).toBe("terminal.send");
    expect(core.calls.filter((c) => c.method === "terminal.send")).toHaveLength(1);

    await herdrRpc("pane.send_input", { pane_id: "p1", keys: ["enter"] });
    expect(core.calls.at(-1)).toEqual({ method: "terminal.keys", params: { terminal: "t1", keys: ["enter"] } });

    expect(await herdrRpc<unknown>("pane.wait_for_output", { pane_id: "p1", source: "recent", match: { type: "substring", value: "ready" }, timeout_ms: 2000 }))
      .toEqual({ type: "output_matched", pane_id: "p1", matched_line: "ready" });
    expect(core.calls.at(-1)).toEqual({ method: "terminal.wait", params: { terminal: "t1", output: "ready", timeout: 2 } });
    expect(((await herdrRpc("pane.wait_for_output", { pane_id: "p1", source: "recent", match: { type: "substring", value: "never" }, timeout_ms: 10 }).catch((e: unknown) => e)) as HerdrError).code).toBe("timeout");
    expect(((await herdrRpc("pane.wait_for_output", { pane_id: "p1", source: "recent", match: { type: "regex", value: "r.*y" } }).catch((e: unknown) => e)) as HerdrError).code).toBe("unsupported_engine");
    await engine.close();
  });
});
