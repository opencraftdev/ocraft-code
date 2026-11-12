import { useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import type { AssistantAgent, AssistantSetupEvent, AssistantSetupJob, AssistantSetupMachine } from "../../shared/assistant.ts";
import { answerAssistantSetup, ApiError, assistantSetupInput, fetchAssistantSetupMachines, resizeAssistantSetup, startAssistantSetup, stopAssistantSetup } from "../lib/api.ts";
import { keepEventStream } from "../lib/eventStream.ts";
import { TERMINAL_FONT_STACK } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";
import { terminalTheme, useSettings } from "../lib/settings.ts";
import { isWebLink, openWebLink } from "../lib/terminalFileLinks.ts";
import { HostKeyQuestion } from "./MachineDialog.tsx";
import { Command } from "./PhonePanel.tsx";
import "./Machines.css";
import "./AssistantView.css";

const ACTIVE: readonly AssistantSetupJob["phase"][] = ["connecting", "authentication", "running"];
const errorText = (error: unknown) => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);
/** a machine's label as a Tailscale machine name, by the install script's rule (lowercase letters, digits, inner hyphens) */
export const machineSlug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ovis-assistant";
/** the machine choice that means the SSH address typed below */
const OTHER = "";

/**
 * Set up a VM: one of this Ovis's connected Linux machines (over the SSH Remote PCs already trusts)
 * or another computer's SSH address, the machine name and agent, then the host-key and password questions Add PC
 * asks, then the install's own terminal (server/assistant-setup.ts). The address it prints goes to
 * `onAddress`. Closing while it runs asks first, and stops it.
 */
