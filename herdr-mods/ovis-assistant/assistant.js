// The ovis-assistant mod's logic without its UI: finding the Assistant on an Ovis's PCs, the panel's
// sections, the composer's session tags and the Voice link. Pure and host-free, so `bun test` runs it;
// the Assistant rules themselves are the web client's own (lib.js, bundled from src/lib).
import { isAssistantPane, assistantSessions, sessionActive, sessionPicker, filterSessions, sessionTag, expandSessionTags, displayPaneTitle, contextLeftPercent } from "./lib.js";

/**
 * The Assistant's pane on the PCs GET /api/machines lists, as the web client tells it (an agent pane in
 * the VM's Assistant folder, lib/assistantMode.ts isAssistantPane): {machine, pane}, or null.
 * `override` (the mod's props) names the machine and pane outright.
 */
export function findAssistant(machines, override = {}) {
  const list = machines ?? [];
  if (override.pane) {
    const machine = list.find((m) => m.id === (override.machine || "local")) ?? null;
    return { machine, pane: machine?.snapshot?.panes?.find((p) => p.pane_id === override.pane) ?? null, machineId: override.machine || "local", paneId: override.pane };
  }
  for (const machine of list) {
    const pane = (machine.snapshot?.panes ?? []).find((p) => p.agent && isAssistantPane(p.foreground_cwd ?? p.cwd));
    if (pane) return { machine, pane, machineId: machine.id, paneId: pane.pane_id };
  }
  return null;
}

/** The PCs the Assistant delegates to: every one but the Assistant VM itself (a remote PC here). */
export function delegateMachines(machines, assistantMachineId) {
  return (machines ?? []).filter((m) => !(m.kind === "ssh" && m.id === assistantMachineId));
}

/** The Sessions section: groups per PC (working and blocked first), only active ones unless `all`, and how many are finished. */
export function sessionsSection(machines, all) {
  const groups = assistantSessions(machines);
  const finished = groups.reduce((sum, g) => sum + g.panes.filter((p) => !sessionActive(p)).length, 0);
  const shown = groups.map((g) => ({ ...g, panes: all ? g.panes : g.panes.filter(sessionActive) })).filter((g) => g.panes.length > 0);
  return { groups, shown, finished };
}

/** A pane's status word and the theme color its dot takes. */
export function statusOf(pane) {
  const s = pane.agent_status;
  return s === "working" ? { word: "Working", color: "working" } : s === "blocked" ? { word: "Needs input", color: "blocked" } : s === "done" ? { word: "Done", color: "done" } : { word: "Idle", color: "idle" };
}

export const paneTitle = (pane) => displayPaneTitle(pane);

/** The `@word` being typed right before the caret: {start, query}, or null when the caret is not in one. */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@/]*)$/.exec(before);
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null;
}

/** The picker's choices for `query`: the connected PCs' sessions as the web composer lists them, at most `max`. */
export function mentionChoices(machines, query, max = 8) {
  const picker = sessionPicker(machines);
  const out = [];
  for (const group of filterSessions(picker.groups, query)) {
    for (const pane of group.panes) {
      if (out.length >= max) return out;
      out.push({ machine: group.machine, pane, tag: sessionTag({ machine: group.machine, pane }, picker.groups) });
    }
  }
  return out;
}

/** The text with `@query` (from `start` to `caret`) taken out, where a chip now stands for it. */
export function dropMention(text, start, caret) {
  const after = text[caret] === " " ? caret + 1 : caret;
  return text.slice(0, start) + text.slice(after);
}

/**
 * What the Assistant receives for the box's text and its chips: each chip's tag first, then the text,
 * every tag expanded to the exact `@session(...)` the web composer sends (lib/sessionTags.ts).
 */
export function outgoingText(value, chips, machines, names) {
  if (chips.length === 0) return value;
  const picker = sessionPicker(machines);
  const picked = new Map(chips.map((c) => [c.tag, { machineId: c.machineId, paneId: c.paneId }]));
  return expandSessionTags(`${chips.map((c) => c.tag).join(" ")} ${value}`, picker.groups, picker.offline, picked, names);
}

/** The context the conversation used, in percent of its window; null when the agent reports none. */
export function contextUsed(metadata) {
  const left = metadata?.context ? contextLeftPercent(metadata.context) : null;
  return left === null ? null : 100 - left;
}

/** What starts the Assistant's fresh conversation in its agent (components/AssistantSessions.tsx useRestartAssistant). */
export function restartCommand(agent) {
  return agent === "claude" ? "/clear" : agent === "codex" ? "/new" : null;
}

/** GET /api/pane/omo-tasks's tasks, running first: the Background tasks section shows only while some run. */
export function backgroundTasks(activity) {
  const tasks = activity?.tasks ?? [];
  const runs = activity?.runs ?? [];
  const live = (status) => status === "running" || status === "pending" || status === "paused";
  return { running: tasks.filter((t) => t.status === "running"), ended: tasks.filter((t) => t.status !== "running"), runs: runs.filter((r) => live(r.status)).length };
}

/** A working tree's change lines, as the Changes section sums them: +added −removed, else the file count. */
export function changeTotals(listing) {
  const files = listing?.files ?? [];
  const added = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  return { files: listing?.total ?? files.length, added, removed };
}

/**
 * The web app's address for the Assistant's pane in Voice: lib/deepLink.ts selects the pane in its
 * chat, and `assistant=voice` (lib/assistantMode.ts linkedAssistantView) opens its voice view.
 * `vm`: the Assistant VM's SSH destination; the OCraft Voice window saves its host as the Assistant
 * address (its storage starts empty, and the web app shows Voice only on the VM it knows).
 */
export function voiceUrl(server, machineId, paneId, vm = "") {
  const host = String(vm ?? "").replace(/^.*@/, "").replace(/:\d+$/, "");
  const query = [machineId && machineId !== "local" ? ["machine", machineId] : null, ["pane", paneId], ["view", "chat"], host ? ["vm", host] : null, ["assistant", "voice"]].filter(Boolean);
  return `${server}/?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** The program that opens Voice in the OCraft Voice window (herdr-mods/voice-window), on a Mac; null elsewhere. */
export function voiceWindowCommand(platform, url) {
  return platform === "macos" ? ["open", ["-a", "OCraft Voice", url]] : null;
}

/** The program that opens a link in the system browser. */
export function openCommand(platform, url) {
  return platform === "macos" ? ["open", [url]] : platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
}
