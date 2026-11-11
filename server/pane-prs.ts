import { paneContext } from "./pane-context.ts";
import { paneConversation } from "./conversation.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import type { PanePullRequest, PanePullRequests } from "../shared/protocol.ts";

/** A GitHub pull request's address, as an agent writes it in its replies. */
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const MAX_PRS = 6;
const CACHE_MS = 30_000;
const GH_TIMEOUT_MS = 15_000;

type Run = (args: string[], cwd: string, token?: string) => Promise<{ code: number; out: string }>;

const runGh: Run = async (args, cwd, token) => {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, out };
  } catch {
    return { code: 1, out: "" };
  } finally {
    clearTimeout(timer);
  }
};

/** CI in the reference's terms: checks passed out of all, and whether any failed or still run. */
export function checkCounts(rollup: unknown): PanePullRequest["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let passed = 0, failed = 0, pending = 0;
  for (const item of rollup as Record<string, unknown>[]) {
    // a CheckRun reports a status and, once completed, a conclusion; a StatusContext a state
    const outcome = String(item["conclusion"] || item["state"] || "").toUpperCase();
    const done = item["status"] === undefined || String(item["status"]).toUpperCase() === "COMPLETED";
    if (!done || outcome === "" || outcome === "PENDING" || outcome === "EXPECTED") pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) passed++;
    else failed++;
  }
  return { passed, failed, pending, total: rollup.length };
}

/** The PR addresses in a conversation's text, newest mention first, each once. */
export function prUrlsIn(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (let at = texts.length - 1; at >= 0; at--) {
    const all = [...texts[at]!.matchAll(PR_URL)].map((match) => `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`).reverse();
    for (const url of all) if (!seen.has(url)) { seen.add(url); found.push(url); }
  }
  return found;
}

/**
 * The pull requests of one session, for the agent panel's Changes: the PR of the folder's branch, and
 * every PR the agent linked in its conversation. Read through `gh` on this PC: a repository the default
 * account cannot see is tried again with each other logged-in account (people keep a work and a
 * personal one), and the account that worked is kept per owner.
 */
export class PanePrs {
  private readonly cache = new Map<string, { at: number; value: PanePullRequests }>();
  private readonly accountByOwner = new Map<string, string>();
  constructor(private readonly run: Run = runGh, private readonly now = Date.now) {}

  private async tokens(): Promise<string[]> {
    const status = await this.run(["auth", "status", "--hostname", "github.com"], process.cwd());
    const accounts = [...status.out.matchAll(/account (\S+)/g)].map((match) => match[1]!);
    const tokens: string[] = [];
    for (const account of accounts) {
      const token = await this.run(["auth", "token", "--hostname", "github.com", "--user", account], process.cwd());
      if (token.code === 0 && token.out.trim()) tokens.push(token.out.trim());
    }
    return tokens;
  }

  private async gh(args: string[], cwd: string, owner: string | null): Promise<string | null> {
    const kept = owner ? this.accountByOwner.get(owner) : undefined;
    const first = await this.run(args, cwd, kept);
    if (first.code === 0) return first.out;
    for (const token of await this.tokens()) {
      if (token === kept) continue;
      const again = await this.run(args, cwd, token);
      if (again.code === 0) { if (owner) this.accountByOwner.set(owner, token); return again.out; }
    }
    return null;
  }

  async of(paneId: string, cwd: string, texts: readonly string[]): Promise<PanePullRequests> {
    const cached = this.cache.get(paneId);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.value;
    const urls = prUrlsIn(texts);
    const current = await this.gh(["pr", "view", "--json", "url"], cwd, null).then((out) => out ? (JSON.parse(out) as { url?: string }).url ?? null : null).catch(() => null);
    const ordered = [...new Set([...(current ? [current] : []), ...urls])].slice(0, MAX_PRS);
    const prs: PanePullRequest[] = [];
    for (const url of ordered) {
      const [, owner, repo] = /github\.com\/([\w.-]+)\/([\w.-]+)\//.exec(url) ?? [];
      const out = await this.gh(["pr", "view", url, "--json", "number,title,state,isDraft,url,additions,deletions,headRefName,statusCheckRollup"], cwd, owner ?? null);
      if (!out) continue;
      try {
        const pr = JSON.parse(out) as Record<string, unknown>;
        const state = String(pr["state"]).toLowerCase();
        prs.push({
          number: Number(pr["number"]),
          title: String(pr["title"] ?? ""),
          state: pr["isDraft"] === true && state === "open" ? "draft" : state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
          url: String(pr["url"] ?? url),
          repo: repo ?? "",
          branch: typeof pr["headRefName"] === "string" ? pr["headRefName"] : null,
          additions: Number(pr["additions"] ?? 0),
          deletions: Number(pr["deletions"] ?? 0),
          checks: checkCounts(pr["statusCheckRollup"]),
          current: url === current,
        });
      } catch { /* an answer gh could not give whole: the PR is left out */ }
    }
    const value: PanePullRequests = { prs };
    this.cache.set(paneId, { at: this.now(), value });
    return value;
  }
}

const prs = new PanePrs();

/** GET /api/pane/prs?pane_id=: the session's pull requests (PanePrs). */
export async function handlePanePrsRequest(request: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/pane/prs") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  try {
    const { cwd } = await paneContext(paneId);
    // the agent's replies, where it links the PRs it opened; a pane with no transcript has none
    const texts = await paneConversation(paneId).then((conversation) => conversation.turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []))).catch(() => [] as string[]);
    return jsonResponse(await prs.of(paneId, cwd, texts));
  } catch {
    return jsonResponse({ prs: [] } satisfies PanePullRequests);
  }
}
