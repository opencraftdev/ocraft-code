import { ChevronLeft, ChevronRight, Folder, MessageSquare, Monitor, Plus, SquarePen } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { AssistantAgent, AssistantMachine, AssistantProblem, AssistantProject, AssistantState, AssistantTask, AssistantTranscript, MergeMode, ProjectChange, TaskStatus } from "../../shared/assistant.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { addAssistantProject, ApiError, approveAssistantTask, cancelAssistantTask, changeAssistantProject, fetchAssistant, fetchAssistantTranscript, fetchPanePrompt, fixAssistantMachine, dismissAssistantTask, removeAssistantProject, restartAssistantTask, setAssistantMaxRunning, startAssistantSession } from "../lib/api.ts";
import { ASSISTANT_INSTALL_COMMAND, assistantLink, isAssistantPanelMessage, storeAssistantAddress, storedAssistantAddress } from "../lib/assistantMode.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { AssistantSetupDialog } from "./AssistantSetupDialog.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { Command } from "./PhonePanel.tsx";
import { PromptCard } from "./PromptCard.tsx";

import "./AssistantView.css";

/**
 * The Assistant in Code mode: its chat is an ordinary pane (the VM's Assistant workspace, tagged on
 * the machine's sidebar row), and beside it, in place of the agent panel, AssistantPanel: New chat,
 * the tasks, the earlier chats, the projects and the machines. On the VM itself the panel is drawn
 * here; on another Ovis it is the VM's own panel page in a frame (?assistant-panel=1).
 * Assistant mode is only the setup page, opened from the ⋯ menu of an Ovis that is not the VM.
 */
export function AssistantSetup({ onBack }: { onBack?: () => void }) {
  const t = useT();
  const [address, setAddress] = useState(storedAssistantAddress);
  const [settingUp, setSettingUp] = useState(false);
  const link = assistantLink(address);
  // the address the install printed: kept as one typed in the field is
  const found = useCallback((next: string) => { setAddress(next); storeAssistantAddress(next); }, []);
  return (
    <main className="assistant-setup" data-testid="assistant-setup">
      <div className="assistant-setup-inner">
        <h1 className="assistant-title">{t("Assistant")}</h1>
        <p>{t("The Assistant is a coding agent that runs all day on a cloud VM you own. You message it, it turns what you write into tasks, runs each one on the right PC in your tailnet, and brings back only what needs you. Run this on a fresh Linux VM to set it up:")}</p>
        <Command command={ASSISTANT_INSTALL_COMMAND} />
        <p>{t("Or set it up from here over SSH:")}</p>
        <div><button type="button" className="btn" onClick={() => setSettingUp(true)}>{t("Set up a VM")}</button></div>
        {settingUp && <AssistantSetupDialog onClose={() => setSettingUp(false)} onAddress={found} />}
        <label className="field assistant-address">
          <span className="field-label">{t("Assistant VM address")}</span>
          <input className="input" autoComplete="off" spellCheck={false} placeholder="ovis-assistant.your-tailnet.ts.net" value={address}
            onChange={(event) => { setAddress(event.target.value); storeAssistantAddress(event.target.value); }} />
        </label>
        {link !== null && <a href={link} target="_blank" rel="noreferrer">{link}</a>}
        <p className="assistant-dim">{t("Add the VM in Settings > Remote PCs: its Assistant chat shows in Code mode, with its tasks in the right panel.")}</p>
        {onBack && <div><button type="button" className="btn" onClick={onBack}>{t("Back to Code")}</button></div>}
      </div>
    </main>
  );
}

/** a task's pane in Code mode's own pane view: the machine it runs on, and the pane */
type OpenTask = (machineId: string, paneId: string) => void;

/**
 * Code mode's right panel beside the Assistant's chat: New chat, the tasks, the earlier chats (one
 * opens read only in the panel), the projects and the machines. `onSession`: a New chat's pane, for
 * the Ovis showing the chat to select.
 */
