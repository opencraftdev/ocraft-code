import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Ellipsis, ExternalLink, FileDiff, Folder, GitBranch, GitFork, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Layers, Link, Monitor, PanelRightClose, RefreshCw, X } from "lucide-react";
import type { HerdrPane, RepoDiffFile } from "../../shared/protocol.ts";
import { AgentGraphView, graphStateWord } from "./AgentGraphView.tsx";
import { agentActivityGroups, sessionGraph, type AgentGraphNode } from "../lib/agentGraph.ts";
import type { AgentPanelView } from "../lib/useAgentPanel.ts";
import { useRepoChangesSummary } from "../lib/useRepoChangesSummary.ts";
import { diffErrorMessage, type RepoComparison } from "../lib/repoDiff.ts";
import { useAgentActivity } from "../lib/useAgentActivity.ts";
import { MachineContext, useMachineId } from "../lib/machineContext.tsx";
import { usePaneBranch, DETACHED } from "../lib/paneBranch.ts";
import { useT } from "../lib/i18n.ts";
import { useConversationContext } from "../lib/conversationContext.ts";
import { contextLeftPercent, formatTokens } from "../lib/compose.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { AgentWorkDetail } from "./AgentWorkDetail.tsx";
import { ContextUsage } from "./ContextUsage.tsx";
import { BackgroundTaskCards } from "./BackgroundTaskCards.tsx";
import { useBackgroundTaskReceipts } from "../lib/backgroundTaskReceipts.ts";
import { useActivityClock } from "../lib/useActivityClock.ts";
import { formatElapsed, runGoing, taskElapsedMs } from "../lib/omoTasks.ts";
import { usePanePrs } from "../lib/usePanePrs.ts";
import { RowMenu } from "./RowMenu.tsx";
import { copyText } from "../lib/clipboard.ts";
import "./AgentPanel.css";

type PanelTab = AgentPanelView;
export interface AgentPanelProps {
  contextKey: string | null;
  pane: HerdrPane;
  panes: readonly HerdrPane[];
  machineName: string;
  workspaceName: string;
  title: string;
  online: boolean;
  watching: boolean;
  tab: PanelTab;
  drawerOpen: boolean;
  onOpenView: (tab: PanelTab) => void;
  onCloseView: () => void;
  onClose: () => void;
  onSelectPane: (id: string) => void;
  onBrowseFiles: (tab: "browse" | "changes") => void;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
  onNewAgent: () => void;
  pinned?: boolean;
  /** an agent the composer's strip asked to open (`task:<id>`), consumed once */
  focusAgent?: string | null;
  onFocusedAgent?: () => void;
  /** with two chats side by side: this chat's screen number, and the other chat */
  screen?: number;
  beside?: PanelChat | null;
  /** the Assistant's pane: its folder is no git repository, so no Changes */
  hideChanges?: boolean;
  /** sections drawn after Context and Changes (the Assistant's Sessions) */
  extraSections?: ReactNode;
}

/** One chat's place in the panel. */
export interface PanelChat {
  screen: number;
  title: string;
  pane: HerdrPane;
  machineId: string;
  machineName: string;
  workspaceName: string;
  online: boolean;
  contextKey: string | null;
  onBrowseFiles: (tab: "browse" | "changes") => void;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
}

