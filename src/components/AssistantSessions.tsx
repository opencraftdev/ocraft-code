import { useId, useState, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { isAssistantMachine, isAssistantPane } from "../lib/assistantMode.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { RowMenuItem } from "./RowMenu.tsx";
import { STATE_WORD } from "./MachineSidebar.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";

/** One PC's agent panes the Assistant can delegate to, in the Sessions section's order. */
export interface SessionGroup { machine: Machine; panes: HerdrPane[] }

/** working, then blocked (needs input), then the rest */
const rank = (pane: HerdrPane): number => pane.agent_status === "working" ? 0 : pane.agent_status === "blocked" ? 1 : 2;
export const sessionActive = (pane: HerdrPane): boolean => rank(pane) < 2;

/**
 * Every agent pane on the PCs this Ovis has, the Assistant VM and the Assistant's own pane excepted,
 * grouped by PC in the roster's order, each PC's panes ordered working, blocked, then the rest.
 */
export function assistantSessions(machines: readonly Machine[]): SessionGroup[] {
  return machines
    .filter((machine) => !(machine.kind === "ssh" && isAssistantMachine(machine.target?.destination)))
    .map((machine) => ({ machine, panes: (machine.snapshot?.panes ?? []).filter((pane) => pane.agent && !isAssistantPane(pane.cwd)).sort((a, b) => rank(a) - rank(b)) }))
    .filter((group) => group.panes.length > 0);
}

/** the row's dot, as the agent panel's rows draw theirs (AgentPanel.css state-*) */
const tone = (pane: HerdrPane): string => pane.agent_status === "working" ? "working" : pane.agent_status === "blocked" ? "blocked" : pane.agent_status === "done" ? "done" : "idle";

/**
 * The Assistant pane's Sessions section in the agent panel, styled as Background tasks: what works
 * or waits first, under a light header per PC with its connection dot; idle and done panes fold into
 * an "N finished" row that unfolds them in place. A row opens its pane in Code mode.
 * ponytail: no elapsed time, herdr's pane snapshot carries no start time.
 */
export function AssistantSessions({ machines, onOpen }: { machines: readonly Machine[]; onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const groups = assistantSessions(machines);
  const finished = groups.reduce((sum, group) => sum + group.panes.filter((pane) => !sessionActive(pane)).length, 0);
  const shown = groups.map((group) => ({ ...group, panes: all ? group.panes : group.panes.filter(sessionActive) })).filter((group) => group.panes.length > 0);
  const status = (pane: HerdrPane): string => pane.agent_status === "working" ? t("Working") : pane.agent_status === "blocked" ? t("Needs input") : pane.agent_status === "done" ? t("Done") : t("Idle");
  return <section className="agent-panel-section agent-panel-tasks agent-panel-sessions" data-expanded={open} aria-label={t("Sessions")}>
    <header className="agent-panel-section-head"><h2><button type="button" className="agent-panel-disclosure" aria-expanded={open} aria-controls={`${id}-sessions`} onClick={() => setOpen((value) => !value)}>{t("Sessions")}<ChevronDown aria-hidden="true" /></button></h2></header>
    <div id={`${id}-sessions`} className="agent-panel-launchers" hidden={!open}>
      {shown.length === 0 && <p className="agent-panel-note">{t(groups.length === 0 ? "No agent sessions on your PCs." : "No sessions working.")}</p>}
      {shown.map(({ machine, panes }) => <div key={machine.id} className="agent-panel-session-machine">
        <h3 className="agent-panel-section-label"><span className={`machine-dot is-${machine.state}`} role="img" aria-label={t(STATE_WORD[machine.state])} title={t(STATE_WORD[machine.state])} />{machine.name}</h3>
        <ul className="agent-panel-list">{panes.map((pane) => <li key={pane.pane_id}>
          <button type="button" className={`agent-panel-row state-${tone(pane)}`} title={displayPaneTitle(pane)} onClick={() => onOpen(machine.id, pane.pane_id)}>
            <Bot aria-hidden="true" /><span className="agent-panel-row-main"><span>{displayPaneTitle(pane)}</span><small>{machine.name} · {pane.display_agent ?? pane.agent}</small></span>
            <span className="agent-panel-row-status" role="img" aria-label={status(pane)} /><ChevronRight className="agent-panel-row-arrow" aria-hidden="true" />
          </button>
        </li>)}</ul>
      </div>)}
      {finished > 0 && <button type="button" className="agent-panel-action" aria-expanded={all} aria-controls={`${id}-sessions`} onClick={() => setAll((value) => !value)}><Bot aria-hidden="true" /><span>{all ? t("Hide finished") : t("{count} finished", { count: finished })}</span><ChevronRight aria-hidden="true" /></button>}
    </div>
  </section>;
}

/** what starts a fresh conversation in the same agent: the pane itself stays */
const FRESH: Readonly<Record<string, string>> = { claude: "/clear", codex: "/new" };

/**
 * Restart Assistant in the pane's ⋯ menu: after a yes, `/clear` (Claude Code) or `/new` (Codex) goes
 * to the Assistant's pane as the composer sends a message, never while its agent works. `pane`: the
 * Assistant's pane when it is the one selected, else null (no item).
 */
export function useRestartAssistant(machineId: string, pane: HerdrPane | null): { item: RowMenuItem | null; dialog: ReactNode } {
  const t = useT();
  const sessions = useMachineSessions();
  const [asking, setAsking] = useState<HerdrPane | null>(null);
  const command = pane?.agent ? FRESH[pane.agent] : undefined;
  const working = pane?.agent_status === "working";
  const item: RowMenuItem | null = pane && command ? {
    id: "restart-assistant", label: t("Restart Assistant"), icon: RotateCcw, disabled: working,
    title: working ? t("Wait until the Assistant is idle") : t("Starts a fresh conversation with {command}", { command }),
    run: () => setAsking(pane),
  } : null;
  const fresh = asking?.agent ? FRESH[asking.agent] : undefined;
  const dialog = asking && fresh ? <ConfirmDialog title={t("Restart Assistant?")} body={t("The Assistant starts a fresh conversation: it sends {command} to its agent. What it saved in notes.md stays.", { command: fresh })}
    confirmLabel={t("Restart")} onClose={() => setAsking(null)}
    onConfirm={async () => {
      const sent = await sessions?.peek(machineId)?.socket.submit(asking.pane_id, fresh, fresh);
      if (!sent) throw new Error(t("Not connected to this PC. Nothing was sent."));
      if (!sent.ok) throw new Error(sent.message);
      setAsking(null);
    }} /> : null;
  return { item, dialog };
}
