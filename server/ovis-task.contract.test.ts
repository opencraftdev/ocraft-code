import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Machine, MachineEvent } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Assistant, AssistantError, briefLabel, pastedBrief, type MachineBridge, type RunScript } from "./assistant.ts";
import type { AssistantPanes } from "./assistant-sessions.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";
import { cliRequest } from "./ovis-task-cli.ts";

/**
 * The ovis-task routes. No herdr is touched: health checks get a fixed answer, the Assistant's own
 * pane is a fake, and the delegation commands run against a fake machine and a fake bridge.
 */
const PROFILE: HerdrMachineProfile = { id: "ovis-task-test", label: "Test PC", enabled: true, target: { destination: "ovis-task-test.invalid" } };
const panes: AssistantPanes = {
  open: async () => { throw new Error("no herdr in this test"); }, start: async () => undefined, pane: async () => null,
  context: async () => null, send: async () => undefined, close: async () => undefined,
};

async function fixture(options: { assistant?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-task-")));
  const stateDir = join(root, "state");
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: options.assistant ?? true, assistantRun: async () => "herdr\nclaude\n", assistantPanes: panes, herdrProfiles: async () => [PROFILE] });
  const base = `http://127.0.0.1:${app.port}`;
  const close = () => { app.stop(); rmSync(root, { recursive: true, force: true }); };
  if (options.assistant === false) return { base, close, token: "", task: async () => new Response(null) };
  const token = (JSON.parse(readFileSync(join(stateDir, "assistant", "cli-token.json"), "utf8")) as { token: string }).token;
  const task = (name: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/ovis-task/${name}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { base, close, token, task };
}

const code = async (response: Response) => ({ status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code });

