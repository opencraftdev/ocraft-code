import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { AssistantAgent, AssistantMachine, AssistantProblem, AssistantProject, AssistantSession, AssistantState, AssistantTask, AssistantTranscript, MergeMode, ProjectChange, TaskStatus } from "../../shared/assistant.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { addAssistantProject, ApiError, approveAssistantTask, cancelAssistantTask, changeAssistantProject, fetchAssistant, fetchAssistantTranscript, fetchPanePrompt, fixAssistantMachine, dismissAssistantTask, removeAssistantProject, restartAssistantTask, setAssistantMaxRunning, startAssistantSession } from "../lib/api.ts";
import { ASSISTANT_INSTALL_COMMAND, assistantLink, storeAssistantAddress, storedAssistantAddress } from "../lib/assistantMode.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Command } from "./PhonePanel.tsx";
import { PromptCard } from "./PromptCard.tsx";

import "./AssistantView.css";

/**
 * Assistant mode, in place of Code mode's panes. On the Assistant VM (the server says so, /api/health
 * `web_ui.assistant`) the layout later phases fill; on any other Ovis the setup page. The switch
 * between the two modes is the Claude app's Chat | Code one.
 */
export function AssistantView({ vm, renderChat, onOpenTask }: { vm: boolean; renderChat?: (paneId: string) => ReactNode; onOpenTask?: OpenTask }) {
  return vm ? <AssistantLayout renderChat={renderChat} onOpenTask={onOpenTask} /> : <AssistantSetup />;
}

/** a task's pane in Code mode's own pane view: the machine it runs on, and the pane */
type OpenTask = (machineId: string, paneId: string) => void;

function AssistantSetup() {
  const t = useT();
  const [address, setAddress] = useState(storedAssistantAddress);
  const link = assistantLink(address);
  return (
    <main className="assistant-setup" data-testid="assistant-setup">
      <div className="assistant-setup-inner">
        <h1 className="assistant-title">{t("Assistant")}</h1>
        <p>{t("The Assistant is a coding agent that runs all day on a cloud VM you own. You message it, it turns what you write into tasks, runs each one on the right PC in your tailnet, and brings back only what needs you. Run this on a fresh Linux VM to set it up:")}</p>
        <Command command={ASSISTANT_INSTALL_COMMAND} />
        <label className="field assistant-address">
          <span className="field-label">{t("Assistant VM address")}</span>
          <input className="input" autoComplete="off" spellCheck={false} placeholder="ovis-assistant.your-tailnet.ts.net" value={address}
            onChange={(event) => { setAddress(event.target.value); storeAssistantAddress(event.target.value); }} />
        </label>
        {link !== null && <a href={link} target="_blank" rel="noreferrer">{link}</a>}
      </div>
    </main>
  );
}

function AssistantLayout({ renderChat, onOpenTask }: { renderChat?: (paneId: string) => ReactNode; onOpenTask?: OpenTask }) {
  const t = useT();
  const [state, setState] = useState<AssistantState | null>(null);
  // the archived session shown read only; null: the current one, live
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
  const sessions = state?.sessions ?? [];
  const current = sessions.find((session) => session.archived_at === undefined) ?? null;
  return (
    <div className="assistant-layout" data-testid="assistant-layout">
      <nav className="assistant-sidebar" aria-label={t("Assistant")}>
        <Section title={t("Machines")} empty={machines.length === 0}>
          {machines.map((machine) => <MachineRow key={machine.id} machine={machine} onChange={setState} refresh={refresh} />)}
        </Section>
        <Section title={t("Projects")} empty={projects.length === 0}>
          {projects.map((project) => <ProjectRow key={project.id} project={project} machine={machines.find((machine) => machine.id === project.machine)} refresh={refresh} />)}
          {machines.length > 0 && <AddProject machines={machines} refresh={refresh} />}
        </Section>
        <Section title={t("Sessions")} empty={sessions.length === 0}>
          {sessions.map((session) => (
            <button key={session.name} type="button" className="assistant-session" aria-current={(shown ?? current?.name) === session.name ? "true" : undefined}
              onClick={() => setShown(session === current ? null : session.name)}>
              {session.name}{session === current && <span className="assistant-dim"> · {t("Current")}</span>}
            </button>
          ))}
        </Section>
      </nav>
      <main className="assistant-chat" aria-label={t("Chat")}>
        <SessionBar current={current} onStarted={(next) => { setState(next); setShown(null); }} />
        {shown !== null ? <ArchivedSession key={shown} name={shown} />
          : current === null ? <p className="assistant-chat-note">{t("No Assistant session yet. Start one with New chat.")}</p>
          : (current.pane_id !== null && renderChat?.(current.pane_id)) || <p className="assistant-chat-note">{t("The Assistant's pane is not open. Start a new chat.")}</p>}
      </main>
      <aside className="assistant-board" aria-label={t("Tasks")}>
        <TaskBoard tasks={state?.tasks ?? []} projects={projects} machines={machines} onChange={setState} onOpenTask={onOpenTask} />
      </aside>
    </div>
  );
}