export function AssistantPanel({ initial = null, onOpenTask, onSession }: { initial?: AssistantState | null; onOpenTask?: OpenTask; onSession?: (paneId: string) => void }) {
  const t = useT();
  const locale = useLocale();
  // `initial`: what shows before the first read (a test's state)
  const [state, setState] = useState<AssistantState | null>(initial);
  // an earlier chat, read only in the panel; null: the tasks and lists
  const [shown, setShown] = useState<string | null>(null);
  const refresh = useCallback(() => fetchAssistant().then(setState, () => {}), []);
  // the server checks each machine every 30 s; this only reads what it found
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const machines = state?.machines ?? [];
  const projects = state?.projects ?? [];
  const archived = (state?.sessions ?? []).filter((session) => session.archived_at !== undefined);
  const started = (next: AssistantState) => {
    setState(next); setShown(null);
    const pane = next.sessions.find((session) => session.archived_at === undefined)?.pane_id;
    if (pane) onSession?.(pane);
  };
  if (shown !== null) return (
    <div className="agent-panel-card assistant-panel" data-testid="assistant-panel">
      <section className="agent-panel-section" aria-label={t("Earlier chats")}>
        <header className="agent-panel-section-head">
          <button type="button" className="icon-button" aria-label={t("Back")} title={t("Back")} onClick={() => setShown(null)}><ChevronLeft aria-hidden="true" /></button>
          <h2>{clockTime(locale, archived.find((session) => session.name === shown)?.started_at ?? 0)}</h2>
        </header>
        <div className="agent-panel-environment-body"><ArchivedSession key={shown} name={shown} /></div>
      </section>
    </div>
  );
  const tasks = state?.tasks ?? [];
  return (
    <div className="agent-panel-card assistant-panel" data-testid="assistant-panel">
      <PanelSection title={t("Assistant")}>
        <NewChat onStarted={started} />
        <p className="agent-panel-environment-row"><Monitor aria-hidden="true" /><span>{machines.length === 1 ? t("1 machine") : t("{n} machines", { n: machines.length })}</span></p>
        <p className="agent-panel-environment-row"><Folder aria-hidden="true" /><span>{projects.length === 1 ? t("1 project") : t("{n} projects", { n: projects.length })}</span></p>
      </PanelSection>
      <PanelSection title={t("Tasks")} count={tasks.length || undefined}>
        <TaskBoard tasks={tasks} projects={projects} machines={machines} onChange={setState} onOpenTask={onOpenTask} />
      </PanelSection>
      {archived.length > 0 && <PanelSection title={t("Earlier chats")} count={archived.length}>
        {archived.map((session) => (
          <button key={session.name} type="button" className="agent-panel-environment-row assistant-row" title={session.name} onClick={() => setShown(session.name)}>
            <MessageSquare aria-hidden="true" /><span>{clockTime(locale, session.started_at)}</span><ChevronRight className="assistant-row-arrow" aria-hidden="true" />
          </button>
        ))}
      </PanelSection>}
      <Projects projects={projects} machines={machines} loaded={state !== null} refresh={refresh} />
      <PanelSection title={t("Machines")} count={machines.length || undefined}>
        {machines.map((machine) => <MachineRow key={machine.id} machine={machine} onChange={setState} refresh={refresh} />)}
        {state !== null && machines.length === 0 && <>
          <p className="assistant-empty">{t("None yet")}</p>
          <details className="assistant-help">
            <summary>{t("How to add")}</summary>
            <p>{t("The Assistant uses herdr's saved machines. Add one on this VM with herdr machine add <alias> ssh://user@host, then Connect it in Settings > Remote PCs.")}</p>
          </details>
        </>}
      </PanelSection>
    </div>
  );
}

/** one of the panel's sections, as the agent panel draws Environment, Context and Changes (AgentPanel.css) */
function PanelSection({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="agent-panel-section assistant-panel-section" aria-label={title}>
      <header className="agent-panel-section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="agent-panel-count">{count}</span>}
        {action}
      </header>
      <div className="agent-panel-environment-body">{children}</div>
    </section>
  );
}

/**
 * The VM's panel in a frame, for an Ovis that is not the VM. A New chat there names its pane in a
 * message; only one from the VM's own origin, well formed (lib/assistantMode.ts), is acted on.
 */