describe("ovis-task routes", () => {
  it("are not there on an Ovis that is not the Assistant VM", async () => {
    const { base, close } = await fixture({ assistant: false });
    try {
      expect((await fetch(`${base}/api/ovis-task/machines`)).status).toBe(404);
    } finally { close(); }
  });

  it("need the CLI token, from loopback, through no proxy and from no browser page", async () => {
    const { base, token, task, close } = await fixture();
    try {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect((await fetch(`${base}/api/ovis-task/machines`)).status).toBe(401);
      expect((await fetch(`${base}/api/ovis-task/machines`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await task("machines")).status).toBe(200);
      for (const header of [{ "x-forwarded-for": "100.64.0.9" }, { "x-forwarded-proto": "https" }, { "tailscale-user-login": "someone@example.com" }, { origin: base }] as Record<string, string>[]) {
        expect(await code(await task("machines", undefined, header))).toEqual({ status: 403, code: "loopback_only" });
      }
    } finally { close(); }
  });

  it("offers machines, sessions, graph, peek, send and open, and nothing of projects or tasks", async () => {
    const { task, close } = await fixture();
    try {
      expect(Array.isArray(await (await task("machines")).json())).toBe(true);
      expect((await task("machines", {})).status).toBe(405);
      expect(Array.isArray(await (await task("sessions")).json())).toBe(true);
      expect(await code(await task("sessions?machine=Nope"))).toEqual({ status: 404, code: "unknown_machine" });
      expect(await (await task("graph")).json()).toMatchObject({ machines: [{ name: "Test PC" }], projects: [], sessions: [] });
      expect((await task("graph", {})).status).toBe(405);
      expect(await code(await task("graph?machine=Nope"))).toEqual({ status: 404, code: "unknown_machine" });
      expect(await code(await task("peek", { machine: "Nope", pane: "p1" }))).toEqual({ status: 404, code: "unknown_machine" });
      expect(await code(await task("open", { machine: "Nope", folder: "~/x", brief: "b" }))).toEqual({ status: 404, code: "unknown_machine" });
      expect((await task("send")).status).toBe(405);
      for (const gone of ["projects", "list", "read", "grep", "git", "create", "show", "answer", "cancel", "approve"]) {
        expect({ gone, status: (await task(gone, {})).status }).toEqual({ gone, status: 404 });
      }
    } finally { close(); }
  });

  it("is what bin/ovis-task asks, with the pane's environment", async () => {
    const { base, token, close } = await fixture();
    try {
      const child = Bun.spawn([join(import.meta.dir, "..", "bin", "ovis-task"), "machines"], {
        env: { ...process.env, OVIS_BUN: process.execPath, OVIS_TASK_URL: base, OVIS_TASK_TOKEN: token }, stdout: "pipe", stderr: "pipe",
      });
      expect(JSON.parse(await new Response(child.stdout).text())).toBeArray();
      expect(await child.exited).toBe(0);
      const refused = Bun.spawn([join(import.meta.dir, "..", "bin", "ovis-task"), "peek", "Nope", "p1"], {
        env: { ...process.env, OVIS_BUN: process.execPath, OVIS_TASK_URL: base, OVIS_TASK_TOKEN: token }, stdout: "pipe", stderr: "pipe",
      });
      expect(await refused.exited).toBe(1);
      expect(await new Response(refused.stderr).text()).toContain("unknown_machine");
    } finally { close(); }
  });
});

describe("ovis-task's command line", () => {
  it("makes a request of each command, and a usage line of anything else", () => {
    expect(cliRequest(["machines"])).toEqual({ path: "machines" });
    expect("usage" in cliRequest(["machines", "x"])).toBe(true);
    expect(cliRequest(["sessions", "Air"])).toEqual({ path: "sessions?machine=Air" });
    expect(cliRequest(["graph"])).toEqual({ path: "graph" });
    expect(cliRequest(["graph", "muhammad macbook"])).toEqual({ path: "graph?machine=muhammad%20macbook" });
    expect("usage" in cliRequest(["graph", "a", "b"])).toBe(true);
    expect(cliRequest(["send", "Air", "w1:p1", "run", "the", "tests"])).toEqual({ path: "send", body: { machine: "Air", pane: "w1:p1", message: "run the tests" } });
    expect(cliRequest(["open", "Air", "~/app", "--agent", "codex", "--create", "Fix", "the", "login"])).toEqual({ path: "open", body: { machine: "Air", folder: "~/app", brief: "Fix the login", agent: "codex", create: true } });
    expect(cliRequest(["open", "Air", "~/app", "Fix it"])).toEqual({ path: "open", body: { machine: "Air", folder: "~/app", brief: "Fix it", create: false } });
    expect("usage" in cliRequest(["open", "Air", "~/app"])).toBe(true);
    expect("usage" in cliRequest(["open", "Air", "~/app", "--nope", "x"])).toBe(true);
    for (const gone of ["projects", "list", "create", "read", "approve"]) expect("usage" in cliRequest([gone, "x"])).toBe(true);
  });
});

/** sessions, peek, send and open against a fake machine (this test's shell, with a home of its own) and a fake bridge */
function delegation(options: { maxRunning?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-delegate-")));
  const home = join(root, "home");
  mkdirSync(join(home, "code", "app"), { recursive: true });
  const stateDir = join(root, "state");
  const panes: SessionSnapshot["panes"] = [];
  const snapshot = { panes, workspaces: [{ workspace_id: "w1", label: "app" }], tabs: [], agents: [], layouts: [], protocol: 22, version: "0" } as unknown as SessionSnapshot;
  const machine: Machine = { id: "m1", herdr_profile_id: "p1", name: "Laptop", kind: "ssh", target: { destination: "laptop.invalid" }, enabled: true, state: "connected", error: null, snapshot };
  const pane = (pane_id: string, agent_status: string, agent: string | null = "claude") => panes.push({ pane_id, workspace_id: "w1", tab_id: "t1", terminal_id: pane_id, focused: false, revision: 0, agent, agent_status, cwd: join(home, "code", "app") } as unknown as SessionSnapshot["panes"][number]);
  const calls: { path: string; body?: unknown; query?: Record<string, string> }[] = [];
  let made = 0;
  const bridge: MachineBridge = async (_machineId, path, request = {}) => {
    calls.push({ path, ...(request.body === undefined ? {} : { body: request.body }), ...(request.query ? { query: request.query } : {}) });
    if (path === "workspace/create") { made += 1; pane(`w${made + 1}:p1`, "idle"); return { workspace_id: `w${made + 1}`, pane_id: `w${made + 1}:p1`, agent_started: true }; }
    if (path === "pane/conversation") return { source: "claude-transcript", turns: [{ role: "assistant", parts: [{ kind: "text", text: "all green" }] }] };
    return { ok: true };
  };
  const run: RunScript = async (_machine, script) => {
    if (script.includes("status server")) return "herdr\nclaude\n";
    const child = Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString();
  };
  let listener: ((event: MachineEvent) => void) | undefined;
  const assistant = new Assistant(stateDir, { list: () => [machine], subscribe: (next) => { listener = next; return () => {}; }, retryNow: () => {} }, run, { bridge, timer: () => () => {} });
  listener!({ type: "machines", machines: [machine] });
  if (options.maxRunning) assistant.setMachine("m1", { maxRunning: options.maxRunning });
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error instanceof AssistantError ? error.code : String(error));
  return { assistant, home: realpathSync(home), root, stateDir, calls, pane, panes, refusal, done: () => { assistant.stop(); rmSync(root, { recursive: true, force: true }); } };
}

describe("delegating to herdr sessions", () => {
  it("lists, peeks and sends to a session, never to a working agent or a shell", async () => {
    const d = delegation();
    try {
      d.pane("w1:p1", "idle");
      d.pane("w1:p2", "working");
      d.pane("w1:p3", "unknown", null);
      const [listed] = d.assistant.herdrSessions() as { machine: string; workspaces: { panes: { pane: string; status: string }[] }[] }[];
      expect(listed!.workspaces[0]!.panes.map((pane) => [pane.pane, pane.status])).toEqual([["w1:p1", "idle"], ["w1:p2", "working"], ["w1:p3", "unknown"]]);
      expect(await d.assistant.peekSession({ machine: "Laptop", pane: "w1:p1" })).toMatchObject({ pane: "w1:p1", turns: [{ role: "assistant", text: "all green" }] });
      expect(await d.assistant.sendToSession({ machine: "Laptop", pane: "w1:p1", message: "run the tests" })).toEqual({ ok: true, machine: "Laptop", pane: "w1:p1" });
      expect(d.calls.slice(-2)).toEqual([
        { path: "pane/input", body: { pane_id: "w1:p1", text: pastedBrief("run the tests") } },
        { path: "pane/keys", body: { pane_id: "w1:p1", keys: ["Enter"] } },
      ]);
      expect(await d.refusal(d.assistant.sendToSession({ machine: "Laptop", pane: "w1:p2", message: "x" }))).toBe("pane_busy");
      expect(await d.refusal(d.assistant.sendToSession({ machine: "Laptop", pane: "w1:p3", message: "x" }))).toBe("no_agent");
      expect(await d.refusal(d.assistant.sendToSession({ machine: "Laptop", pane: "w9:p9", message: "x" }))).toBe("unknown_pane");
    } finally { d.done(); }
  });

  it("opens a session in a folder under home with a full-auto agent, named from the brief, and pastes the brief", async () => {
    const d = delegation();
    try {
      const brief = "Fix the login form so valid emails pass\nand add a test";
      const opened = await d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief, agent: "codex" });
      expect(opened).toMatchObject({ ok: true, pane: "w2:p1", folder: join(d.home, "code", "app"), agent: "codex" });
      // the bridge adds the full-auto flag (agent-launch.ts SKIP_PERMISSIONS); focus is never asked for
      expect(d.calls).toEqual([
        { path: "workspace/create", body: { cwd: join(d.home, "code", "app"), label: "Fix the login form so", agent: { kind: "codex" } } },
        { path: "pane/input", body: { pane_id: "w2:p1", text: pastedBrief(brief) } },
        { path: "pane/keys", body: { pane_id: "w2:p1", keys: ["Enter"] } },
      ]);
      expect(JSON.stringify(d.calls)).not.toMatch(/focus|takeover/);
      // remembered as the Assistant's, privately
      const [listed] = d.assistant.herdrSessions("Laptop") as { workspaces: { panes: { pane: string; assistant?: true }[] }[] }[];
      expect(listed!.workspaces.flatMap((workspace) => workspace.panes).find((pane) => pane.pane === "w2:p1")?.assistant).toBe(true);
      expect(JSON.parse(readFileSync(join(d.stateDir, "assistant", "opened.json"), "utf8"))).toMatchObject([{ machine: "m1", pane: "w2:p1" }]);
      expect(statSync(join(d.stateDir, "assistant", "opened.json")).mode & 0o777).toBe(0o600);
      expect(briefLabel("One two three four five six")).toBe("One two three four five");
    } finally { d.done(); }
  });

  it("refuses a folder outside home, home itself, a missing one without --create, and a path with ..", async () => {
    const d = delegation();
    try {
      mkdirSync(join(d.root, "outside"));
      symlinkSync(join(d.root, "outside"), join(d.home, "link-out"));
      const open = (folder: string, create = false) => d.refusal(d.assistant.openSession({ machine: "Laptop", folder, brief: "Do it", create }));
      for (const [folder, expected] of [
        ["~", "invalid_path"], ["~/", "home"], [d.home, "home"], [join(d.root, "outside"), "outside_home"], ["~/link-out", "outside_home"], ["/", "outside_home"],
        ["~/missing", "missing"], ["~/code/../..", "invalid_path"], ["relative/path", "invalid_path"], ["~other/x", "invalid_path"],
      ] as const) expect({ folder, code: await open(folder) }).toEqual({ folder, code: expected });
      // --create makes nothing outside home, not even through a symlink
      expect(await open(join(d.root, "outside", "new"), true)).toBe("outside_home");
      expect(await open("~/link-out/new", true)).toBe("outside_home");
      expect(existsSync(join(d.root, "outside", "new"))).toBe(false);
      expect(await d.refusal(d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief: "" }))).toBe("invalid_brief");
      expect(await d.refusal(d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief: "x", agent: "gemini" }))).toBe("invalid_agent");
      expect(d.calls).toEqual([]);
    } finally { d.done(); }
  });

  it("with --create, makes the folder and git inits it", async () => {
    const d = delegation();
    try {
      expect(await d.assistant.openSession({ machine: "Laptop", folder: "~/new/project", brief: "Start it", create: true })).toMatchObject({ folder: join(d.home, "new", "project") });
      expect(existsSync(join(d.home, "new", "project", ".git"))).toBe(true);
      // an existing repository is left as it is
      expect(await d.assistant.openSession({ machine: "Laptop", folder: "~/new/project", brief: "Again", create: true })).toMatchObject({ ok: true });
    } finally { d.done(); }
  });

  it("refuses past the machine's Max running sessions the Assistant opened that work", async () => {
    const d = delegation({ maxRunning: 2 });
    try {
      d.pane("w1:p1", "working");
      await d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief: "One" });
      await d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief: "Two" });
      // a working pane the user opened does not count; the two just opened do
      expect(await d.refusal(d.assistant.openSession({ machine: "Laptop", folder: "~/code/app", brief: "Three" }))).toBe("limit_reached");
      expect(d.calls.filter((call) => call.path === "workspace/create")).toHaveLength(2);
    } finally { d.done(); }
  });
});
