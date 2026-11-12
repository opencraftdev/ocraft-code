/**
 * Session tags in the Assistant's composer (docs/plan/20261112-1728-assistant-session-mentions.md):
 * `@macbook-pro/trina-ax` in the box (docs/plan/20261112-1900-assistant-graph-and-profile.md), short text that
 * survives a reload as a draft, and on send an exact `@session(...)` for the agent.
 */
import { sshHost, type Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { assistantSessions, type SessionGroup } from "../components/AssistantSessions.tsx";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { isAssistantMachine } from "./assistantMode.ts";

export interface SessionChoice { machine: Machine; pane: HerdrPane }
export interface SessionTag { text: string; start: number; end: number; machine: string; folder: string; pane: string | null }
/** what the composer remembers of a tag it put in the box, by the tag's text: the session it was picked from */
export type PickedTags = ReadonlyMap<string, { machineId: string; paneId: string }>;
/** the VM's names for PCs, by host (its graph.json `machines`): another Ovis names this PC its own way */
export type MachineNames = ReadonlyMap<string, string>;

/** `@muhammad-macbook/ovis`, or `@muhammad-macbook/ovis:wN:p2` when the pane is written out */
const TAG = /(?<![\w@/])@([A-Za-z0-9][\w.-]*)\/([^\s/:@]*[^\s/:@.,;!?)\]'"])(?::(w[\w]*:p[\w]+))?/g;

/** a folder's last part: `/Users/potenlab/repo/trina-ax` is `trina-ax` */
export const sessionFolder = (cwd: string | null | undefined): string => (cwd ?? "").replace(/\/+$/, "").split("/").pop() || "~";
/** a part of a tag holds no space, slash, colon or @: they end it */
const slug = (text: string): string => text.trim().replace(/[\s/:@]+/g, "-") || "~";

/** The picker's data: the Sessions section's list for connected PCs, and the PCs that are not connected. */
export function sessionPicker(machines: readonly Machine[]): { groups: SessionGroup[]; offline: Machine[] } {
  const connected = (machine: Machine): boolean => machine.state === "connected";
  return {
    groups: assistantSessions(machines.filter(connected)),
    offline: machines.filter((machine) => !connected(machine) && !(machine.kind === "ssh" && isAssistantMachine(machine.target?.destination))),
  };
}

/** How the Assistant reaches a PC: an SSH PC's host without the tailnet suffix, this Ovis's own its name without `.local`. */
export function machineHost(machine: Machine): string {
  return machine.kind === "ssh" && machine.target?.destination ? sshHost(machine.target.destination) : machine.name.replace(/\.local$/i, "").toLowerCase();
}

/** The PC's name as the VM's `ovis-task` has it, else this Ovis's name for it (this PC's own row: its host, not `X.local`). */
export const machineLabel = (machine: Machine, names: MachineNames = new Map()): string =>
  slug(names.get(machineHost(machine)) ?? (machine.kind === "local" ? machineHost(machine) : machine.name));
/** every name a tag may give the PC: a draft written before the VM's names were read still finds it */
const aliases = (machine: Machine, names?: MachineNames): string[] => [machineLabel(machine, names), slug(machine.name), machineHost(machine)].map((name) => name.toLowerCase());

/** The tag for a session: machine and folder, and the pane too when another listed session shares that folder. */
export function sessionTag({ machine, pane }: SessionChoice, groups: readonly SessionGroup[] = [], names?: MachineNames): string {
  const folder = slug(sessionFolder(pane.cwd));
  const shared = groups.find((group) => group.machine.id === machine.id)?.panes
    .some((other) => other.pane_id !== pane.pane_id && slug(sessionFolder(other.cwd)) === folder) ?? false;
  return `@${machineLabel(machine, names)}/${folder}${shared ? `:${pane.pane_id}` : ""}`;
}

/** Every tag-shaped `@machine/folder` in the text, in order (which name a session is for resolveTag to say). */
export function parseSessionTags(text: string): SessionTag[] {
  return [...text.matchAll(TAG)].map((match) => ({
    text: match[0], start: match.index, end: match.index + match[0].length, machine: match[1]!, folder: match[2]!, pane: match[3] ?? null,
  }));
}

/** The tags whose machine is a listed PC: the ones drawn as tags and expanded on send. */
export function knownTags(text: string, groups: readonly SessionGroup[], offline: readonly Machine[] = [], names?: MachineNames): SessionTag[] {
  const known = new Set([...groups.map((group) => group.machine), ...offline].flatMap((machine) => aliases(machine, names)));
  return parseSessionTags(text).filter((tag) => known.has(tag.machine.toLowerCase()));
}

/** The tag that ends right at the caret, which a Backspace there removes whole. */
export function tagBefore(text: string, caret: number, groups: readonly SessionGroup[], offline: readonly Machine[] = [], names?: MachineNames): SessionTag | null {
  return knownTags(text, groups, offline, names).find((tag) => tag.end === caret) ?? null;
}

/** The text without that tag, and one space it leaves doubled; the caret where it was. */
export function removeTag(text: string, tag: Pick<SessionTag, "start" | "end">): { text: string; caret: number } {
  const after = text[tag.end] === " " && (tag.start === 0 || text[tag.start - 1] === " ") ? tag.end + 1 : tag.end;
  return { text: text.slice(0, tag.start) + text.slice(after), caret: tag.start };
}

/** Sessions whose title, folder, workspace label or PC name hold every typed word, in any order, any case. */
export function filterSessions(groups: readonly SessionGroup[], query: string): SessionGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return groups.map(({ machine, panes }) => ({
    machine,
    panes: panes.filter((pane) => {
      const workspace = machine.snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id)?.label ?? "";
      const haystack = [displayPaneTitle(pane), pane.cwd ?? "", workspace, machine.name].join(" ").toLowerCase();
      return words.every((word) => haystack.includes(word));
    }),
  })).filter((group) => group.panes.length > 0);
}

