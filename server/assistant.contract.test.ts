import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantProject, AssistantState } from "../shared/assistant.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
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
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
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
const sh = (args: string[], cwd: string) => Bun.spawnSync(args, { cwd, stdout: "ignore", stderr: "ignore" });

/**
 * A machine that is this test's own shell, with a home folder of its own. Only folder checks run in
 * it: a health check gets a fixed answer and a fix is only recorded, so no test ever runs herdr.
 */
function fixtureMachine(root: string) {
  const home = join(root, "parent", "home");
  mkdirSync(home, { recursive: true });
  const scripts: string[] = [];
  const run: RunScript = async (_machine, script) => {
    scripts.push(script);
    if (!script.includes("rev-parse")) return script.includes("status server") && !script.includes("nohup") ? "herdr\nclaude\n" : "";
    const child = Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString();
  };
  return { home: realpathSync(home), scripts, run };
}

function repository(at: string, remote?: string): string {
  mkdirSync(at, { recursive: true });
  sh(["git", "init", "-q"], at);
  if (remote) sh(["git", "remote", "add", "origin", remote], at);
  return realpathSync(at);
}

async function assistantServer(stateDir: string, run: RunScript) {
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: true, assistantRun: run, herdrProfiles: async () => [PROFILE] });
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

describe("Assistant machines and projects", () => {
  it("answers nowhere on an Ovis that is not the Assistant VM", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-off-"));
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: false });
    try {
      expect((await fetch(`http://127.0.0.1:${app.port}/api/assistant`)).status).toBe(404);
    } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("lists herdr's saved machines with their health and Max running tasks", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-machines-"));
    const { run } = fixtureMachine(root);
    const { app, send, state, machine } = await assistantServer(join(root, "state"), run);
    try {
      expect(machine).toMatchObject({ name: "Test PC", maxRunning: 3 });
      const deadline = Date.now() + 5000;
      while ((await state()).machines[0]!.health === null && Date.now() < deadline) await Bun.sleep(20);
      expect((await state()).machines[0]!.health).toMatchObject({ problems: [], agents: ["claude"] });
      expect((await send(`/machines/${machine.id}`, "PATCH", { maxRunning: 0 })).status).toBe(400);
      expect((await send(`/machines/${machine.id}`, "PATCH", { maxRunning: 5 })).status).toBe(200);
      expect((await state()).machines[0]!.maxRunning).toBe(5);
      expect(JSON.parse(readFileSync(join(root, "state", "assistant", "machines.json"), "utf8"))).toEqual({ [machine.id]: { maxRunning: 5 } });
      expect((await send("/machines/not-a-machine", "PATCH", { maxRunning: 2 })).status).toBe(404);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("checks a folder on the machine before it becomes a project", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-projects-"));
    const { home, run } = fixtureMachine(root);
    const plain = join(root, "plain");
    mkdirSync(plain);
    const local = repository(join(home, "local-repo"));
    const github = repository(join(root, "github-repo"), "git@github.com:example/repo.git");
    mkdirSync(join(github, "sub"));
    const { app, send, state, machine } = await assistantServer(join(root, "state"), run);
    const add = (path: string) => send("/projects", "POST", { machine: machine.id, path });
    try {
      for (const [path, code] of [
        ["/", "root"], ["~", "home"], [home, "home"], [join(root, "parent"), "home_parent"], [root, "home_parent"],
        [plain, "not_git"], [join(github, "sub"), "not_git"], [join(root, "missing"), "missing"],
        ["relative/folder", "invalid_path"], ["~other/folder", "invalid_path"],
      ] as const) {
        const response = await add(path);
        expect({ path, status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }).toEqual({ path, status: 400, code });
      }
      expect((await send("/projects", "POST", { machine: "nope", path: local })).status).toBe(404);

      const first = await add("~/local-repo");
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ id: "local-repo", machine: machine.id, path: local, mergeMode: "local", defaultAgent: "claude" });
      expect((await add(local)).status).toBe(409);
      const second = (await (await add(github)).json()) as AssistantProject;
      expect(second).toMatchObject({ id: "github-repo", path: github, mergeMode: "pr" });

      expect((await send(`/projects/${second.id}`, "PATCH", { mergeMode: "local", defaultAgent: "codex" })).status).toBe(200);
      expect((await send(`/projects/${second.id}`, "PATCH", { mergeMode: "squash" })).status).toBe(400);
      expect((await send("/projects/local-repo", "DELETE")).status).toBe(200);
      expect((await send("/projects/local-repo", "DELETE")).status).toBe(404);
      expect((await state()).projects).toEqual([{ ...second, mergeMode: "local", defaultAgent: "codex" }]);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps projects in a private file that survives a restart, written whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-state-"));
    const { home, run } = fixtureMachine(root);
    repository(join(home, "repo"));
    const stateDir = join(root, "state");
    const first = await assistantServer(stateDir, run);
    try {
      expect((await first.send("/projects", "POST", { machine: first.machine.id, path: "~/repo" })).status).toBe(201);
    } finally { first.app.stop(); }
    const directory = join(stateDir, "assistant");
    expect(statSync(join(directory, "projects.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).sort()).toEqual(["cli-token.json", "projects.json"]);
    expect(statSync(join(directory, "cli-token.json")).mode & 0o777).toBe(0o600);
    const second = await assistantServer(stateDir, run);
    try {
      expect((await second.state()).projects.map((project) => project.id)).toEqual(["repo"]);
    } finally { second.app.stop(); }
    // a file that is not JSON is set aside, and the server starts without it
    writeFileSync(join(directory, "projects.json"), "\0\0\0");
    const third = await assistantServer(stateDir, run);
    try {
      expect((await third.state()).projects).toEqual([]);
      expect(readdirSync(directory).some((name) => name.startsWith("projects.json.corrupt-"))).toBe(true);
    } finally { third.app.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("runs a fix only on an explicit POST from this app's page", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-assistant-fix-"));
    const { scripts, run } = fixtureMachine(root);
    const { app, send, machine } = await assistantServer(join(root, "state"), run);
    const fixes = () => scripts.filter((script) => script.includes("nohup")).length;
    try {
      expect((await send(`/machines/${machine.id}/fix`, "GET")).status).toBe(405);
      expect((await send(`/machines/${machine.id}/fix`, "POST", { fix: "start_herdr" }, false)).status).toBe(403);
      expect((await send(`/machines/${machine.id}/fix`, "POST", { fix: "reboot" })).status).toBe(400);
      // a project write without a page's Origin is refused the same way (the ovis-task CLI sends none)
      expect((await send("/projects", "POST", { machine: machine.id, path: "/" }, false)).status).toBe(403);
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

  it("caps the back-off at five minutes", () => {
    expect([0, 1, 2, 3, 20].map((failures) => nextCheckDelay(HEALTH_INTERVAL_MS, failures))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
  });
});