/** Reference-style environment and agent sections, using existing read-only bridge APIs. */
export function AgentPanel({ contextKey, pane, machineName, workspaceName, title, online, watching, tab, drawerOpen, onOpenView, onCloseView, onClose, onBrowseFiles, onOpenDiff, pinned = false, focusAgent = null, onFocusedAgent, screen, beside = null, hideChanges = false, extraSections = null }: AgentPanelProps) {
  const t = useT();
  const machineId = useMachineId();
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const drawerRoot = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLButtonElement | null>(null);
  const closeDrawer = useCallback(() => { onCloseView(); drawerTrigger.current?.focus({ preventScroll: true }); }, [onCloseView]);
  usePhoneSheetBack(closeDrawer, drawerOpen, true);
  useEffect(() => { if (drawerOpen) drawerRoot.current?.focus({ preventScroll: true }); }, [drawerOpen]);
  const openDrawer = (next: PanelTab, trigger: HTMLButtonElement) => {
    if (!drawerRoot.current?.contains(trigger)) drawerTrigger.current = trigger;
    onOpenView(next);
    if (drawerOpen) drawerRoot.current?.focus({ preventScroll: true });
  };
  const root = useRef<HTMLElement>(null);
  const narrow = useMediaQuery("(max-width: 979px)");
  usePhoneSheetBack(onClose, narrow && !pinned, true);
  useEffect(() => {
    if (narrow && !pinned) root.current?.focus({ preventScroll: true });
    const close = (event: globalThis.KeyboardEvent) => {
      if (!pinned && event.key === "Escape" && root.current?.contains(document.activeElement)) { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [narrow, onClose, pinned]);
  const id = useId();
  const [changesRefresh, setChangesRefresh] = useState(0);
  const [changeCount, setChangeCount] = useState<string | number | null>(null);
  // this chat and, with two side by side, the other: each section lists both, numbered as the sidebar marks them
  const chats: PanelChat[] = [{ screen: screen ?? 1, title, pane, machineId, machineName, workspaceName, online, contextKey, onBrowseFiles, onOpenDiff }, ...(beside ? [beside] : [])].sort((a, b) => a.screen - b.screen);
  const tag = (chat: PanelChat) => chats.length > 1 && <span className="agent-panel-chat" title={chat.title}><span className="screen-badge" aria-label={t("Screen {n}", { n: chat.screen })}>{chat.screen}</span><span>{chat.title}</span></span>;
  const activity = useAgentActivity(pane.pane_id, pane.agent ?? null, drawerOpen && tab === "graph", watching, online, refresh, pane.background_tasks ?? 0);
  const session = useMemo(() => sessionGraph({ paneId: pane.pane_id, title, status: pane.agent_status, tasks: activity.tasks, steps: activity.steps, agents: activity.agents }), [activity, pane.pane_id, pane.agent_status, title]);
  const graph = activity.dagr ?? session;
  const selected = graph.nodes.find(node => node.id === selectedId) ?? session.nodes.find(node => node.id === selectedId) ?? null;
  const groups = useMemo(() => agentActivityGroups(session), [session]);
  const agents = groups.agents;
  const tasks = groups.tasks;
  const live = (node: AgentGraphNode) => node.state === "working" || node.state === "unknown";
  const runningAgents = agents.filter(live), endedAgents = agents.filter(node => !live(node));
  const runningTasks = tasks.filter(live), endedTasks = tasks.filter(node => !live(node));
  const receipts = useBackgroundTaskReceipts(contextKey);
  const now = useActivityClock(runningAgents.length > 0 || runningTasks.length > 0 || activity.runs.some(runGoing), activity.clockOffset);
  const endedCount = endedTasks.length + activity.runs.filter(run => !runGoing(run)).length;
  const agentListScroll = useRef(0);
  const showAgent = (node: AgentGraphNode, trigger: HTMLButtonElement) => {
    if (drawerRoot.current?.contains(trigger)) agentListScroll.current = drawerRoot.current.querySelector(".agent-drawer-body")?.scrollTop ?? 0;
    setSelectedId(node.id); openDrawer("details", trigger);
    drawerRoot.current?.querySelector(".agent-drawer-body")?.scrollTo(0, 0);
  };
  const backToAgents = () => {
    const previous = selectedId; setSelectedId(null); onOpenView("agents");
    requestAnimationFrame(() => {
      const body = drawerRoot.current?.querySelector(".agent-drawer-body");
      if (body) body.scrollTop = agentListScroll.current;
      const row = [...(body?.querySelectorAll<HTMLButtonElement>("[data-agent-id]") ?? [])].find(item => item.dataset.agentId === previous);
      (row ?? drawerRoot.current)?.focus({ preventScroll: true });
    });
  };
  const showTask = (node: AgentGraphNode, trigger: HTMLButtonElement) => { setSelectedId(node.id); openDrawer("tasks", trigger); };
  useEffect(() => {
    if (focusAgent === null) return;
    setSelectedId(focusAgent); onFocusedAgent?.();
    drawerRoot.current?.querySelector(".agent-drawer-body")?.scrollTo(0, 0);
  }, [focusAgent, onFocusedAgent]);
  // a cold first read on a remote PC can take ten seconds; one that failed is not still loading
  const waiting = activity.loading ? t(activity.slow ? "Still reading agents from {machine}…" : "Loading agent activity", { machine: machineName }) : null;
  const choose = (node: AgentGraphNode) => { setSelectedId(node.id); onOpenView("details"); drawerRoot.current?.querySelector(".agent-drawer-body")?.scrollTo(0, 0); };
  const row = (node: AgentGraphNode) => <li key={node.id}>
    <button type="button" data-agent-id={node.kind === "agent" ? node.id : undefined} className={`agent-panel-row${node.kind === "agent" ? " is-agent" : ""} state-${node.state}`} aria-pressed={selectedId === node.id} onClick={event => node.kind === "agent" ? showAgent(node, event.currentTarget) : showTask(node, event.currentTarget)} title={node.label}>
      {node.kind === "agent" ? <GitFork aria-hidden="true" /> : <Layers aria-hidden="true" />}<span className="agent-panel-row-main"><span>{node.label}</span>{node.kind !== "agent" && <small>{node.model ?? node.actor ?? graphStateWord(node.state, t)}</small>}</span>
      {node.task && taskElapsedMs(node.task, now) !== null && <small className="background-summary-time">{formatElapsed(taskElapsedMs(node.task, now)!)}</small>}
      <span className="agent-panel-row-status" role="img" aria-label={graphStateWord(node.state, t)} /><ChevronRight className="agent-panel-row-arrow" aria-hidden="true" />
    </button>
  </li>;
  const openList = (view: "agents" | "tasks", event: MouseEvent<HTMLButtonElement>, ended = false) => { setSelectedId(null); setShowEnded(ended); openDrawer(view, event.currentTarget); };
  return <><aside ref={root} tabIndex={-1} className="agent-panel" id="agent-details-panel" aria-label={t("Workspace and agents")}>
    <div className="agent-panel-card">
      <section className="agent-panel-section agent-panel-environment" data-expanded={environmentOpen} aria-label={t("Environment")}>
        <header className="agent-panel-section-head">
          <h2><button type="button" className="agent-panel-disclosure" aria-expanded={environmentOpen} aria-controls={`${id}-environment`} onClick={() => setEnvironmentOpen(value => !value)}>{t("Environment")}<ChevronDown aria-hidden="true" /></button></h2>
          {!pinned && <button type="button" className="icon-button" onClick={onClose} aria-label={t("Close agent panel")}><PanelRightClose aria-hidden="true" /></button>}
        </header>
        <div id={`${id}-environment`} className="agent-panel-environment-body" hidden={!environmentOpen}>
          {chats.map((chat) => <MachineContext.Provider key={chat.screen} value={chat.machineId}>{tag(chat)}<EnvironmentRows chat={chat} /></MachineContext.Provider>)}
        </div>
      </section>
      <section className="agent-panel-section agent-panel-context" aria-label={t("Context")}>
        {chats.length > 1 && <header className="agent-panel-section-head"><h2>{t("Context")}</h2></header>}
        {chats.map((chat) => <ContextRow key={chat.screen} chat={chat} label={chats.length > 1 ? tag(chat) : t("Context")} open={contextOpen} onToggle={() => setContextOpen(value => !value)} detailsId={`${id}-context-${chat.screen}`} />)}
      </section>
      {!hideChanges && <section className="agent-panel-section agent-panel-changes" data-expanded={changesOpen} aria-label={t("Changes")}>
        <header className="agent-panel-section-head">
          <h2><button type="button" className="agent-panel-disclosure" aria-expanded={changesOpen} aria-controls={`${id}-changes`} onClick={() => setChangesOpen(value => !value)}>{t("Changes")}<ChevronDown aria-hidden="true" />{changeCount !== null && <span className="agent-panel-count">{changeCount}</span>}</button></h2>
          <button type="button" className="icon-button" disabled={!online} aria-label={t("Refresh changes")} title={t("Refresh changes")} onClick={() => setChangesRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" /></button>
        </header>
        <div id={`${id}-changes`} className="agent-panel-launchers" hidden={!changesOpen}>
          {chats.map((chat) => <MachineContext.Provider key={chat.screen} value={chat.machineId}>{tag(chat)}<ChangesBody chat={chat} refresh={changesRefresh} onCount={chats.length === 1 ? setChangeCount : undefined} /></MachineContext.Provider>)}
        </div>
      </section>}
      {extraSections}
      {/* shown only while work runs: what ended is in the drawer, opened from the chat's strip and chip */}
      {(runningTasks.length > 0 || activity.runs.some(runGoing)) && <section className="agent-panel-section agent-panel-tasks" data-expanded={tasksOpen} aria-label={t("Background tasks")}>
        <header className="agent-panel-section-head"><h2><button type="button" className="agent-panel-disclosure" aria-expanded={tasksOpen} aria-controls={`${id}-tasks`} onClick={() => setTasksOpen(value => !value)}>{t("Background tasks")}<ChevronDown aria-hidden="true" /></button></h2></header>
        <div id={`${id}-tasks`} className="agent-panel-launchers" hidden={!tasksOpen}>
          {runningTasks.length > 0 ? <ul className="agent-panel-list">{runningTasks.slice(0, 2).map(row)}</ul> : activity.runs.some(runGoing) ? <p className="agent-panel-note">{t("{n} running", { n: activity.runs.filter(runGoing).length })}</p> : <p className="agent-panel-note">{waiting ?? t(activity.stale ? "Task activity unavailable" : "No background tasks reported.")}</p>}
          <button type="button" className="agent-panel-action" aria-expanded={drawerOpen && tab === "tasks"} aria-controls={`${id}-drawer`} onClick={event => openList("tasks", event, endedCount > 0)}><Layers aria-hidden="true" /><span>{endedCount > 0 ? t("{count} finished", { count: endedCount }) : t("View background tasks")}</span><ChevronRight aria-hidden="true" /></button>
        </div>
      </section>}
      {runningAgents.length > 0 && <section className="agent-panel-section agent-panel-agents" data-expanded={agentsOpen} aria-label={t("Agents")}>
        <header className="agent-panel-section-head"><h2><button type="button" className="agent-panel-disclosure" aria-expanded={agentsOpen} aria-controls={`${id}-agents-summary`} onClick={() => setAgentsOpen(value => !value)}>{t("Agents")}<ChevronDown aria-hidden="true" /></button></h2></header>
        <div id={`${id}-agents-summary`} className="agent-panel-launchers" hidden={!agentsOpen}>
          {runningAgents.length > 0 ? <ul className="agent-panel-list">{runningAgents.slice(0, 2).map(row)}</ul> : <p className="agent-panel-note">{waiting ?? t(activity.stale ? "Agent activity unavailable" : "No agents running.")}</p>}
          <button type="button" className="agent-panel-action" aria-expanded={drawerOpen && tab !== "tasks"} aria-controls={`${id}-drawer`} onClick={event => openList("agents", event, endedAgents.length > 0)}><GitFork aria-hidden="true" /><span>{endedAgents.length > 0 ? t("{count} finished", { count: endedAgents.length }) : t("View agents")}</span><ChevronRight aria-hidden="true" /></button>
        </div>
      </section>}
    </div>
  </aside>
  {drawerOpen && createPortal(<aside ref={drawerRoot} tabIndex={-1} id={`${id}-drawer`} className="workspace-details-drawer agent-details-drawer" aria-labelledby={`${id}-drawer-title`}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDrawer(); } }}>
    <header className="agent-drawer-header">
      {(narrow || tab === "details" || tab === "graph") && <button type="button" className="icon-button" aria-label={t("Back")} onClick={() => { if (tab === "details") backToAgents(); else if (tab === "graph") { onOpenView(selected ? "details" : "agents"); drawerRoot.current?.focus({ preventScroll: true }); } else closeDrawer(); }}><ArrowLeft aria-hidden="true" /></button>}
      <h2 id={`${id}-drawer-title`} title={tab === "details" ? selected?.label : undefined}>{tab === "details" ? selected?.label ?? t("Agent details") : t(tab === "tasks" ? "Background tasks" : tab === "graph" ? "Agent graph" : "Agents")}</h2>
      {(tab === "agents" || tab === "details") && <button type="button" className="icon-button" aria-label={t("Agent graph")} title={t("Agent graph")} onClick={() => { onOpenView("graph"); drawerRoot.current?.focus({ preventScroll: true }); }}><GitFork aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} disabled={activity.loading || !online} onClick={() => setRefresh(value => value + 1)}><RefreshCw aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label={t("Close panel")} title={t("Close panel")} onClick={closeDrawer}><X aria-hidden="true" /></button>
    </header>
    <div className="agent-panel-body agent-drawer-body">
      {(activity.stale || (tab === "graph" && activity.dagrFailed)) && <p className="agent-panel-note agent-panel-stale" role="status">{t(activity.dagrFailed && tab === "graph" ? "Workflow file couldn't be read. Showing the last available graph." : "Connection interrupted. Showing the last recorded activity.")}</p>}
      {tab === "agents" ? <div className="agent-roster">
        <h2 className="background-task-group-heading">{t("Running")} <span>{runningAgents.length}</span></h2>
        {runningAgents.length > 0 ? <ul className="agent-panel-list agent-roster-list">{runningAgents.map(row)}</ul> : <p className="agent-panel-note">{waiting ?? t(activity.stale ? "Agent activity unavailable" : "No agents running.")}</p>}
        {endedAgents.length > 0 && <details className="background-finished-group" open={showEnded} onToggle={event => setShowEnded(event.currentTarget.open)}><summary><ChevronDown aria-hidden="true" />{t("Finished")} <span>{endedAgents.length}</span></summary><ul className="agent-panel-list agent-roster-list">{endedAgents.map(row)}</ul></details>}
      </div> : tab === "tasks" ? <BackgroundTaskCards running={runningTasks} ended={endedTasks} runs={activity.runs} receipts={receipts} selectedId={selectedId} showEnded={showEnded} onShowEnded={setShowEnded} now={now} loading={activity.loading} moreRunning={activity.moreRunning} /> : tab === "details" ? selected && <AgentWorkDetail key={selected.id} paneId={pane.pane_id} node={selected} receipt={selected.task ? receipts.get(selected.task.id) : undefined} online={online} watching={watching} refresh={refresh} now={now} /> : <>
        {selected && <h2 className="agent-details-name">{selected.label}</h2>}
        <div className="agent-panel-graph-heading"><h2>{t("Agent flow")}</h2><span>{graph.source === "dagr" ? "dagr" : t("Live session")}</span></div>
        <p className="agent-panel-graph-title">{graph.title}</p>
        <AgentGraphView graph={graph} selected={selectedId} onSelect={choose} />
        <p className="agent-panel-legend"><span />{t("Recorded") }<span className="is-dashed" />{t("Planned / retry")}</p>
        {graph.hidden > 0 && <p className="agent-panel-note">{t("{n} more nodes are outside this view", { n: graph.hidden })}</p>}
        {graph.source === "session" && <p className="agent-panel-note">{t("Dependencies and review loops appear when a dagr run is recorded for this project.")}</p>}
      </>}
    </div>
  </aside>, document.getElementById("ovis-workspace") ?? document.body)}
  </>;
}

/** A chat's machine, folder and branch. */
function EnvironmentRows({ chat }: { chat: PanelChat }) {
  const t = useT();
  const branch = usePaneBranch(chat.machineId, chat.pane.workspace_id);
  const directory = chat.pane.foreground_cwd ?? chat.pane.cwd;
  return <>
    <div className="agent-panel-environment-row"><Monitor aria-hidden="true" /><span title={chat.machineName}>{chat.machineName}</span></div>
    <div className="agent-panel-environment-row agent-panel-directory" title={directory ?? chat.workspaceName}><Folder aria-hidden="true" /><span>{chat.workspaceName}{directory && directory !== chat.workspaceName && <small> · {directory}</small>}</span></div>
    {branch && <div className="agent-panel-environment-row"><GitBranch aria-hidden="true" /><span title={branch === DETACHED ? t("Detached HEAD") : branch}>{branch === DETACHED ? t("Detached HEAD") : branch}</span></div>}
  </>;
}

/** A chat's context use: the share of its window, opened for the details. */
function ContextRow({ chat, label, open, onToggle, detailsId }: { chat: PanelChat; label: ReactNode; open: boolean; onToggle: () => void; detailsId: string }) {
  const t = useT();
  const context = useConversationContext(chat.contextKey);
  const left = context ? contextLeftPercent(context) : null;
  const percent = left === null ? null : 100 - left;
  return <>
    <h2 className="agent-context-heading"><button type="button" className="agent-panel-disclosure" aria-label={percent === null ? undefined : `${t("Context used")}: ${percent}%`} aria-expanded={open} aria-controls={detailsId} onClick={onToggle}>
      {label}<ChevronDown aria-hidden="true" />
      <span className="agent-context-usage">{percent !== null ? `${percent}%` : context ? t("{used} tokens", { used: formatTokens(context.used) }) : t("Not reported")}</span>
      {percent !== null && <span className={`agent-context-track${percent >= 80 ? " is-high" : ""}`} aria-hidden="true"><span style={{ transform: `scaleX(${percent / 100})` }} /></span>}
    </button></h2>
    <div id={detailsId} className="agent-context-details" hidden={!open}>
      <ContextUsage context={context} />
    </div>
  </>;
}

/** A chat's pull requests, each with its CI (checks passed of all), and its uncommitted changes, as Claude's Changes lists them. */
function ChangesBody({ chat, refresh, onCount }: { chat: PanelChat; refresh: number; onCount?: (count: string | number | null) => void }) {
  const t = useT();
  const { pane, online } = chat;
  const directory = pane.foreground_cwd ?? pane.cwd;
  const changes = useRepoChangesSummary(pane.pane_id, directory ?? "", online, pane.finish_id);
  const prs = usePanePrs(pane.pane_id, directory ?? "", online, pane.finish_id, refresh);
  const [prMenu, setPrMenu] = useState<{ anchor: HTMLElement; url: string; title: string } | null>(null);
  const refreshChanges = changes.refresh;
  useEffect(() => { if (refresh > 0) refreshChanges(); }, [refresh]);
  const count = changes.listing ? changes.listing.total ?? `${changes.listing.files.length}${changes.listing.truncated ? "+" : ""}` : null;
  useEffect(() => { onCount?.(count); }, [onCount, count]);
  return <>
    {prs.length > 0 && <ul className="agent-pr-list">
      {prs.map((pr) => {
        const ci = pr.checks;
        const tone = !ci ? "" : ci.failed > 0 ? " is-failed" : ci.pending > 0 ? " is-pending" : " is-passed";
        const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : pr.state === "draft" ? GitPullRequestDraft : GitPullRequest;
        return <li key={pr.url} className={`agent-pr state-${pr.state}`}>
          <a className="agent-pr-main" href={pr.url} target="_blank" rel="noreferrer" title={`${pr.title}${pr.branch ? ` · ${pr.branch}` : ""}`}>
            <Icon className="agent-pr-icon" aria-label={t(pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.state === "draft" ? "Draft" : "Open")} />
            <span className="agent-pr-text">
              <span className="agent-pr-title">{pr.title}</span>
              <span className="agent-pr-meta">{pr.repo} #{pr.number}{pr.additions + pr.deletions > 0 && <> <span className="agent-change-added">+{pr.additions.toLocaleString()}</span> <span className="agent-change-removed">−{pr.deletions.toLocaleString()}</span></>}</span>
            </span>
            {ci && <span className={`agent-pr-ci${tone}`} title={t("CI: {passed} of {total} checks passed", { passed: ci.passed, total: ci.total })}><span className="agent-pr-ci-dot" aria-hidden="true" />{ci.passed}/{ci.total}</span>}
          </a>
          <button type="button" className="icon-button agent-pr-more" aria-label={t("More for {title}", { title: pr.title })} aria-haspopup="menu" onClick={(event) => setPrMenu({ anchor: event.currentTarget, url: pr.url, title: pr.title })}><Ellipsis aria-hidden="true" /></button>
        </li>;
      })}
    </ul>}
    {prMenu && <RowMenu anchor={prMenu.anchor} title={prMenu.title} onClose={() => setPrMenu(null)} items={[
      { id: "open", label: t("Open on GitHub"), icon: ExternalLink, run: () => { window.open(prMenu.url, "_blank", "noopener"); } },
      { id: "copy", label: t("Copy link"), icon: Link, run: () => { void copyText(prMenu.url); } },
    ]} />}
    {changes.error ? <p className="agent-panel-note">{diffErrorMessage(t, changes.error)}</p>
      : changes.loading && !changes.listing ? <p className="agent-panel-note" role="status">{t("Loading…")}</p>
      : !changes.listing ? <p className="agent-panel-note">{t("Changes unavailable")}</p>
      : changes.listing.files.length === 0 ? prs.length > 0 ? null : <p className="agent-panel-note">{t("No changes")}</p>
      : <button type="button" className="agent-panel-action agent-change-summary" onClick={() => chat.onBrowseFiles("changes")}>
        <FileDiff aria-hidden="true" />
        {(() => {
          // one line, as Claude desktop sums a branch: lines added and removed, or the file count when git gave no counts
          const files = changes.listing.files;
          const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
          return added + removed > 0
            ? <span><span className="agent-change-added">+{added.toLocaleString()}</span> <span className="agent-change-removed">−{removed.toLocaleString()}</span></span>
            : <span>{t(files.length === 1 ? "{n} file" : "{n} files", { n: changes.listing.total ?? files.length })}</span>;
        })()}
        <small className="agent-change-review">{t("Review")}</small>
      </button>}
  </>;
}
