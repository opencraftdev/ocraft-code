import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionGraph } from "../shared/assistant.ts";
import { LOCAL_MACHINE, type Machine } from "../shared/machines.ts";
import type { AgentStatus, ConversationResponse, HerdrPane } from "../shared/protocol.ts";
import { AssistantGraph, GRAPH_SWEEP_MS, GRAPH_WRITE_DELAY_MS, touchedFiles } from "./assistant-graph.ts";
import type { MachineBridge, RunScript } from "./assistant.ts";

const pane = (pane_id: string, agent: string | null, agent_status: AgentStatus | null, cwd: string): HerdrPane =>
  ({ pane_id, workspace_id: pane_id.split(":")[0]!, agent, agent_status, cwd, terminal_title_stripped: `${agent ?? "shell"} in ${cwd}` }) as unknown as HerdrPane;
const machine = (id: string, name: string, panes: HerdrPane[], extra: Partial<Machine> = {}): Machine => ({
  id, name, kind: id === LOCAL_MACHINE ? "local" : "ssh", enabled: true, state: "connected", error: null,
  ...(id === LOCAL_MACHINE ? {} : { target: { destination: `me@${id}.tail1.ts.net` } }),
  snapshot: { workspaces: [...new Set(panes.map((item) => item.workspace_id))].map((workspace_id) => ({ workspace_id, label: `ws ${workspace_id}` })), panes } as unknown as Machine["snapshot"],
  ...extra,
});
const tool = (name: string, input: unknown) => ({ kind: "tool" as const, name, summary: "", output: "", input: typeof input === "string" ? input : JSON.stringify(input) });
const conversation = (...parts: ReturnType<typeof tool>[]): ConversationResponse => ({ turns: [{ role: "assistant", parts }] }) as unknown as ConversationResponse;

/** machines and their bridges as these tests set them; no herdr, no SSH */
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-graph-"));
  const machines: Machine[] = [];
  /** per `machine/pane`: the bridge's answers by path; an Error throws */
  const answers = new Map<string, Record<string, unknown>>();
  const asked: string[] = [];
  const scripts: string[] = [];
  const remotes: Record<string, string> = {};
  const bridge: MachineBridge = async (machineId, path, request) => {
    asked.push(`${machineId}/${request?.query?.pane_id} ${path}`);
    const answer = answers.get(`${machineId}/${request?.query?.pane_id}`)?.[path];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("no answer");
    return answer;
  };
  const run: RunScript = async (_machine, script) => {
    scripts.push(script);
    const root = Object.keys(remotes).find((path) => script.includes(`'${path}'`));
    return root ? `${remotes[root]}\n` : "";
  };
  const scheduled: { ms: number; fire: () => void }[] = [];
  let now = 5_000;
  const graph = new AssistantGraph(join(stateDir, "assistant", "agent", "graph.json"), {
    machines: () => machines, windows: (id) => id === "win", ownPane: () => "w9:p1",
    opened: (machineId, paneId) => machineId === "air" && paneId === "w1:p2", bridge, run,
    now: () => now, timer: (fire, ms) => { const item = { ms, fire }; scheduled.push(item); return () => { scheduled.splice(scheduled.indexOf(item), 1); }; },
  });
  const repo = (root: string, branch: string, files: string[]) => ({ repository: { root, branch, head: "abc", detached: false, unborn: false }, files: files.map((path) => ({ path, status: "modified" })) });
  /** the pending write fires, the file is read back */
  const written = (): SessionGraph => {
    const write = scheduled.find((item) => item.ms === GRAPH_WRITE_DELAY_MS);
    write?.fire();
    scheduled.splice(scheduled.indexOf(write!), 1);
    return JSON.parse(readFileSync(graph.path, "utf8")) as SessionGraph;
  };
  return { stateDir, machines, answers, asked, scripts, remotes, graph, scheduled, repo, written, advance: (ms: number) => { now += ms; }, done: () => { graph.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}

describe("the files a session touched", () => {
  it("are the paths its edit tools named, newest first, never its reads", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/new.ts\n+z\n*** End Patch";
    expect(touchedFiles(conversation(
      tool("Read", { file_path: "/r/read-only.ts" }),
      tool("Edit", { file_path: "/r/edited.ts", old_string: "a", new_string: "b" }),
      tool("Grep", { pattern: "x", path: "/r" }),
      tool("Write", { file_path: "/r/written.ts", content: "" }),
      tool("MultiEdit", { file_path: "/r/edited.ts", edits: [] }),
      tool("NotebookEdit", { notebook_path: "/r/n.ipynb" }),
      tool("apply_patch", patch),
      tool("Bash", { command: "cat /r/other.ts" }),
    ))).toEqual(["src/new.ts", "src/a.ts", "/r/n.ipynb", "/r/edited.ts", "/r/written.ts"]);
    const many = conversation(...Array.from({ length: 70 }, (_, index) => tool("Write", { file_path: `/f${index}` })));
    expect(touchedFiles(many)).toHaveLength(50);
    expect(touchedFiles(many)[0]).toBe("/f69");
  });
});