export function AssistantPanelFrame({ src, onSession }: { src: string; onSession(paneId: string): void }) {
  const t = useT();
  useEffect(() => {
    const origin = new URL(src).origin;
    const listen = (event: MessageEvent) => { if (event.origin === origin && isAssistantPanelMessage(event.data)) onSession(event.data.paneId); };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [src, onSession]);
  return <iframe className="assistant-panel-frame" src={src} title={t("Assistant")} />;
}

/** New chat: only on this click. The pane before it is archived and stays readable in Sessions. */
function NewChat({ onStarted, primary = false }: { onStarted(state: AssistantState): void; primary?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setBusy(true); setError(null);
    startAssistantSession().then(onStarted, (failure: unknown) => setError(failure instanceof ApiError ? failure.detail : String(failure))).finally(() => setBusy(false));
  };
  return <>
    <button type="button" className={primary ? "btn btn-primary" : "agent-panel-action"} disabled={busy} onClick={start}>{!primary && <SquarePen aria-hidden="true" />}<span>{t("New chat")}</span></button>
    {error !== null && <p className={primary ? "assistant-error" : "sidebar-inline-error"} role="alert">{error}</p>}
  </>;
}

/** An archived session, read only: the conversation saved as it was archived. */
function ArchivedSession({ name }: { name: string }) {
  const t = useT();
  const [transcript, setTranscript] = useState<AssistantTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchAssistantTranscript(name).then(setTranscript, (failure: unknown) => setError(failure instanceof ApiError ? failure.detail : String(failure))); }, [name]);
  if (error !== null) return <p className="assistant-error" role="alert">{error}</p>;
  if (transcript === null) return <p className="assistant-dim">{t("Loading…")}</p>;
  return (
    <div className="assistant-transcript" aria-label={t("Archived session")}>
      {transcript.turns.map((turn, index) => (
        <div key={index} className={`assistant-turn is-${turn.role}`}>
          <span className="assistant-dim">{turn.role === "user" ? t("You") : t("Assistant")}</span>
          {/* the chat lens draws answers as Markdown: an archived one reads the same */}
          <Markdown className="assistant-turn-text">{turn.text}</Markdown>
        </div>
      ))}
      {transcript.turns.length === 0 && (transcript.text ? <pre className="assistant-screen">{transcript.text}</pre> : <p className="assistant-dim">{t("Nothing was said in this session.")}</p>)}
    </div>
  );
}

/** The board's columns, in the plan's order: what needs the user first. An empty one is left out. */
const COLUMNS: readonly (readonly TaskStatus[])[] = [["needs_you", "failed"], ["ready", "reviewing"], ["merging"], ["working"], ["queued", "todo"], ["scheduled"], ["done", "cancelled"]];

function columnTitle(t: Translate, first: TaskStatus): string {
  switch (first) {
    case "needs_you": return t("Needs you");
    case "ready": return t("Ready");
    case "merging": return t("Merging");
    case "working": return t("Working");
    case "queued": return t("Queued");
    case "scheduled": return t("Scheduled");
    default: return t("Done");
  }
}

/** A task's status in a word, for its card's pill; its tone is the status color of its column. */
function statusWord(t: Translate, task: AssistantTask): string {
  switch (task.status) {
    case "failed": return t("Failed");
    case "reviewing": return t("Review round {n}", { n: task.reviewRounds ?? 1 });
    case "cancelled": return t("Cancelled");
    default: return columnTitle(t, COLUMNS.find((statuses) => statuses.includes(task.status))![0]!);
  }
}

function statusTone(status: TaskStatus): string {
  if (status === "needs_you" || status === "failed") return "blocked";
  if (status === "working" || status === "reviewing" || status === "merging") return "working";
  if (status === "ready" || status === "done") return "done";
  return "idle";
}

/**
 * The tasks as a side panel, as the Claude app's right panel is: a quiet head per status with its
 * count, what needs the user first, newest first in each. A card opens its pane in Code mode; a
 * Needs you card answers its agent's question in place with the chat's own prompt card, through
 * the machine's prompt-answer route.
 */
function TaskBoard({ tasks, projects, machines, onChange, onOpenTask }: { tasks: AssistantTask[]; projects: AssistantProject[]; machines: AssistantMachine[]; onChange(state: AssistantState): void; onOpenTask?: OpenTask }) {
  const t = useT();
  const locale = useLocale();
  const columns = COLUMNS.map((statuses) => ({ statuses, tasks: tasks.filter((task) => statuses.includes(task.status)) })).filter((column) => column.tasks.length > 0);
  return (
    <>
      {columns.length === 0 && <p className="assistant-empty assistant-board-empty">{t("No tasks yet")}</p>}
      {columns.map(({ statuses, tasks: shown }) => (
        <section key={statuses[0]} className="assistant-task-group" data-column={statuses[0]}>
          <h3 className="agent-panel-section-label">{columnTitle(t, statuses[0]!)}<span>{shown.length}</span></h3>
          {shown.map((task) => <TaskCard key={task.id} task={task} project={projects.find((project) => project.id === task.project)}
            machineName={machines.find((machine) => machine.id === task.machine)?.name ?? task.machine}
            waiting={waitReason(t, locale, task, tasks, machines)} onChange={onChange} onOpenTask={onOpenTask} />)}
        </section>
      ))}
    </>
  );
}

