import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { forkCodex } from "./codex-fork.ts";
import { nativeRecordHash } from "./conversation-fork-points.ts";
import { parseCodexTranscript } from "./codex.ts";

it("the Claude SDK creates a separate file at the chosen message in the source profile", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-claude-fork-")));
  try {
    const cwd = join(root, "project"), home = join(root, "claude"); mkdirSync(cwd);
    const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
    const sessionId = randomUUID(), first = randomUUID(), answer = randomUUID();
    const records = [
      { type: "user", uuid: first, parentUuid: null, sessionId, cwd, timestamp: "2026-10-30T00:00:00Z", message: { role: "user", content: "First synthetic request" } },
      { type: "assistant", uuid: answer, parentUuid: first, sessionId, cwd, timestamp: "2026-10-30T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "First synthetic answer" }] } },
      { type: "user", uuid: randomUUID(), parentUuid: answer, sessionId, cwd, timestamp: "2026-10-30T00:00:02Z", message: { role: "user", content: "Excluded later request" } },
    ];
    const source = join(project, `${sessionId}.jsonl`); writeFileSync(source, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const before = readFileSync(source);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "claude-fork-worker.ts"), sessionId, cwd, answer], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_PROJECT_DIR_NAME: basename(project) }, stdout: "pipe", stderr: "ignore" });
    const result = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(0);
    expect(result.sessionId).not.toBe(sessionId);
    const copied = readFileSync(join(project, `${result.sessionId}.jsonl`), "utf8");
    expect(copied).toContain("First synthetic answer"); expect(copied).not.toContain("Excluded later request");
    expect(readFileSync(source).equals(before)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

// Native protocol validation only: an isolated home, no generation request or live user session.
it.skipIf(!Bun.which("codex"))("Codex persists the selected native context and excludes subsequent replies", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-codex-fork-")));
  try {
    const cwd = join(root, "project"), home = join(root, "codex"), directory = join(home, "sessions/2026/10/30"); mkdirSync(cwd); mkdirSync(directory, { recursive: true });
    const records = readFileSync(join(import.meta.dir, "fixtures/codex-pictures-0.163.0-rollout.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const id: string = records[0].payload.id; records[0].payload.cwd = cwd;
    const source = join(directory, `rollout-2026-10-30T00-00-00-${id}.jsonl`); writeFileSync(source, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const before = readFileSync(source), point = records.find(record => record.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user");
    const fork = await forkCodex(source, home, cwd, nativeRecordHash(point));
    const file = readdirSync(directory).find(name => name.includes(fork))!;
    expect(fork).not.toBe(id); expect(file).toBeDefined();
    const copied = readFileSync(join(directory, file), "utf8"), turns = parseCodexTranscript(copied);
    expect(turns.some(turn => turn.role === "user")).toBe(true);
    expect(turns.some(turn => turn.role === "assistant")).toBe(false);
    expect(readFileSync(source).equals(before)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