/** New session: only on this click. The pane before it is archived and stays readable in Sessions. */
function SessionBar({ current, onStarted }: { current: AssistantSession | null; onStarted(state: AssistantState): void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setBusy(true); setError(null);
    startAssistantSession().then(onStarted, (failure: unknown) => setError(failure instanceof ApiError ? failure.detail : String(failure))).finally(() => setBusy(false));
  };
  return (
    <div className="assistant-chat-bar">
      <span className="assistant-row-name">{current?.name ?? t("Assistant")}</span>
      {error !== null && <span className="assistant-error" role="alert">{error}</span>}
      <button type="button" className="btn" disabled={busy} onClick={start}>{t("New chat")}</button>
    </div>
  );
}

/** An archived session, read only: the conversation saved as it was archived. */
function ArchivedSession({ name }: { name: string }) {
  const t = useT();
  const [transcript, setTranscript] = useState<AssistantTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchAssistantTranscript(name).then(setTranscript, (failure: unknown) => setError(failure instanceof ApiError ? failure.detail : String(failure))); }, [name]);
  if (error !== null) return <p className="assistant-error assistant-chat-note" role="alert">{error}</p>;
  if (transcript === null) return <p className="assistant-dim assistant-chat-note">{t("Loading…")}</p>;
  return (
    <div className="assistant-transcript" aria-label={t("Archived session")}>
      {transcript.turns.map((turn, index) => (
        <div key={index} className={`assistant-turn is-${turn.role}`}>
          <span className="assistant-dim">{turn.role === "user" ? t("You") : t("Assistant")}</span>
          <p>{turn.text}</p>
        </div>
      ))}
      {transcript.turns.length === 0 && (transcript.text ? <pre className="assistant-screen">{transcript.text}</pre> : <p className="assistant-dim">{t("Nothing was said in this session.")}</p>)}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: boolean; children?: ReactNode }) {
  const t = useT();
  return (
    <section className="assistant-section">
      <h2 className="sidebar-section-label">{title}</h2>
      {empty && <p className="assistant-empty">{t("None yet")}</p>}
      {children}
    </section>
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

/**
 * The task board, as Linear's and Conductor's boards are: one column per status, newest first in
 * each. A card opens its pane in Code mode; a Needs you card answers its agent's question in place
 * with the chat's own prompt card, through the machine's prompt-answer route.
 */
function TaskBoard({ tasks, projects, machines, onChange, onOpenTask }: { tasks: AssistantTask[]; projects: AssistantProject[]; machines: AssistantMachine[]; onChange(state: AssistantState): void; onOpenTask?: OpenTask }) {
  const t = useT();
  const locale = useLocale();
  const columns = COLUMNS.map((statuses) => ({ statuses, tasks: tasks.filter((task) => statuses.includes(task.status)) })).filter((column) => column.tasks.length > 0);
  return (
    <>
      <Section title={t("Tasks")} empty={columns.length === 0} />
      {columns.map(({ statuses, tasks: shown }) => (
        <section key={statuses[0]} className="assistant-section" data-column={statuses[0]}>
          <h3 className="assistant-column">{columnTitle(t, statuses[0]!)} <span className="assistant-dim">{shown.length}</span></h3>
          {shown.map((task) => <TaskCard key={task.id} task={task} project={projects.find((project) => project.id === task.project)} waiting={waitReason(t, locale, task, tasks, machines)} onChange={onChange} onOpenTask={onOpenTask} />)}
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

function TaskCard({ task, project, waiting, onChange, onOpenTask }: { task: AssistantTask; project: AssistantProject | undefined; waiting: string | null; onChange(state: AssistantState): void; onOpenTask?: OpenTask }) {
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
    <div className="assistant-row assistant-task">
      <button type="button" className="assistant-task-open" disabled={paneId === null || task.status === "cancelled" || !onOpenTask} onClick={() => paneId !== null && onOpenTask?.(task.machine, paneId)}>
        <span className="assistant-row-name">{task.title}</span>
        <span className="assistant-dim">#{task.id} · {project?.id ?? task.project}{task.cron === undefined ? ` · ${task.branch}` : ""}</span>
      </button>
      {task.status === "cancelled" && <p className="assistant-dim">{t("Cancelled")}</p>}
      {task.status === "failed" && (
        <div className="assistant-problem">
          <span>{task.error ?? t("Failed")}</span>
          {task.worktree !== null && <button type="button" className="btn" disabled={busy} onClick={() => act(restartAssistantTask)}>{t("Restart agent")}</button>}
        </div>
      )}
      {task.status === "reviewing" && <p className="assistant-dim">{t("Review round {n}", { n: task.reviewRounds ?? 1 })}</p>}
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
  return (
    <div className="assistant-row">
      <span className="assistant-row-name">{machine.name}</span>
      {health === null ? <p className="assistant-dim">{t("Checking…")}</p>
        : health.problems.length === 0 ? <p className="assistant-dim">{t("Ready")}</p>
        : health.problems.map((problem) => (
          <div key={problem} className="assistant-problem">
            <span title={problem === "unreachable" ? health.error : undefined}>{problemText(t, problem)}</span>
            {problem === "herdr_stopped" && <button type="button" className="btn" disabled={busy} onClick={startHerdr}>{t("Start herdr")}</button>}
          </div>
        ))}
      {error !== null && <p className="assistant-error" role="alert">{error}</p>}
      <label className="assistant-inline">
        <span>{t("Max running tasks")}</span>
        <input className="input" type="number" min={1} max={20} defaultValue={machine.maxRunning} onBlur={(event) => saveMax(event.target.value)} />
      </label>
    </div>
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
  return (
    <div className="assistant-row">
      <span className="assistant-row-name">{project.id}</span>
      <p className="assistant-dim" title={project.path}>{machine?.name ?? project.machine} · {project.path}</p>
      <div className="assistant-inline">
        <select className="input" aria-label={t("Merge")} value={project.mergeMode} onChange={(event) => change({ mergeMode: event.target.value as MergeMode })}>
          <option value="pr">{t("Pull request")}</option>
          <option value="local">{t("Local merge")}</option>
        </select>
        <AgentSelect value={project.defaultAgent} onChange={(defaultAgent) => change({ defaultAgent })} />
        <button type="button" className="btn btn-ghost" onClick={remove}>{t("Remove")}</button>
      </div>
      {error !== null && <p className="assistant-error" role="alert">{error}</p>}
    </div>
  );
}

/** Only the user adds a project, here: the Assistant itself can list projects but never add one. */
function AddProject({ machines, refresh }: { machines: AssistantMachine[]; refresh(): Promise<void> }) {
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
      .then(() => { setPath(""); return refresh(); }, (failure: unknown) => setError(refusalText(t, failure)))
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
