import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantProject, AssistantState } from "../shared/assistant.ts";
import type { RunScript } from "./assistant.ts";
import type { AssistantPanes } from "./assistant-sessions.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";
import { createServer } from "./index.ts";
import { cliRequest } from "./ovis-task-cli.ts";
import { gitArgumentFault } from "./ovis-task.ts";

/**
 * The ovis-task routes against a machine that is this test's own shell: every read script runs
 * there for real, in a temporary folder. No herdr is touched: health checks get a fixed answer and
 * Assistant panes are fakes.
 */
const PROFILE: HerdrMachineProfile = { id: "ovis-task-test", label: "Test PC", enabled: true, target: { destination: "ovis-task-test.invalid" } };
const run: RunScript = async (_machine, script) => {
  if (script.includes("status server")) return "herdr\nclaude\n";
  const child = Bun.spawnSync(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString();
};
const panes: AssistantPanes = { open: async () => { throw new Error("no herdr in this test"); }, read: async () => ({ turns: [] }), close: async () => undefined, alive: async () => true };

async function fixture(options: { assistant?: boolean; projects?: unknown } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-task-")));
  const stateDir = join(root, "state");
  if (options.projects) {
    mkdirSync(join(stateDir, "assistant"), { recursive: true });
    writeFileSync(join(stateDir, "assistant", "projects.json"), JSON.stringify(options.projects));
  }
  const project = join(root, "repo");
  mkdirSync(join(project, "src"), { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "T"]]) Bun.spawnSync(["git", ...args], { cwd: project });
  writeFileSync(join(project, "src", "a.ts"), "export const answer = 42;\n");
  Bun.spawnSync(["git", "add", "."], { cwd: project });
  Bun.spawnSync(["git", "commit", "-q", "-m", "first"], { cwd: project });
  writeFileSync(join(root, "secret.txt"), "outside the project\n");
  symlinkSync(join(root, "secret.txt"), join(project, "link-out"));
  symlinkSync(root, join(project, "dir-out"));

  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, assistant: options.assistant ?? true, assistantRun: run, assistantPanes: panes, herdrProfiles: async () => [PROFILE] });
  const base = `http://127.0.0.1:${app.port}`;
  const state = async () => (await (await fetch(`${base}/api/assistant`)).json()) as AssistantState;
  const close = () => { app.stop(); rmSync(root, { recursive: true, force: true }); };
  if (options.assistant === false) return { root, base, close, token: "", task: async () => new Response(null), project };
  const deadline = Date.now() + 5000;
  while ((await state()).machines.length === 0 && Date.now() < deadline) await Bun.sleep(20);
  const machine = (await state()).machines[0]!;
  if (!options.projects) {
    const added = await fetch(`${base}/api/assistant/projects`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ machine: machine.id, path: project }) });
    expect(added.status).toBe(201);
  }
  const token = (JSON.parse(readFileSync(join(stateDir, "assistant", "cli-token.json"), "utf8")) as { token: string }).token;
  const task = (name: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/ovis-task/${name}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, base, close, token, task, project, machine };
}

const answer = async (response: Response) => ({ status: response.status, ...(await response.json()) as { output?: string; truncated?: boolean; error?: { code: string } } });
const code = async (response: Response) => ({ status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code });