export function AssistantSetupDialog({ onClose, onAddress }: { onClose(): void; onAddress(address: string): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [job, setJob] = useState<AssistantSetupJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const active = job !== null && ACTIVE.includes(job.phase);
  const showForm = job === null || job.phase === "failed" || job.phase === "stopped";
  const [machines, setMachines] = useState<AssistantSetupMachine[]>([]);
  const [choice, setChoice] = useState(OTHER);
  const [name, setName] = useState("ovis-assistant");
  const choose = (id: string, list = machines) => {
    setChoice(id);
    const machine = list.find((candidate) => candidate.id === id);
    if (machine) setName(machineSlug(machine.name));
  };
  useEffect(() => {
    fetchAssistantSetupMachines().then((list) => { setMachines(list); if (list[0]) choose(list[0].id, list); }, () => {});
  }, []);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (job?.address) onAddress(job.address); }, [job?.address, onAddress]);

  const close = () => { if (active) setConfirmStop(true); else onClose(); };
  const stopAndClose = async () => {
    setPending(true);
    try { await stopAssistantSetup(); onClose(); }
    catch (cause) { setError(errorText(cause)); setPending(false); setConfirmStop(false); }
  };
  const begin = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const port = String(data.get("port") ?? "").trim();
    setPending(true); setError(null);
    try {
      const where = choice !== OTHER ? { machineId: choice } : { destination: String(data.get("destination") ?? "").trim(), ...(port ? { port: Number(port) } : {}) };
      setJob(await startAssistantSetup({ ...where, name: name.trim(), agent: String(data.get("agent")) as AssistantAgent }));
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  };
  const answer = async (value: string) => {
    if (!job?.challenge) return;
    setPending(true); setError(null);
    try { setJob(await answerAssistantSetup(job.challenge.id, value)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  };

  return <dialog ref={dialog} className="modal machine-dialog assistant-setup-dialog" aria-labelledby="assistant-setup-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="modal-header"><h2 id="assistant-setup-title" className="modal-title"><Bot size={18} /> {t("Set up a VM")}</h2><button className="icon-button" aria-label={t("Close VM setup")} onClick={close}><X /></button></header>
    <div className="modal-body">
      {showForm && <form id="assistant-setup-form" onSubmit={(event) => { event.preventDefault(); void begin(event.currentTarget); }}>
        {machines.length > 0 && <label className="field"><span className="field-label">{t("Machine")}</span><select className="input" value={choice} onChange={(event) => choose(event.target.value)}>
          {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} · {machine.destination}</option>)}
          <option value={OTHER}>{t("Another computer…")}</option>
        </select></label>}
        {choice === OTHER && <>
          <label className="field"><span className="field-label">{t("SSH alias or user@address")}</span><input name="destination" autoFocus className="input" required autoComplete="off" spellCheck={false} placeholder="ubuntu@203.0.113.10" /></label>
          <label className="field"><span className="field-label">{t("SSH port")}</span><input name="port" className="input" type="number" min="1" max="65535" placeholder={t("From SSH config (default 22)")} /></label>
        </>}
        <label className="field"><span className="field-label">{t("Tailscale machine name")}</span><input name="name" className="input" required autoComplete="off" spellCheck={false} value={name} onChange={(event) => setName(event.target.value)} pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" /></label>
        <label className="field"><span className="field-label">{t("Agent CLI")}</span><select name="agent" className="input" defaultValue="claude"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
        <p className="field-hint">{choice === OTHER ? t("Runs the Assistant install script on a fresh Linux VM over SSH, with this server's SSH config and ssh-agent. Answer its questions in the terminal below.") : t("Runs the Assistant install script on this machine over the SSH that Remote PCs already uses. Answer its questions in the terminal below.")}</p>
      </form>}
      {job?.phase === "unsupported" && <div className="machine-progress" role="status">
        <p>{t("This server cannot run the setup: it has no PTY host. Run this on the VM instead:")}</p>
        <Command command={job.command} />
      </div>}
      {job && job.phase !== "unsupported" && <SetupStatus job={job} />}
      {job?.challenge && <div className="machine-challenge">{job.challenge.kind === "host_key"
        ? <HostKeyQuestion prompt={job.challenge.prompt} host={job.destination} sshOutput={null} />
        : <><pre>{job.challenge.prompt}</pre><SecretForm key={job.challenge.id} pending={pending} onAnswer={(value) => void answer(value)} /></>}</div>}
      {job && job.phase !== "unsupported" && <SetupTerminal key={job.id} shown={job.phase !== "connecting" && job.phase !== "authentication"} running={job.phase === "running"} onJob={setJob} />}
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      {confirmStop ? <>
        <span className="field-hint">{t("Stop the setup? The install on the VM ends where it is.")}</span>
        <button className="btn" disabled={pending} onClick={() => setConfirmStop(false)}>{t("Keep running")}</button>
        <button className="btn btn-danger" disabled={pending} onClick={() => void stopAndClose()}>{t("Stop and close")}</button>
      </> : <>
        {job?.challenge?.kind === "host_key" && <><button className="btn" disabled={pending} onClick={() => void answer("no")}>{t("Reject")}</button><button className="btn btn-primary" disabled={pending} onClick={() => void answer("yes")}>{t("Trust fingerprint")}</button></>}
        {active && !job?.challenge && <button className="btn" onClick={() => setConfirmStop(true)}>{t("Stop setup")}</button>}
        {job?.phase === "done" && job.address && <a className="btn btn-primary" href={job.address} target="_blank" rel="noreferrer">{t("Open")}</a>}
        {!active && !showForm && <button className="btn" onClick={onClose}>{t("Close")}</button>}
        {showForm && <button className="btn btn-primary" form="assistant-setup-form" type="submit" disabled={pending}>{t(pending ? "Starting…" : job ? "Try again" : "Set up")}</button>}
      </>}
    </footer>
  </dialog>;
}