/**
 * The sessions a tag names, while listed: the one it was picked from (remembered by the composer), else
 * its pane when written, else every session of that PC in that folder (more than one is ambiguous).
 */
export function resolveTag(tag: SessionTag, groups: readonly SessionGroup[], picked: PickedTags = new Map(), names?: MachineNames): SessionChoice[] {
  const remembered = picked.get(tag.text);
  if (remembered) {
    const group = groups.find((item) => item.machine.id === remembered.machineId);
    const pane = group?.panes.find((item) => item.pane_id === remembered.paneId);
    return group && pane ? [{ machine: group.machine, pane }] : [];
  }
  const group = groups.find((item) => aliases(item.machine, names).includes(tag.machine.toLowerCase()));
  if (!group) return [];
  const panes = group.panes.filter((pane) => tag.pane !== null ? pane.pane_id === tag.pane : slug(sessionFolder(pane.cwd)).toLowerCase() === tag.folder.toLowerCase());
  return panes.map((pane) => ({ machine: group.machine, pane }));
}

const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ")}"`;

/**
 * The text the Assistant receives: each tag of a listed PC as an exact `@session(...)`; one whose session
 * is gone as typed with `(closed)`; one naming several sessions as the first, with the others' panes.
 */
export function expandSessionTags(text: string, groups: readonly SessionGroup[], offline: readonly Machine[] = [], picked?: PickedTags, names?: MachineNames): string {
  let out = "";
  let from = 0;
  for (const tag of knownTags(text, groups, offline, names)) {
    const [found, ...others] = resolveTag(tag, groups, picked, names);
    out += text.slice(from, tag.start) + (found === undefined ? `${tag.text} (closed)`
      : `@session(machine=${quote(machineLabel(found.machine, names))} host=${quote(machineHost(found.machine))} pane=${quote(found.pane.pane_id)} folder=${quote(found.pane.cwd ?? "")} agent=${quote(found.pane.agent ?? "")} title=${quote(displayPaneTitle(found.pane))})`
        + (others.length > 0 ? ` (ambiguous, also: ${others.map((other) => other.pane.pane_id).join(", ")})` : ""));
    from = tag.end;
  }
  return out + text.slice(from);
}

/** The VM's names for PCs from its graph.json: `machines: [{ name, host }]`; anything else is no names. */
export function machineNamesOf(graph: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const machines = typeof graph === "object" && graph !== null ? (graph as { machines?: unknown }).machines : undefined;
  if (!Array.isArray(machines)) return names;
  for (const item of machines) {
    if (typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string" && typeof (item as { host?: unknown }).host === "string") {
      names.set((item as { host: string }).host.toLowerCase(), (item as { name: string }).name);
    }
  }
  return names;
}
