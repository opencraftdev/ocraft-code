import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantState } from "../shared/assistant.ts";
import { LOCAL_MACHINE, type Machine, type MachineEvent } from "../shared/machines.ts";
import type { AssistantPanes, AssistantSession } from "./assistant-sessions.ts";
import { Assistant, HEALTH_INTERVAL_MS, nextCheckDelay, type RunScript } from "./assistant.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";
import { MachineActionRequired } from "./machines.ts";


/** GET /api/health tells the client whether this server is the Assistant VM (OVIS_ASSISTANT=1). */
describe("the Assistant VM flag", () => {
  const webUi = async (environment: string | undefined) => {
    const saved = process.env["OVIS_ASSISTANT"];
    if (environment === undefined) delete process.env["OVIS_ASSISTANT"];
    else process.env["OVIS_ASSISTANT"] = environment;
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-"));
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, assistantPanes: panes });
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/health`);
      expect(response.status).toBe(200);
      return ((await response.json()) as { web_ui: { assistant?: boolean } }).web_ui;
    } finally {
      if (saved === undefined) delete process.env["OVIS_ASSISTANT"];
      else process.env["OVIS_ASSISTANT"] = saved;
      app.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  it("is on only when OVIS_ASSISTANT is 1", async () => {
    expect((await webUi("1")).assistant).toBe(true);
    expect((await webUi(undefined)).assistant).toBe(false);
    expect((await webUi("yes")).assistant).toBe(false);
  });
});


const PROFILE: HerdrMachineProfile = { id: "assistant-test", label: "Test PC", enabled: true, target: { destination: "assistant-test.invalid" } };
/** the Assistant's own pane: never a real herdr in these tests */
const panes: AssistantPanes = {
  open: async () => ({ paneId: "w1:p1", workspaceId: "w1" }), start: async () => undefined, pane: async () => ({ agent: "claude", status: "idle" }),
  context: async () => null, send: async () => undefined, close: async () => undefined,
};

/** A machine whose checks get a fixed answer and whose fixes are only recorded, so no test ever runs herdr. */
function fixtureMachine() {
  const scripts: string[] = [];
  const run: RunScript = async (_machine, script) => {
    scripts.push(script);
    return script.includes("status server") && !script.includes("nohup") ? "herdr\nclaude\n" : "";
  };
  return { scripts, run };
}

async function assistantServer(stateDir: string, run: RunScript) {
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: true, assistantRun: run, assistantPanes: panes, herdrProfiles: async () => [PROFILE] });
  const base = `http://127.0.0.1:${app.port}`;
  const send = (path: string, method: string, body?: unknown, origin = true) => fetch(`${base}/api/assistant${path}`, {
    method, headers: { "content-type": "application/json", ...(origin ? { origin: base } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await (await fetch(`${base}/api/assistant`)).json()) as AssistantState;
  // discovery reads the catalog as the server starts
  const deadline = Date.now() + 5000;
  while ((await state()).machines.length === 0 && Date.now() < deadline) await Bun.sleep(20);
  const machine = (await state()).machines[0]!;
  return { app, send, state, machine };
}

describe("Assistant machines", () => {
  it("answers nowhere on an Ovis that is not the Assistant VM", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-off-"));
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: false });
    try {
      expect((await fetch(`http://127.0.0.1:${app.port}/api/assistant`)).status).toBe(404);
    } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("lists herdr's saved machines with their health and Max running, and the one session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-machines-"));
    const { run } = fixtureMachine();
    const { app, send, state, machine } = await assistantServer(join(root, "state"), run);
    try {
      expect(machine).toMatchObject({ name: "Test PC", maxRunning: 3 });
      const deadline = Date.now() + 5000;
      while (((await state()).machines[0]!.health === null || (await state()).session === null) && Date.now() < deadline) await Bun.sleep(20);
      const read = await state();
      expect(Object.keys(read).sort()).toEqual(["machines", "session"]);
      expect(read.machines[0]!.health).toMatchObject({ problems: [], agents: ["claude"] });
      expect(read.session).toMatchObject({ agent: "claude", pane_id: "w1:p1", last_compaction: null, state: "running" });
      expect((await send(`/machines/${machine.id}`, "PATCH", { maxRunning: 0 })).status).toBe(400);
      expect((await send(`/machines/${machine.id}`, "PATCH", { maxRunning: 5 })).status).toBe(200);
      expect((await state()).machines[0]!.maxRunning).toBe(5);
      expect(JSON.parse(readFileSync(join(root, "state", "assistant", "machines.json"), "utf8"))).toEqual({ [machine.id]: { maxRunning: 5 } });
      expect((await send("/machines/not-a-machine", "PATCH", { maxRunning: 2 })).status).toBe(404);
      expect((await send("/restart", "GET")).status).toBe(405);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves the projects and tasks of an earlier build on disk, untouched and unread, and has no routes for them", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-earlier-"));
    const directory = join(root, "state", "assistant");
    mkdirSync(directory, { recursive: true });
    // not even valid: nothing reads them
    writeFileSync(join(directory, "projects.json"), "[{\"id\":\"app\"}]");
    writeFileSync(join(directory, "tasks.json"), "\0\0\0");
    const { run } = fixtureMachine();
    const { app, send } = await assistantServer(join(root, "state"), run);
    try {
      for (const [path, method] of [["/projects", "POST"], ["/projects/app", "PATCH"], ["/projects/app", "DELETE"], ["/sessions", "POST"], ["/sessions/20261111-2112", "GET"], ["/tasks/1/cancel", "POST"], ["/tasks/1/approve", "POST"]] as const) {
        expect({ path, method, status: (await send(path, method, method === "GET" || method === "DELETE" ? undefined : {})).status }).toEqual({ path, method, status: 404 });
      }
      expect(readFileSync(join(directory, "projects.json"), "utf8")).toBe("[{\"id\":\"app\"}]");
      expect(readFileSync(join(directory, "tasks.json"), "utf8")).toBe("\0\0\0");
      expect(readdirSync(directory).some((name) => name.includes("corrupt"))).toBe(false);
      expect(statSync(join(directory, "cli-token.json")).mode & 0o777).toBe(0o600);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("runs a fix only on an explicit POST from this app's page", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-fix-"));
    const { scripts, run } = fixtureMachine();
    const { app, send, machine } = await assistantServer(join(root, "state"), run);
    const fixes = () => scripts.filter((script) => script.includes("nohup")).length;
    try {
      expect((await send(`/machines/${machine.id}/fix`, "GET")).status).toBe(405);
      expect((await send(`/machines/${machine.id}/fix`, "POST", { fix: "start_herdr" }, false)).status).toBe(403);
      expect((await send(`/machines/${machine.id}/fix`, "POST", { fix: "reboot" })).status).toBe(400);
      expect(fixes()).toBe(0);
      expect((await send(`/machines/${machine.id}/fix`, "POST", { fix: "start_herdr" })).status).toBe(200);
      expect(fixes()).toBe(1);
      const script = scripts.find((candidate) => candidate.includes("nohup"))!;
      expect(script).not.toContain("--takeover");
      expect(script).not.toContain("focus");
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("the machine health watcher", () => {
  const machine: Machine = { id: "m1", herdr_profile_id: "p1", name: "PC", kind: "ssh", target: { destination: "pc.invalid" }, enabled: true, state: "connected", error: null, snapshot: null };
  /** a watcher whose clock is this test's: each scheduled check waits until the test fires it */
  function watcher(run: RunScript) {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-watch-"));
    const scheduled: { ms: number; fire: () => void }[] = [];
    let listener: ((event: MachineEvent) => void) | undefined;
    const assistant = new Assistant(stateDir, {
      list: () => [machine],
      subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
      retryNow: () => {},
    }, run, { timer: (fire, ms) => { scheduled.push({ ms, fire }); return () => {}; } });
    listener!({ type: "machines", machines: [machine] });
    /** the delay the last check chose for the next one */
    const settled = async () => {
      const deadline = Date.now() + 5000;
      while (scheduled.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      return scheduled[0]!.ms;
    };
    /** the scheduled check runs now; the delay it chose */
    const next = async () => { scheduled.shift()!.fire(); return settled(); };
    return { assistant, settled, next, done: () => { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
  }

  it("checks every 30 seconds, and backs off while SSH fails", async () => {
    let reachable = false;
    const { assistant, settled, next, done } = watcher(async () => { if (!reachable) throw new Error("ssh: connect timed out"); return "herdr\ncodex\n"; });
    try {
      expect([await settled(), await next(), await next(), await next(), await next(), await next()])
        .toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
      expect(assistant.state().machines[0]!.health).toMatchObject({ problems: ["unreachable"], error: "ssh: connect timed out" });
      reachable = true;
      expect(await next()).toBe(HEALTH_INTERVAL_MS);
      expect(assistant.state().machines[0]!.health).toMatchObject({ problems: [], agents: ["codex"] });
    } finally { done(); }
  });

  it("reports what is wrong without backing off, and a PC not yet connected", async () => {
    let answer: () => string = () => "";
    const { assistant, settled, next, done } = watcher(async () => answer());
    try {
      expect(await settled()).toBe(HEALTH_INTERVAL_MS);
      expect(assistant.state().machines[0]!.health!.problems).toEqual(["herdr_stopped", "no_agent"]);
      answer = () => { throw new MachineActionRequired("Connect this machine first", "connect"); };
      expect(await next()).toBe(HEALTH_INTERVAL_MS);
      expect(assistant.state().machines[0]!.health!.problems).toEqual(["not_connected"]);
    } finally { done(); }
  });


  it("leaves a Windows PC out: no check runs there, and no session is read or opened there", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-windows-"));
    const scripts: string[] = [];
    let listener: ((event: MachineEvent) => void) | undefined;
    const assistant = new Assistant(stateDir, {
      list: () => [machine], subscribe: (next) => { listener = next; return () => {}; }, retryNow: () => {}, windows: (id) => id === machine.id,
    }, async (_machine, script) => { scripts.push(script); return ""; }, { timer: () => () => {} });
    try {
      listener!({ type: "machines", machines: [machine] });
      await assistant.check(machine.id);
      expect(assistant.state().machines[0]!.health).toMatchObject({ problems: ["windows"], agents: [] });
      const refused = (promise: Promise<unknown>) => promise.then(() => null, (error: Error & { code?: string }) => [error.code, error.message]);
      const windows = ["windows", "Windows isn't supported by the Assistant yet"];
      expect(await refused(Promise.resolve().then(() => assistant.openSession({ machine: machine.id, folder: "~/app", brief: "b" })))).toEqual(windows);
      expect(await refused(Promise.resolve().then(() => assistant.peekSession({ machine: machine.id, pane: "p1" })))).toEqual(windows);
      expect(assistant.herdrSessions()).toEqual([]);
      expect(scripts).toEqual([]);
    } finally { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("checks the Assistant's session each time this PC's herdr answers, and not while it does not", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-revive-"));
    const checks: number[] = [];
    const heard: string[] = [];
    let listener: ((event: MachineEvent) => void) | undefined;
    const session = { check: async () => { checks.push(1); }, heard: (pane: string, status: string) => { heard.push(`${pane} ${status}`); }, info: () => null, stop: () => {} } as unknown as AssistantSession;
    const assistant = new Assistant(stateDir, { list: () => [], subscribe: (next) => { listener = next; return () => {}; }, retryNow: () => {} }, async () => "", { session, timer: () => () => {} });
    const local = (state: Machine["state"], panes: string[]): Machine => ({ id: LOCAL_MACHINE, name: "VM", kind: "local", enabled: true, state, error: null,
      snapshot: { panes: panes.map((pane_id) => ({ pane_id })) } as unknown as Machine["snapshot"] });
    try {
      listener!({ type: "machines", machines: [local("error", [])] });
      listener!({ type: "machines", machines: [local("connected", ["p1", "p2"])] });
      expect(checks).toHaveLength(1);
      // this PC's agent states reach the compaction watchdog; another PC's do not
      listener!({ type: "machine-message", machine_id: LOCAL_MACHINE, message: { type: "pane-status", pane_id: "p1", agent_status: "working" } } as MachineEvent);
      listener!({ type: "machine-message", machine_id: "m1", message: { type: "pane-status", pane_id: "p1", agent_status: "idle" } } as MachineEvent);
      expect(heard).toEqual(["p1 working"]);
    } finally { assistant.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("caps the back-off at five minutes", () => {
    expect([0, 1, 2, 3, 20].map((failures) => nextCheckDelay(HEALTH_INTERVAL_MS, failures))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
  });
});