/** a time on the board: its clock time today, with the date on another day */
function clockTime(locale: string, ms: number): string {
  const at = new Date(ms);
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What a Queued or Scheduled task waits for, as the server's queue decides it (server/assistant-tasks.ts). */
function waitReason(t: Translate, locale: string, task: AssistantTask, tasks: AssistantTask[], machines: AssistantMachine[]): string | null {
  if (task.status === "scheduled") {
    if (task.cron !== undefined) return task.next === undefined ? t("Every {cron}", { cron: task.cron }) : t("Every {cron}, next {time}", { cron: task.cron, time: clockTime(locale, task.next) });
    return task.at === undefined ? null : t("At {time}", { time: clockTime(locale, Date.parse(task.at)) });
  }
  if (task.status !== "queued") return null;
  const after = tasks.find((candidate) => candidate.id === task.after);
  if (after && after.status !== "done") return t("After #{id} {title}", { id: after.id, title: after.title });
  const machine = machines.find((candidate) => candidate.id === task.machine);
  if (machine?.state !== "connected") return t("Waiting for {machine}", { machine: machine?.name ?? task.machine });
  return t("Waiting for a free slot on {machine}", { machine: machine.name });
}

function TaskCard({ task, project, machineName, waiting, onChange, onOpenTask }: { task: AssistantTask; project: AssistantProject | undefined; machineName: string; waiting: string | null; onChange(state: AssistantState): void; onOpenTask?: OpenTask }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paneId = task.paneId;
  // Approve asks once, on every device (a phone's stray tap included): a merge is not undone
  const [confirming, setConfirming] = useState(false);
  const mergeable = task.status === "ready" || (task.status === "needs_you" && task.reason !== undefined);
  const dismissable = task.status === "cancelled" || task.status === "failed" || (task.status === "done" && task.worktree !== null);
  // only on these clicks: nothing restarts, cancels, merges or dismisses a task by itself
  const act = (action: (id: string) => Promise<AssistantState>) => {
    setBusy(true); setError(null);
    action(task.id).then(onChange, (failure: unknown) => setError(failure instanceof ApiError ? failure.detail : String(failure))).finally(() => setBusy(false));
  };
  return (
    <div className="assistant-task">
      <button type="button" className="assistant-task-open" disabled={paneId === null || task.status === "cancelled" || !onOpenTask} onClick={() => paneId !== null && onOpenTask?.(task.machine, paneId)}>
        <span className="assistant-task-head">
          <span className="assistant-task-title">{task.title}</span>
          <span className={`assistant-pill is-${statusTone(task.status)}`}>{statusWord(t, task)}</span>
        </span>
        <span className="assistant-dim" title={task.cron === undefined ? task.branch : undefined}>#{task.id} · {project?.id ?? task.project} · {machineName}</span>
      </button>
      {task.status === "failed" && (
        <div className="assistant-problem">
          <span>{task.error ?? t("Failed")}</span>
          {task.worktree !== null && <button type="button" className="btn" disabled={busy} onClick={() => act(restartAssistantTask)}>{t("Restart agent")}</button>}
        </div>
      )}
      {task.reviewed && task.status !== "done" && <p className="assistant-dim">{t("Review passed")}</p>}
      {task.status === "needs_you" && task.reason !== undefined && <p className="assistant-problem">{task.reason}</p>}
      {task.findings !== undefined && task.status !== "done" && <pre className="assistant-findings">{task.findings}</pre>}
      {mergeable && (
        <p className="assistant-dim">
          {task.nothingToMerge ? t("Nothing to merge")
            : task.prUrl !== undefined ? <a href={task.prUrl} target="_blank" rel="noreferrer">{t("Pull request")}</a>
            : project?.mergeMode === "local" && task.base !== undefined ? t("Ready to merge into {base}", { base: task.base }) : null}
        </p>
      )}
      {task.note !== undefined && <p className="assistant-dim">{task.note}</p>}
      {(mergeable || dismissable) && (
        <div className="assistant-inline">
          {mergeable && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirming(true)}>{t("Approve")}</button>}
          {dismissable && <button type="button" className="btn" disabled={busy} onClick={() => act(dismissAssistantTask)}>{t("Dismiss")}</button>}
        </div>
      )}
      {confirming && (
        <ConfirmDialog title={t("Merge {title}?", { title: task.title })}
          body={task.prUrl !== undefined ? t("This merges its pull request.") : task.base !== undefined ? t("This merges its branch into {base}.", { base: task.base }) : t("This merges its branch.")}
          confirmLabel={t("Approve")}
          onConfirm={async () => { onChange(await approveAssistantTask(task.id)); setConfirming(false); }}
          onClose={() => setConfirming(false)} />
      )}
      {waiting !== null && (
        <div className="assistant-problem">
          <span className="assistant-dim">{waiting}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => act(cancelAssistantTask)}>{t("Cancel")}</button>
        </div>
      )}
      {task.status === "needs_you" && task.reason === undefined && paneId !== null && <TaskQuestion machineId={task.machine} paneId={paneId} />}
      {error !== null && <p className="assistant-error" role="alert">{error}</p>}
    </div>
  );
}

