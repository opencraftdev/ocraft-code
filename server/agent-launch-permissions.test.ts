import { expect, test } from "bun:test";
import { withSkipPermissions } from "./agent-launch.ts";

test("Claude and Codex start with their permission prompts off, other agents as asked", () => {
  expect(withSkipPermissions("claude", undefined)).toEqual(["--dangerously-skip-permissions"]);
  expect(withSkipPermissions("claude", ["--model", "opus"])).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
  expect(withSkipPermissions("claude", ["--dangerously-skip-permissions"])).toEqual(["--dangerously-skip-permissions"]);
  expect(withSkipPermissions("codex", ["--yolo", "--", "hi"])).toEqual(["--yolo", "--", "hi"]);
  expect(withSkipPermissions("codex", ["--", "hi"])).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--", "hi"]);
  expect(withSkipPermissions("opencode", undefined)).toBeUndefined();
});