describe("ovis-task routes", () => {
  it("are not there on an Ovis that is not the Assistant VM", async () => {
    const { base, close } = await fixture({ assistant: false });
    try {
      expect((await fetch(`${base}/api/ovis-task/projects`)).status).toBe(404);
    } finally { close(); }
  });

  it("need the CLI token, from loopback, through no proxy and from no browser page", async () => {
    const { base, token, task, close } = await fixture();
    try {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect((await fetch(`${base}/api/ovis-task/projects`)).status).toBe(401);
      expect((await fetch(`${base}/api/ovis-task/projects`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await task("projects")).status).toBe(200);
      for (const header of [{ "x-forwarded-for": "100.64.0.9" }, { "x-forwarded-proto": "https" }, { "tailscale-user-login": "someone@example.com" }, { origin: base }] as Record<string, string>[]) {
        expect(await code(await task("projects", undefined, header))).toEqual({ status: 403, code: "loopback_only" });
      }
    } finally { close(); }
  });

  it("lists projects and an empty task list, and offers no way to add a project", async () => {
    const { task, project, close } = await fixture();
    try {
      expect(await (await task("projects")).json()).toEqual([{ id: "repo", path: project, mergeMode: "local", defaultAgent: "claude", machine: "Test PC" }]);
      expect(await (await task("list")).json()).toEqual([]);
      expect((await task("projects", { id: "x", path: "/" })).status).toBe(405);
      expect(await code(await task("create", {}))).toEqual({ status: 404, code: "unknown_project" });
      expect(await code(await task("create", { project: "repo", title: "Fix it", brief: "" }))).toEqual({ status: 400, code: "invalid_brief" });
      expect(await code(await task("list?status=nope"))).toEqual({ status: 400, code: "invalid_status" });
      // the Assistant never approves: only the user does, in the app
      expect(await code(await task("approve", { id: "1" }))).toEqual({ status: 403, code: "ui_only" });
    } finally { close(); }
  });

  it("cannot approve a task with the CLI token, through its own routes or the app's", async () => {
    const { base, token, task, close } = await fixture();
    try {
      expect(await code(await task("approve", { id: "1" }))).toEqual({ status: 403, code: "ui_only" });
      expect(cliRequest(["approve", "1"])).toEqual({ refused: "ovis-task approve is refused: only the user approves a task, in the app" });
      // the app's Approve takes a browser page's Origin, which ovis-task never sends
      for (const action of ["approve", "dismiss"]) {
        const response = await fetch(`${base}/api/assistant/tasks/1/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
        expect(await code(response)).toEqual({ status: 403, code: "browser_only" });
      }
    } finally { close(); }
  });

  it("reads inside the project and refuses every way out of it", async () => {
    const { task, close } = await fixture();
    try {
      expect(await answer(await task("read", { project: "repo", path: "src/a.ts" }))).toEqual({ status: 200, output: "export const answer = 42;\n", truncated: false });
      expect(await answer(await task("read", { project: "repo", path: "src/../src/a.ts" }))).toMatchObject({ status: 200, output: "export const answer = 42;\n" });
      for (const [path, refusal] of [
        ["../secret.txt", "outside_project"],
        ["src/../../secret.txt", "outside_project"],
        ["link-out", "outside_project"],
        ["dir-out/secret.txt", "outside_project"],
        ["/etc/passwd", "absolute_path"],
        ["~/secret.txt", "absolute_path"],
        ["src/missing.ts", "not_found"],
        ["src", "not_a_file"],
        ["src/a.ts\nx", "invalid_path"],
      ] as const) {
        expect({ path, ...(await code(await task("read", { project: "repo", path }))) }).toMatchObject({ path, code: refusal });
      }
      expect(await code(await task("read", { project: "nope", path: "src/a.ts" }))).toEqual({ status: 404, code: "unknown_project" });
    } finally { close(); }
  });

  it("greps inside the project only", async () => {
    const { task, close } = await fixture();
    try {
      expect(await answer(await task("grep", { project: "repo", pattern: "answer" }))).toMatchObject({ status: 200, output: "./src/a.ts:1:export const answer = 42;\n" });
      expect(await answer(await task("grep", { project: "repo", pattern: "answer", path: "src" }))).toMatchObject({ output: "./src/a.ts:1:export const answer = 42;\n" });
      // a symlinked folder below is not followed, and the secret it leads to is not read
      expect((await answer(await task("grep", { project: "repo", pattern: "outside" }))).output).toBe("");
      expect((await code(await task("grep", { project: "repo", pattern: "outside", path: ".." }))).code).toBe("outside_project");
      expect((await code(await task("grep", { project: "repo", pattern: "outside", path: "dir-out" }))).code).toBe("outside_project");
      expect((await code(await task("grep", { project: "repo", pattern: "x", path: "/tmp" }))).code).toBe("absolute_path");
      expect((await code(await task("grep", { project: "repo", pattern: "" }))).code).toBe("invalid_pattern");
    } finally { close(); }
  });

  it("runs only git log, diff, status and show, without options that write, run or leave the repository", async () => {
    const { task, root, close } = await fixture();
    try {
      expect(await answer(await task("git", { project: "repo", command: "log", args: ["--oneline"] }))).toMatchObject({ status: 200 });
      expect((await answer(await task("git", { project: "repo", command: "log", args: ["--format=%s"] }))).output).toBe("first\n");
      expect((await answer(await task("git", { project: "repo", command: "show", args: ["HEAD:src/a.ts"] }))).output).toBe("export const answer = 42;\n");
      expect((await task("git", { project: "repo", command: "status", args: ["--short"] })).status).toBe(200);
      for (const command of ["push", "config", "-c", "checkout"]) {
        expect((await code(await task("git", { project: "repo", command, args: [] }))).code).toBe("invalid_git_command");
      }
      const written = join(root, "written");
      for (const args of [
        [`--output=${written}`], ["--output", written], [`--out=${written}`], ["-c", "core.pager=touch x"], ["-C", root],
        ["--exec=touch x"], ["--upload-pack=touch x"], ["--ext-diff"], ["--no-index", "../secret.txt", "src/a.ts"],
        ["-O/etc/passwd"], ["-pO/etc/passwd"], [`--git-dir=${root}`], [`--work-tree=${root}`], ["--textconv"],
      ]) {
        expect({ args, ...(await code(await task("git", { project: "repo", command: "diff", args }))) }).toMatchObject({ args, code: "invalid_git_argument" });
      }
      expect(() => readFileSync(written)).toThrow();
    } finally { close(); }
  });

  it("refuses a project whose machine left herdr's catalog, and one removed", async () => {
    const stray: AssistantProject = { id: "stray", machine: "not-a-machine", path: "/tmp", mergeMode: "local", defaultAgent: "claude" };
    const { task, close } = await fixture({ projects: [stray] });
    try {
      expect(await code(await task("read", { project: "stray", path: "x" }))).toEqual({ status: 404, code: "unknown_machine" });
    } finally { close(); }
    const second = await fixture();
    try {
      expect((await fetch(`${second.base}/api/assistant/projects/repo`, { method: "DELETE", headers: { origin: second.base } })).status).toBe(200);
      expect(await code(await second.task("read", { project: "repo", path: "src/a.ts" }))).toEqual({ status: 404, code: "unknown_project" });
    } finally { second.close(); }
  });

  it("is what bin/ovis-task asks, with the pane's environment", async () => {
    const { base, token, close } = await fixture();
    try {
      const child = Bun.spawn([join(import.meta.dir, "..", "bin", "ovis-task"), "read", "repo", "src/a.ts"], {
        env: { ...process.env, OVIS_BUN: process.execPath, OVIS_TASK_URL: base, OVIS_TASK_TOKEN: token }, stdout: "pipe", stderr: "pipe",
      });
      expect(await new Response(child.stdout).text()).toBe("export const answer = 42;\n");
      expect(await child.exited).toBe(0);
      const refused = Bun.spawn([join(import.meta.dir, "..", "bin", "ovis-task"), "read", "repo", "../secret.txt"], {
        env: { ...process.env, OVIS_BUN: process.execPath, OVIS_TASK_URL: base, OVIS_TASK_TOKEN: token }, stdout: "pipe", stderr: "pipe",
      });
      expect(await refused.exited).toBe(1);
      expect(await new Response(refused.stderr).text()).toContain("outside_project");
    } finally { close(); }
  });
});

describe("ovis-task's command line and git checks", () => {
  it("makes a request of each command, and a usage line of anything else", () => {
    expect(cliRequest(["projects"])).toEqual({ path: "projects" });
    expect(cliRequest(["grep", "repo", "TODO", "src"])).toEqual({ path: "grep", body: { project: "repo", pattern: "TODO", path: "src" } });
    expect(cliRequest(["git", "repo", "log", "-5"])).toEqual({ path: "git", body: { project: "repo", command: "log", args: ["-5"] } });
    expect("usage" in cliRequest(["read", "repo"])).toBe(true);
    expect("refused" in cliRequest(["approve", "1"])).toBe(true);
    expect("usage" in cliRequest(["merge", "1"])).toBe(true);
  });

  it("lets ordinary options through", () => {
    for (const arg of ["--oneline", "--stat", "-5", "-p", "--name-only", "--format=%h %s", "HEAD~2..HEAD", "--", "src/a.ts", "--no-ext-diff"]) expect({ arg, fault: gitArgumentFault(arg) }).toEqual({ arg, fault: false });
  });
});
