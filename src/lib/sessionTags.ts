/**
 * Session tags in the Assistant's composer (docs/plan/20261112-1728-assistant-session-mentions.md):
 * `@[macbook-pro wV:p1 · trina-ax · MCP progress]` in the box, readable text that names its session by
 * machine and pane id and survives a reload as a draft, and on send an exact `@session(...)` for the agent.
 */
import { sshHost, type Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { assistantSessions, type SessionGroup } from "../components/AssistantSessions.tsx";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { isAssistantMachine } from "./assistantMode.ts";

export interface SessionChoice { machine: Machine; pane: HerdrPane }
export interface SessionTag { text: string; start: number; end: number; machine: string; pane: string; label: string }

const TITLE_CHARS = 24;
const TAG = /@\[([^\]\n]+)\]/g;

/** a folder's last part: `/Users/potenlab/repo/trina-ax` is `trina-ax` */
export const sessionFolder = (cwd: string | null | undefined): string => (cwd ?? "").replace(/\/+$/, "").split("/").pop() || "~";
/** a tag's part never holds the characters that end it or split it */
const clean = (text: string): string => text.replace(/[\]\n]/g, " ").replaceAll(" · ", " - ").trim();

/** The picker's data: the Sessions section's list for connected PCs, and the PCs that are not connected. */
export function sessionPicker(machines: readonly Machine[]): { groups: SessionGroup[]; offline: Machine[] } {
  const connected = (machine: Machine): boolean => machine.state === "connected";
  return {
    groups: assistantSessions(machines.filter(connected)),
    offline: machines.filter((machine) => !connected(machine) && !(machine.kind === "ssh" && isAssistantMachine(machine.target?.destination))),
  };
}

export function sessionTag({ machine, pane }: SessionChoice): string {
  const title = clean(displayPaneTitle(pane));
  return `@[${clean(machine.name)} ${pane.pane_id} · ${clean(sessionFolder(pane.cwd))} · ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1).trimEnd()}…` : title}]`;
}

/** Every tag in the text, in order. The machine is what comes before the pane id, so a name may hold spaces. */
export function parseSessionTags(text: string): SessionTag[] {
  return [...text.matchAll(TAG)].flatMap((match) => {
    const [head = "", ...rest] = match[1]!.split(" · ");
    const space = head.lastIndexOf(" ");
    if (space <= 0) return [];
    return [{ text: match[0], start: match.index, end: match.index + match[0].length, machine: head.slice(0, space), pane: head.slice(space + 1), label: [head.slice(0, space), ...rest].join(" · ") }];
  });
}

/** The tag that ends right at the caret, which a Backspace there removes whole. */
export function tagBefore(text: string, caret: number): SessionTag | null {
  return parseSessionTags(text).find((tag) => tag.end === caret) ?? null;
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

/** The session a tag names, while it is listed. */
export function taggedSession(groups: readonly SessionGroup[], tag: Pick<SessionTag, "machine" | "pane">): SessionChoice | null {
  for (const { machine, panes } of groups) {
    if (clean(machine.name) !== tag.machine) continue;
    const pane = panes.find((item) => item.pane_id === tag.pane);
    if (pane) return { machine, pane };
  }
  return null;
}

/** How the Assistant reaches a PC: an SSH PC's host without the tailnet suffix, this Ovis's own its name without `.local`. */
export function machineHost(machine: Machine): string {
  return machine.kind === "ssh" && machine.target?.destination ? sshHost(machine.target.destination) : machine.name.replace(/\.local$/i, "").toLowerCase();
}

const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ")}"`;

/** The text the Assistant receives: each listed tag as an exact `@session(...)`, a gone one as typed with `(closed)`. */
export function expandSessionTags(text: string, groups: readonly SessionGroup[]): string {
  let out = "";
  let from = 0;
  for (const tag of parseSessionTags(text)) {
    const found = taggedSession(groups, tag);
    out += text.slice(from, tag.start) + (found === null ? `${tag.text} (closed)`
      : `@session(machine=${quote(found.machine.name)} host=${quote(machineHost(found.machine))} pane=${quote(found.pane.pane_id)} folder=${quote(found.pane.cwd ?? "")} agent=${quote(found.pane.agent ?? "")} title=${quote(displayPaneTitle(found.pane))})`);
    from = tag.end;
  }
  return out + text.slice(from);
}