/** The question a Needs you task's agent shows, read from its machine and answered with the chat's prompt card. */
function TaskQuestion({ machineId, paneId }: { machineId: string; paneId: string }) {
  const [prompt, setPrompt] = useState<InteractivePrompt | null>(null);
  const read = useCallback(() => fetchPanePrompt(paneId, machineId).then(setPrompt, () => setPrompt(null)), [machineId, paneId]);
  useEffect(() => { void read(); }, [read]);
  if (prompt === null) return null;
  return (
    <MachineContext.Provider value={machineId}>
      <PromptCard key={prompt.id} paneId={paneId} prompt={prompt} onPromptChanged={() => void read()} onAnswered={() => void read()} />
    </MachineContext.Provider>
  );
}

function problemText(t: Translate, problem: AssistantProblem): string {
  switch (problem) {
    case "not_connected": return t("Not connected yet: choose Connect on it in Settings > Remote PCs");
    case "unreachable": return t("SSH cannot reach it");
    case "windows": return t("Windows isn't supported by the Assistant yet");
    case "herdr_stopped": return t("herdr is not running");
    case "no_agent": return t("Neither Claude Code nor Codex is installed");
    case "gh_signed_out": return t("GitHub CLI is not signed in (gh auth login)");
  }
}

/** A refused request in the UI language, by the server's code (ProjectRefusal in shared/assistant.ts). */
function refusalText(t: Translate, error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "invalid_path": return t("Enter an absolute folder path, or one that starts with ~/");
    case "missing": return t("That folder does not exist on the machine");
    case "not_git": return t("That folder is not the top folder of a git repository");
    case "root": return t("The root folder cannot be a project");
    case "home": return t("The home folder cannot be a project");
    case "home_parent": return t("A folder that holds the home folder cannot be a project");
    case "duplicate": return t("That folder is already a project");
    case "unknown_machine": return t("That machine is not one of herdr's saved machines");
    case "windows": return t("Windows isn't supported by the Assistant yet");
    default: return error instanceof ApiError ? error.detail : String(error);
  }
}