function SetupStatus({ job }: { job: AssistantSetupJob }) {
  const t = useT();
  const step = {
    connecting: t("Connecting with SSH…"),
    authentication: job.challenge?.kind === "host_key" ? t("Verify the server fingerprint") : t("SSH authentication required"),
    running: t("Installing. Answer its questions in the terminal."),
    done: job.address ? t("The Assistant is set up at {address}", { address: job.address }) : t("The install finished."),
    failed: t("The setup failed"),
    stopped: t("The setup was stopped"),
    unsupported: "",
  }[job.phase];
  return <div className="machine-progress" role="status"><strong>{step}</strong>{job.error && <p>{job.error}</p>}</div>;
}

/** The password or passphrase SSH asks for: kept in the input itself, never in React state (src/AGENTS.md). */
function SecretForm({ pending, onAnswer }: { pending: boolean; onAnswer(value: string): void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const allowed = window.isSecureContext;
  return <form onSubmit={(event) => {
    event.preventDefault();
    const value = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    if (value) onAnswer(value);
  }}>
    <label className="field"><span className="field-label">{t("Password or key passphrase")}</span><input ref={input} autoFocus className="input" type="password" autoComplete="off" disabled={!allowed || pending} /></label>
    {!allowed && <p className="field-hint">{t("Open this app over HTTPS or localhost to enter a password.")}</p>}
    <button type="submit" className="btn btn-primary" disabled={!allowed || pending}>{t("Continue")}</button>
  </form>;
}

/**
 * The install's terminal: what the server's PTY prints, replayed whole when the stream (re)opens,
 * and what is typed here sent back in order, one request at a time.
 */
function SetupTerminal({ shown, running, onJob }: { shown: boolean; running: boolean; onJob(job: AssistantSetupJob): void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const { resolvedEntry } = useSettings();

  useEffect(() => {
    const terminal = new Terminal({ scrollback: 0, convertEol: false, cursorBlink: true, fontSize: 13, fontFamily: TERMINAL_FONT_STACK, theme: terminalTheme(resolvedEntry.mode, resolvedEntry.id) });
    const fitter = new FitAddon();
    terminal.loadAddon(fitter);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => { if (isWebLink(uri)) openWebLink(uri); }));
    terminal.open(host.current!);
    fitter.fit();
    term.current = terminal;
    let typed = "";
    let sending = false;
    const send = () => {
      if (sending || !typed) return;
      sending = true;
      const data = typed; typed = "";
      void assistantSetupInput(data).catch(() => {}).finally(() => { sending = false; send(); });
    };
    const input = terminal.onData((data) => { if (runningRef.current) { typed += data; send(); } });
    const resize = terminal.onResize(({ cols, rows }) => { if (runningRef.current) void resizeAssistantSetup(cols, rows).catch(() => {}); });
    const observer = new ResizeObserver(() => fitter.fit());
    observer.observe(host.current!);
    // a (re)opened stream starts with the setup's state, then its whole terminal so far
    let fresh = true;
    const stop = keepEventStream("/api/assistant-setup/stream", {
      opened: () => { fresh = true; }, lost: () => {}, closed: () => {},
      message: (event) => {
        const parsed = JSON.parse(event.data) as AssistantSetupEvent;
        if (fresh) { terminal.reset(); fresh = false; }
        if (parsed.type === "job") onJob(parsed.job); else terminal.write(parsed.data);
      },
    });
    return () => { stop(); observer.disconnect(); input.dispose(); resize.dispose(); terminal.dispose(); term.current = null; };
  }, []);
  useEffect(() => { if (term.current) term.current.options.theme = terminalTheme(resolvedEntry.mode, resolvedEntry.id); }, [resolvedEntry]);
  // the PTY starts at the server's default size: once it runs, it takes this one
  useEffect(() => {
    if (!running || !term.current) return;
    void resizeAssistantSetup(term.current.cols, term.current.rows).catch(() => {});
    term.current.focus();
  }, [running]);
  // mounted from the start, so nothing the stream sends is missed; shown once the install runs
  return <div ref={host} className="assistant-setup-terminal" hidden={!shown} />;
}
