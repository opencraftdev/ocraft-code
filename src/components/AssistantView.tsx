import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { AssistantAgent, AssistantMachine, AssistantProblem, AssistantProject, AssistantState, MergeMode, ProjectChange } from "../../shared/assistant.ts";
import { addAssistantProject, ApiError, changeAssistantProject, fetchAssistant, fixAssistantMachine, removeAssistantProject, setAssistantMaxRunning } from "../lib/api.ts";
import { ASSISTANT_INSTALL_COMMAND, assistantLink, storeAssistantAddress, storedAssistantAddress } from "../lib/assistantMode.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { Command } from "./PhonePanel.tsx";

import "./AssistantView.css";

/**
 * Assistant mode, in place of Code mode's panes. On the Assistant VM (the server says so, /api/health
 * `web_ui.assistant`) the layout later phases fill; on any other Ovis the setup page. The switch
 * between the two modes is the Claude app's Chat | Code one.
 */
export function AssistantView({ vm }: { vm: boolean }) {
  return vm ? <AssistantLayout /> : <AssistantSetup />;
}

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

function AssistantLayout() {
  const t = useT();
  const [state, setState] = useState<AssistantState | null>(null);
  const refresh = useCallback(() => fetchAssistant().then(setState, () => {}), []);
  // the server checks each machine every 30 s; this only reads what it found
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const machines = state?.machines ?? [];
  const projects = state?.projects ?? [];
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
        <Section title={t("Sessions")} empty />
      </nav>
      <main className="assistant-chat" aria-label={t("Chat")} />
      <aside className="assistant-board" aria-label={t("Tasks")}>
        <Section title={t("Tasks")} empty />
      </aside>
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
