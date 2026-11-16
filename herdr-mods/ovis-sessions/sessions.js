// The ovis-sessions mod's logic without its UI: the herdr 0.9 sessions an Ovis server sees on its PCs,
// grouped per PC and workspace, and the command that attaches a herdr-app terminal to one of them.
// Pure and host-free, so `bun test` runs it.

const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };

/** A pane's name as the sidebar shows it: its own title, else its agent, else its folder's last part. */
export function paneTitle(pane) {
  const title = (pane.terminal_title_stripped ?? pane.terminal_title ?? "").trim();
  if (title) return title;
  if (pane.agent) return pane.display_agent ?? pane.agent;
  const dir = (pane.foreground_cwd ?? pane.cwd ?? "").replace(/\/+$/, "");
  return dir.split("/").at(-1) || "~";
}

/**
 * GET /api/machines → [{machine, workspaces: [{id, label, panes}]}] for connected PCs, agents before shells
 * and blocked / working before the rest inside a workspace. `agentsOnly` leaves plain shells out.
 */
export function sessionGroups(machines, agentsOnly = false) {
  return (machines ?? []).filter((m) => m.state === "connected" && m.snapshot).map((machine) => {
    const snap = machine.snapshot;
    const workspaces = (snap.workspaces ?? []).map((w) => ({
      id: w.workspace_id,
      label: w.label || w.workspace_id,
      panes: (snap.panes ?? [])
        .filter((p) => p.workspace_id === w.workspace_id && (!agentsOnly || p.agent))
        .sort((a, b) => Number(!a.agent) - Number(!b.agent) || (RANK[a.agent_status] ?? 4) - (RANK[b.agent_status] ?? 4)),
    })).filter((w) => w.panes.length > 0);
    return { machine, workspaces };
  }).filter((g) => g.workspaces.length > 0);
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The argv of a herdr-app terminal attached to a herdr 0.9 pane, run on this computer: herdr's own
 * `terminal attach` (never --takeover), over ssh for a remote PC. null when the pane has no terminal id
 * or the PC is not one ssh reaches.
 */
export function attachArgv(machine, pane) {
  const id = pane.terminal_id;
  if (!id || !/^[\w.-]+$/.test(id)) return null;
  const line = `PATH="$HOME/.local/bin:$PATH"; exec herdr terminal attach ${quote(id)}`;
  if (machine.kind === "local" || machine.id === "local") return ["sh", "-lc", line];
  const dest = machine.target?.destination;
  if (machine.kind !== "ssh" || !dest || dest.startsWith("-")) return null;
  return ["ssh", "-t", dest, line];
}

/** A status word and the theme color its dot takes. */
export function statusOf(pane) {
  const s = pane.agent_status;
  if (!pane.agent) return { word: "Shell", color: null };
  return s === "working" ? { word: "Working", color: "working" } : s === "blocked" ? { word: "Needs input", color: "blocked" } : s === "done" ? { word: "Done", color: "done" } : { word: "Idle", color: "idle" };
}