describe("the session graph", () => {
  it("lists the active agent sessions only, grouped into projects by remote, else by repo root", async () => {
    const f = fixture();
    try {
      f.machines.push(
        machine("air", "Air", [pane("w1:p1", "claude", "working", "/home/me/ovis"), pane("w1:p2", "codex", "idle", "/home/me/ovis"), pane("w1:p3", null, null, "/home/me"), pane("w2:p1", "claude", "done", "/home/me/scratch")]),
        machine("mini", "Mini", [pane("w1:p1", "claude", "idle", "/Users/me/code/ovis")]),
        machine("win", "Windows PC", [pane("w1:p1", "claude", "idle", "C:/x")]),
        machine("off", "Off", [pane("w1:p1", "claude", "idle", "/x")], { state: "disconnected" }),
        // this VM: the Assistant's own pane left out
        machine(LOCAL_MACHINE, "VM", [pane("w9:p1", "claude", "idle", "/state/assistant/agent")]),
      );
      f.answers.set("air/w1:p1", {
        "workspace/diff/files": f.repo("/home/me/ovis", "feat/x", ["server/a.ts"]),
        "pane/prs": { prs: [{ number: 7, url: "https://github.com/o/ovis/pull/7", title: "X", state: "open", repo: "ovis", branch: "feat/x", additions: 1, deletions: 0, checks: null }] },
        "pane/conversation": conversation(tool("Read", { file_path: "/home/me/ovis/README.md" }), tool("Edit", { file_path: "/home/me/ovis/server/a.ts" })),
      });
      f.answers.set("air/w1:p2", { "workspace/diff/files": f.repo("/home/me/ovis", "main", []) });
      f.answers.set("air/w2:p1", { "workspace/diff/files": f.repo("/home/me/scratch", "main", []) });
      f.answers.set("mini/w1:p1", { "workspace/diff/files": f.repo("/Users/me/code/ovis", "main", []) });
      f.remotes["/home/me/ovis"] = "git@github.com:o/ovis.git";
      f.remotes["/Users/me/code/ovis"] = "git@github.com:o/ovis.git";
      f.graph.start();
      await f.graph.settled();
      const graph = f.written();
      expect(graph.sessions.map((session) => session.key)).toEqual(["Air/w1:p1", "Air/w1:p2", "Air/w2:p1", "Mini/w1:p1"]);
      expect(graph.machines.map((item) => [item.name, item.host, item.state])).toContainEqual(["Air", "air", "connected"]);
      expect(graph.sessions[0]).toEqual({
        key: "Air/w1:p1", machine: "Air", host: "air", workspace: "ws w1", pane: "w1:p1", agent: "claude", state: "working",
        title: "claude in /home/me/ovis", folder: "/home/me/ovis", repo_root: "/home/me/ovis", branch: "feat/x", head: "abc",
        remote: "git@github.com:o/ovis.git", prs: [{ number: 7, url: "https://github.com/o/ovis/pull/7", title: "X", state: "open" }],
        files: { changed: ["server/a.ts"], touched: ["/home/me/ovis/server/a.ts"] }, assistant_opened: false, seen_at: 5_000,
      });
      expect(graph.sessions[1]!.assistant_opened).toBe(true);
      expect(graph.projects).toEqual([
        { repo: "ovis", remote: "git@github.com:o/ovis.git", roots: { Air: "/home/me/ovis", Mini: "/Users/me/code/ovis" }, sessions: ["Air/w1:p1", "Air/w1:p2", "Mini/w1:p1"] },
        { repo: "scratch", remote: null, roots: { Air: "/home/me/scratch" }, sessions: ["Air/w2:p1"] },
      ]);
      // one remote lookup per repo root
      expect(f.scripts.filter((script) => script.includes("'/home/me/ovis'"))).toHaveLength(1);
      // one machine's part
      expect(f.graph.build("mini").sessions.map((session) => session.key)).toEqual(["Mini/w1:p1"]);
      // the file is replaced whole: no temporary file left beside it
      expect(readdirSync(join(f.stateDir, "assistant", "agent"))).toEqual(["graph.json"]);
    } finally { f.done(); }
  });

  it("drops a closed pane, keeps a pane's last values when its reads fail, and reads again when its agent comes to rest", async () => {
    const f = fixture();
    try {
      f.machines.push(machine("air", "Air", [pane("w1:p1", "claude", "working", "/r"), pane("w1:p2", "claude", "idle", "/r")]));
      f.answers.set("air/w1:p1", { "workspace/diff/files": f.repo("/r", "main", ["a.ts"]), "pane/prs": { prs: [] }, "pane/conversation": conversation(tool("Write", { file_path: "/r/a.ts" })) });
      f.answers.set("air/w1:p2", { "workspace/diff/files": f.repo("/r", "main", []) });
      f.graph.start();
      await f.graph.settled();
      expect(f.written().sessions.map((session) => session.key)).toEqual(["Air/w1:p1", "Air/w1:p2"]);

      // every read fails now: the last values stay
      f.answers.set("air/w1:p1", { "workspace/diff/files": new Error("offline"), "pane/prs": new Error("offline"), "pane/conversation": new Error("offline") });
      f.advance(1_000);
      f.asked.length = 0;
      // its agent comes to rest: read again (heard between snapshots)
      f.graph.heard("air", "w1:p1", "idle");
      await f.graph.settled();
      expect(f.asked.filter((line) => line.startsWith("air/w1:p1"))).toHaveLength(3);
      const kept = f.graph.build().sessions[0]!;
      expect(kept).toMatchObject({ repo_root: "/r", files: { changed: ["a.ts"], touched: ["/r/a.ts"] }, seen_at: 5_000 });

      // a status that did not change reads nothing; a snapshot showing working then done does
      f.asked.length = 0;
      f.graph.changed();
      await f.graph.settled();
      expect(f.asked).toEqual([]);
      f.machines[0]!.snapshot!.panes[1] = pane("w1:p2", "claude", "working", "/r");
      f.graph.changed();
      f.machines[0]!.snapshot!.panes[1] = pane("w1:p2", "claude", "done", "/r");
      f.graph.changed();
      await f.graph.settled();
      expect(f.asked.filter((line) => line.startsWith("air/w1:p2"))).toHaveLength(3);

      // the pane closes: gone at the next write
      f.machines[0]!.snapshot!.panes.splice(0, 1);
      f.graph.changed();
      expect(f.written().sessions.map((session) => session.key)).toEqual(["Air/w1:p2"]);

      // the sweep reads every pane again
      f.asked.length = 0;
      f.scheduled.find((item) => item.ms === GRAPH_SWEEP_MS)!.fire();
      await f.graph.settled();
      expect(f.asked.filter((line) => line.startsWith("air/w1:p2"))).toHaveLength(3);
    } finally { f.done(); }
  });
});