function MachineRow({ machine, onChange, refresh }: { machine: AssistantMachine; onChange(state: AssistantState): void; refresh(): Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const health = machine.health;
  // runs only on this click: the watcher never fixes anything by itself
  const startHerdr = () => {
    setBusy(true); setError(null);
    fixAssistantMachine(machine.id, "start_herdr").then(onChange, (failure: unknown) => setError(refusalText(t, failure))).finally(() => setBusy(false));
  };
  const saveMax = (value: string) => {
    const next = Number(value);
    if (next === machine.maxRunning) return;
    setError(null);
    setAssistantMaxRunning(machine.id, next).then(refresh, (failure: unknown) => setError(refusalText(t, failure)));
  };
  const [open, setOpen] = useState(false);
  // its dot: green when every check passed, red with a problem, pulsing while the first check runs
  const dot = health === null ? "connecting" : health.problems.length === 0 ? "connected" : "error";
  const word = health === null ? t("Checking…") : health.problems.length === 0 ? t("Ready") : problemText(t, health.problems[0]!);
  return (
    <div className="assistant-item-group">
      <button type="button" className="agent-panel-environment-row assistant-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Monitor aria-hidden="true" /><span>{machine.name}</span>
        <span className={`machine-dot is-${dot}`} role="img" aria-label={word} title={word} />
      </button>
      {health !== null && health.problems.map((problem) => (
        <div key={problem} className="assistant-problem assistant-item-detail">
          <span title={problem === "unreachable" ? health.error : undefined}>{problemText(t, problem)}</span>
          {problem === "herdr_stopped" && <button type="button" className="btn" disabled={busy} onClick={startHerdr}>{t("Start herdr")}</button>}
        </div>
      ))}
      {error !== null && <p className="sidebar-inline-error" role="alert">{error}</p>}
      {open && <label className="assistant-inline assistant-item-detail">
        <span>{t("Max running tasks")}</span>
        <input className="input" type="number" min={1} max={20} defaultValue={machine.maxRunning} onBlur={(event) => saveMax(event.target.value)} />
      </label>}
    </div>
  );
}

/** The projects: a row each, opened for its settings, and Add project (the head's + or the empty line's link). */
function Projects({ projects, machines, loaded, refresh }: { projects: AssistantProject[]; machines: AssistantMachine[]; loaded: boolean; refresh(): Promise<void> }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  return (
    <PanelSection title={t("Projects")} count={projects.length || undefined}
      action={machines.length > 0 && <button type="button" className="icon-button" aria-label={t("Add project")} title={t("Add project")} aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus aria-hidden="true" /></button>}>
      {projects.map((project) => <ProjectRow key={project.id} project={project} machine={machines.find((machine) => machine.id === project.machine)} refresh={refresh} />)}
      {loaded && projects.length === 0 && !adding && (
        <p className="assistant-empty">{t("None yet")}{machines.length > 0 && <> · <button type="button" className="assistant-link" onClick={() => setAdding(true)}>{t("Add project")}</button></>}</p>
      )}
      {adding && machines.length > 0 && <AddProject machines={machines} refresh={refresh} onAdded={() => setAdding(false)} />}
    </PanelSection>
  );
}

function AgentSelect({ value, onChange }: { value: AssistantAgent; onChange(agent: AssistantAgent): void }) {
  const t = useT();
  return (
    <select className="input" aria-label={t("Default agent")} value={value} onChange={(event) => onChange(event.target.value as AssistantAgent)}>
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
    </select>
  );
}

function ProjectRow({ project, machine, refresh }: { project: AssistantProject; machine: AssistantMachine | undefined; refresh(): Promise<void> }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const change = (next: ProjectChange) => { setError(null); changeAssistantProject(project.id, next).then(refresh, (failure: unknown) => setError(refusalText(t, failure))); };
  const remove = () => { setError(null); removeAssistantProject(project.id).then(refresh, (failure: unknown) => setError(refusalText(t, failure))); };
  const [open, setOpen] = useState(false);
  return (
    <div className="assistant-item-group">
      <button type="button" className="sidebar-nav-item assistant-item" aria-expanded={open} title={project.path} onClick={() => setOpen(!open)}>
        <Folder aria-hidden="true" /><span className="assistant-item-name">{project.id}</span>
        <span className="assistant-item-meta">{machine?.name ?? project.machine}</span>
      </button>
      {open && <div className="assistant-inline assistant-item-detail">
        <p className="assistant-dim assistant-path">{project.path}</p>
        <select className="input" aria-label={t("Merge")} value={project.mergeMode} onChange={(event) => change({ mergeMode: event.target.value as MergeMode })}>
          <option value="pr">{t("Pull request")}</option>
          <option value="local">{t("Local merge")}</option>
        </select>
        <AgentSelect value={project.defaultAgent} onChange={(defaultAgent) => change({ defaultAgent })} />
        <button type="button" className="btn btn-ghost" onClick={remove}>{t("Remove")}</button>
      </div>}
      {error !== null && <p className="sidebar-inline-error" role="alert">{error}</p>}
    </div>
  );
}

/** Only the user adds a project, here: the Assistant itself can list projects but never add one. */
function AddProject({ machines, refresh, onAdded }: { machines: AssistantMachine[]; refresh(): Promise<void>; onAdded(): void }) {
  const t = useT();
  const [machine, setMachine] = useState(machines[0]!.id);
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<AssistantAgent>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    addAssistantProject({ machine, path, defaultAgent: agent })
      .then(() => { setPath(""); onAdded(); return refresh(); }, (failure: unknown) => setError(refusalText(t, failure)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="assistant-add" onSubmit={submit}>
      <select className="input" aria-label={t("Machine")} value={machine} onChange={(event) => setMachine(event.target.value)}>
        {machines.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
      <input className="input" aria-label={t("Folder")} autoComplete="off" spellCheck={false} placeholder="~/code/my-app" value={path} onChange={(event) => setPath(event.target.value)} />
      <AgentSelect value={agent} onChange={setAgent} />
      {error !== null && <p className="assistant-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || path.trim() === ""}>{t("Add project")}</button>
    </form>
  );
}
