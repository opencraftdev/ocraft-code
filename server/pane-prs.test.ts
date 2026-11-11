import { describe, expect, test } from "bun:test";
import { checkCounts, PanePrs, prUrlsIn } from "./pane-prs.ts";

describe("pane PRs", () => {
  test("counts CI checks as passed of all, failures and runs still going apart", () => {
    expect(checkCounts([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "IN_PROGRESS", conclusion: "" },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { state: "SUCCESS" },
    ])).toEqual({ passed: 3, failed: 1, pending: 1, total: 5 });
    expect(checkCounts([])).toBeNull();
  });

  test("finds the PRs an agent linked, newest first and once each", () => {
    expect(prUrlsIn([
      "Opened https://github.com/potenlab/trina-ax/pull/372",
      "Merged it. Now https://github.com/potenlab/trina-ax/pull/385 and again https://github.com/potenlab/trina-ax/pull/372.",
    ])).toEqual(["https://github.com/potenlab/trina-ax/pull/372", "https://github.com/potenlab/trina-ax/pull/385"]);
  });

  test("lists the branch's PR first, and tries another account where the default cannot see the repo", async () => {
    const calls: string[] = [];
    const prs = new PanePrs(async (args, _cwd, token) => {
      calls.push(`${token ?? "-"} ${args.slice(0, 3).join(" ")}`);
      if (args[0] === "auth" && args[1] === "status") return { code: 0, out: "Logged in to github.com account work (keyring)\nLogged in to github.com account home (keyring)" };
      if (args[0] === "auth" && args[1] === "token") return { code: 0, out: `token-${args.at(-1)}\n` };
      if (args[0] === "pr" && args.length === 4) return { code: 0, out: JSON.stringify({ url: "https://github.com/acme/app/pull/9" }) };
      if (token !== "token-home") return { code: 1, out: "" };
      const number = args[2]!.split("/").at(-1);
      return { code: 0, out: JSON.stringify({ number: Number(number), title: `PR ${number}`, state: number === "9" ? "OPEN" : "MERGED", isDraft: false, url: args[2], additions: 3, deletions: 1, headRefName: "feat/x", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }) };
    });
    const { prs: list } = await prs.of("p1", "/tmp", ["see https://github.com/acme/app/pull/4"]);
    expect(list.map((pr) => [pr.number, pr.state, pr.current, pr.repo, pr.checks?.passed])).toEqual([[9, "open", true, "app", 1], [4, "merged", false, "app", 1]]);
    // the second PR goes straight to the account that worked for its owner
    expect(calls.filter((call) => call.startsWith("token-home pr view https://github.com/acme/app/pull/4"))).toHaveLength(1);
  });
});
