import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Check, ChevronDown, Folder, FolderOpen, Laptop } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { launchCapabilities, modelSuggestions } from "../lib/agentLaunchMode.ts";
import { MAX_COMPOSER_CHARS } from "../lib/compose.ts";
import { createRequest, firstMessageOutcome, newSessionLaunch, startNewSession } from "../lib/newSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { inFlightGuard } from "../lib/sessionHistory.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { passingFolder, recentDirectories } from "../lib/recent-directories.ts";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

export interface NewSessionDialogProps {
  open: boolean;
  /** opened by Cmd+D: the page takes the right half of the chat area, beside the session it was asked from */
  beside?: boolean;
  machineName?: string;
  /** the PCs a new session can start on (the environment chip); picking one reopens the page on it */
  machines?: readonly { id: string; name: string; local: boolean }[];
  onMachine?: (machineId: string) => void;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /**
   * `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens; `messageWaits`: the
   * bridge queued the first message for the agent's first ready turn, or its text was kept in the chat's
   * message box when it was not queued, so the pane opens in the chat lens, where it shows
   */
  onCreated: (paneId: string, agentStarted: boolean, messageWaits?: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
  /** the PC's open linked worktree checkouts: no project to offer among the recent folders */
  worktrees?: readonly string[];
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;
/** recent folders offered: one row a phone swipes sideways; a wider screen fits what one row holds and lists the rest under "+N" */
const RECENT_FOLDERS_SHOWN = 8;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || value;
}

/** `token` at `at` in `text`, a space on each side where it meets a word; the caret lands after it. */
export function insertToken(text: string, at: number, token: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after === "" || !/^\s/.test(after) ? " " : "";
  const head = `${before}${lead}${token}${trail}`;
  return { text: `${head}${after}`.slice(0, MAX_COMPOSER_CHARS), caret: Math.min(head.length, MAX_COMPOSER_CHARS) };
}

const NEW_SESSION_AGENTS = ["claude", "codex"];

export function NewSessionDialog({ open, beside = false, machines = [], onMachine, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft, worktrees = [] }: NewSessionDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const machineId = useMachineId();
  const { createTab, createWorkspace, fetchAgentKinds } = useMachineApi();
  const machineSessions = useMachineSessions();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  /** the made pane runs the agent asked for: Open shows it in the agent's lens */
  const [createdStarted, setCreatedStarted] = useState(false);
  /** the first message was not queued and waits in the made pane's chat box: Open shows the chat */
  const [createdKept, setCreatedKept] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  /** the folder chip panel: the path field, Browse and the recent folders */
  const [folderOpen, setFolderOpen] = useState(false);
  /** the chip menu that is open under the box: the environment (PC) or the folder */
  const [menu, setMenu] = useState<"env" | "folder" | null>(null);
  // the page is the chat area itself: going to a session in the sidebar leaves it
  useEffect(() => {
    if (!open) return;
    const leave = (event: PointerEvent): void => { if ((event.target as Element | null)?.closest?.(".sidebar")) onClose(); };
    window.addEventListener("pointerdown", leave, true);
    return () => window.removeEventListener("pointerdown", leave, true);
  }, [open, onClose]);
  useEffect(() => { if (!open) setMenu(null); }, [open]);
  // beside (Cmd+D): the chat it was asked from narrows to the left half (styles.css, body.is-new-beside)
  // and the page takes the right one, measured once the chat has narrowed
  const [besideFrame, setBesideFrame] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !beside) { setBesideFrame(null); return; }
    document.body.classList.add("is-new-beside");
    const place = (): void => {
      const area = document.querySelector(".pane-split")?.getBoundingClientRect();
      if (!area) return;
      setBesideFrame({ left: area.right, top: area.top, right: Math.max(0, window.innerWidth - area.right - area.width), bottom: window.innerHeight - area.bottom });
    };
    place();
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("resize", place); document.body.classList.remove("is-new-beside"); };
  }, [open, beside]);
  const [recentFolders, setRecentFolders] = useState(() => recentDirectories.read(machineId));
  // folders kept before worktrees and temporary folders were left out are left out here too
  const shownFolders = recentFolders.filter((path) => !passingFolder(path, worktrees)).slice(0, RECENT_FOLDERS_SHOWN);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  // one Start at a time, whatever the fields' disabled state has rendered yet: a double tap sends one create
  const guard = useRef(inFlightGuard());
  // a path longer than its field is shown from its end, where the folder's name is, whenever it is
  // set for the user (the last folder, a pick from Browse or a recent chip) and when the field is
  // left; typing keeps the caret in view by itself
  const cwdField = useRef<HTMLInputElement>(null);
  const showPathEnd = (): void => {
    const field = cwdField.current;
    if (field !== null) field.scrollLeft = field.scrollWidth;
  };
  useLayoutEffect(() => {
    if (open && document.activeElement !== cwdField.current) showPathEnd();
  }, [open, cwd]);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef });
  useSheetSwipe(surface, pending ? null : onClose);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  // The previous launch may have left disabled fields: reset them before the opening paint.
  useLayoutEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    setCwd(filled?.cwd ?? defaultCwdRef.current ?? "");
    setName(filled?.name ?? "");
    setModel("");
    setEffort("");
    setPrompt("");
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setCreatedStarted(false);
    setCreatedKept(false);
    setBrowsing(false);
    setRecentFolders(recentDirectories.read(machineId));
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((offered) => {
        if (cancelled) return;
        // ponytail: a new session is a chat with Claude or Codex alone; terminals still open from the title menu
        const next = offered.filter((agent) => NEW_SESSION_AGENTS.includes(agent.kind));
        setAgents(next);
        // an agent not offered here gives way to the last one picked, else to the first offered
        if (!next.some((agent) => agent.kind === stored)) setAgentKind(next.some((agent) => agent.kind === remembered) ? remembered : next[0]?.kind ?? "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(userErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const agentLabel = selectedAgent?.label ?? agentKind;
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || createdPaneId !== null;
  const can = launchCapabilities(agentKind);
  const launched = newSessionLaunch({ agent: agentKind, model, effort, prompt }, settings);
  const fault = "fault" in launched ? launched.fault : null;
  const launch = "fault" in launched ? null : launched;
  const suggestions = modelSuggestions(agentKind);
  // what the picker's rows say each launch takes: only the agents whose command line takes a model and a level
  const pickerHints = Object.fromEntries(agents.flatMap((agent) => {
    const takes = launchCapabilities(agent.kind);
    return takes.model && takes.efforts.length > 0 ? [[agent.kind, t("model, effort")]] : [];
  }));

  const pickAgent = (kind: string): void => {
    setAgentKind(kind);
    // a choice the next agent's launch does not take goes back to the agent's own; a model names one agent's models
    const next = launchCapabilities(kind);
    if (!next.model || kind !== agentKind) setModel("");
    if (!next.efforts.includes(effort)) setEffort("");
  };

  const startWorkspace = async (directory: string): Promise<void> => {
    if (pending || guard.current.busy()) return;
    if (createdPaneId !== null) { onCreated(createdPaneId, createdStarted, createdKept); return; }
    // a combination the launch does not take: Start is disabled for it, and an Enter in a field sends nothing
    if (launch === null) return;
    setPending(true);
    setError(null);
    // a tab keeps the workspace's folder, which the dialog shows and does not ask for. The first message of an
    // agent whose command line does not take it rides on this request: the bridge queues it for the agent's first
    // ready turn and types it through this page's connection, so this page never types it itself
    const request = createRequest({ tab, directory, name }, launch, machineSessions?.peek(machineId)?.connection ?? null);
    const started = startNewSession(guard.current, request, async (body) => {
      rememberAgent(agentKind);
      return tab ? await createTab({ ...body, workspace_id: tab.workspaceId }) : await createWorkspace(body);
    });
    if (started === null) { setPending(false); return; }
    try {
      const result = await started;
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        // the workspace exists: say so plainly, keep the PC's own words beneath, and Open it rather than make another
        setError({ message: t("The workspace opened, but {agent} did not start. Check that it is installed on the PC, then open it again.", { agent: agentLabel }), detail: result.error.message });
        setCreatedPaneId(result.pane_id);
        return;
      }
      if (!tab && (!agentKind || result.agent_started)) {
        setRecentFolders(recentDirectories.remember(machineId, [directory.trim()], true));
      }
      const outcome = firstMessageOutcome(request, result);
      if (outcome.kind === "not_queued") {
        // the agent runs without its first message: the text waits in the new tab's message box, and the dialog says so
        composerDrafts.set(`ovis:composer-draft:${paneStorageId(machineId, result.pane_id)}`, request.first_message!);
        setPending(false);
        setError({
          message: outcome.error
            ? t("{agent} started, but its first message was not queued. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel })
            : t("{agent} started, but this PC's bridge does not take a first message yet. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel }),
          detail: outcome.error?.message ?? null,
        });
        setCreatedPaneId(result.pane_id);
        setCreatedStarted(true);
        setCreatedKept(true);
        return;
      }
      const messageWaits = outcome.kind === "queued";
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      setPending(false);
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false, messageWaits);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError({ message: t("Directory not found"), detail: null });
      else setError(userErrorMessage(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };


  // a page like Claude Code's New session: one message box, the folder under it on the left and the
  // agent, model and effort on the right; Enter starts it (Shift+Enter is a new line)
  const folderName = tab ? (tab.cwd ? directoryBasename(tab.cwd) : tab.workspaceLabel) : cwd.trim() ? directoryBasename(cwd) : t("Choose folder");
  const submit = (): void => { if (!pending && fault === null) void startWorkspace(cwd); };
  const startWord = t(pending ? "Starting…" : createdPaneId !== null ? "Open" : "Start");
  const besideStyle = besideFrame ?? undefined;
  return (
    <div className={`new-session-page-scrim${besideStyle ? " is-beside" : ""}`} style={besideStyle} onMouseDown={closeFromScrim}>
      <form ref={surface} className="new-session-page" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="new-session-page-main">
          <h2 className="new-session-page-heading" id="new-session-title">{t(tab ? "New tab" : "New workspace")}</h2>
          <div className="new-session-page-bar">
            <div className="new-session-page-left">
              {/* the environment: which PC the session starts on */}
              <span className="new-session-page-pop">
                <button type="button" className="new-session-page-chip" aria-haspopup="menu" aria-expanded={menu === "env"} disabled={fieldsDisabled || tab !== null || machines.length < 2} onClick={() => setMenu((value) => value === "env" ? null : "env")}>
                  <Laptop aria-hidden="true" />{machineId === "local" ? t("This computer") : machineName ?? machineId}{!tab && machines.length > 1 && <ChevronDown aria-hidden="true" />}
                </button>
                {menu === "env" && <div className="new-session-page-menu" role="menu">
                  {[[t("Local"), machines.filter((machine) => machine.local)], [t("Remote"), machines.filter((machine) => !machine.local)]].map(([label, list]) => (list as typeof machines).length > 0 && <div key={label as string} role="group" aria-label={label as string}>
                    <p className="new-session-page-menu-label">{label as string}</p>
                    {(list as typeof machines).map((machine) => <button type="button" role="menuitemradio" aria-checked={machine.id === machineId} key={machine.id} className="new-session-page-menu-item" onClick={() => { setMenu(null); if (machine.id !== machineId) onMachine?.(machine.id); }}>
                      <span>{machine.local ? t("This computer") : machine.name}</span>{machine.id === machineId && <Check aria-hidden="true" />}
                    </button>)}
                  </div>)}
                </div>}
              </span>
              {/* the folder: a recent one, or another opened with Browse */}
              <span className="new-session-page-pop">
                {tab ? <span className="new-session-page-chip" title={tab.cwd ?? tab.workspaceLabel}><Folder aria-hidden="true" />{folderName}</span>
                  : <button type="button" className="new-session-page-chip" aria-haspopup="menu" aria-expanded={menu === "folder"} title={cwd || undefined} disabled={fieldsDisabled} onClick={() => setMenu((value) => value === "folder" ? null : "folder")}>
                    <Folder aria-hidden="true" />{folderName}<ChevronDown aria-hidden="true" />
                  </button>}
                {menu === "folder" && <div className="new-session-page-menu" role="menu">
                  {shownFolders.length > 0 && <p className="new-session-page-menu-label">{t("Recent")}</p>}
                  {shownFolders.map((path) => {
                    const name = directoryBasename(path);
                    // two recent folders with one name say where each is
                    const twin = shownFolders.some((other) => other !== path && directoryBasename(other) === name);
                    const chosen = path === cwd.trim();
                    return <button type="button" role="menuitemradio" aria-checked={chosen} key={path} className="new-session-page-menu-item" title={path} onClick={() => { setCwd(path); setMenu(null); setFolderOpen(false); }}>
                      <span><span>{name}</span>{twin && <small>{path.replace(/\/[^/]+\/?$/, "")}</small>}</span>{chosen && <Check aria-hidden="true" />}
                    </button>;
                  })}
                  {shownFolders.length > 0 && <hr className="new-session-page-menu-rule" />}
                  <button type="button" role="menuitem" className="new-session-page-menu-item" onClick={() => { setMenu(null); setFolderOpen(true); setBrowsing(true); }}><span>{t("Open folder…")}</span></button>
                </div>}
              </span>
            </div>
            <div className="new-session-page-right">
              <AgentPicker ref={firstFieldRef} agents={agents} shell={agents.length === 0} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-title" hints={pickerHints} onChange={pickAgent} />
              {can.model && <>
                <input
                  id="new-session-model"
                  className="new-session-page-model"
                  value={model}
                  list={suggestions.length > 0 ? "new-session-models" : undefined}
                  disabled={fieldsDisabled}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={t("Default model")}
                  aria-label={t("Model")}
                  aria-invalid={fault === "model" || undefined}
                  onChange={(event) => setModel(event.target.value)}
                />
                {suggestions.length > 0 && <datalist id="new-session-models">{suggestions.map((alias) => <option key={alias} value={alias} />)}</datalist>}
              </>}
              {can.efforts.length > 0 && <select id="new-session-effort" className="new-session-page-effort" value={effort} disabled={fieldsDisabled} aria-label={t("Effort")} onChange={(event) => setEffort(event.target.value)}>
                <option value="">{t("Default effort")}</option>
                {can.efforts.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>}
            </div>
          </div>
          <button type="submit" className="btn btn-primary new-session-page-start" disabled={pending || fault !== null}>{startWord}</button>
          {!tab && folderOpen && <div className="new-session-page-folder">
            <div className="new-session-cwd">
              <input ref={cwdField} id="new-session-cwd" className="input" value={cwd} placeholder="~/projects/app" aria-label={t("Directory")} disabled={fieldsDisabled} autoComplete="off" onChange={(event) => setCwd(event.target.value)} onBlur={showPathEnd} />
              <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((value) => !value)}>
                <FolderOpen aria-hidden="true" />
                {t("Browse")}
              </button>
            </div>
            {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setBrowsing(false); setFolderOpen(false); }} onFolder={(path, home) => setCwd(homeRelative(path, home))} />}
            {shownFolders.length > 0 && <RecentFolderChips folders={shownFolders} disabled={fieldsDisabled} labelledBy="new-session-title" basename={directoryBasename}
              onPick={(path) => { setCwd(path); setBrowsing(false); setFolderOpen(false); }} />}
          </div>}
          <p id="new-session-prompt-hint" className={`new-session-page-note${error || fault === "model" ? " new-session-error" : ""}`} role={error ? "alert" : "status"}>
            {error ? <>{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</> : fault === "model" ? t("One model name, without spaces.") : pending ? pendingLabel : null}
          </p>
        </div>
      </form>
    </div>
  );
}
