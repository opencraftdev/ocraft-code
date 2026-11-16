import type { IBuffer, ILink, ILinkProvider } from "@xterm/xterm";
import { logicalLine } from "./terminalFileLinks.ts";

/**
 * A pane's address in terminal text, as herdr names panes (`w1:p3`), with the PC in front when
 * it is another one's (`vps/w1:p3`). A bare address means a pane on the PC of the terminal that
 * shows it, never one of the same name elsewhere (herdr-app's terminal addresses, src/links.rs).
 */
const ADDRESS = /(?<![\p{L}\p{N}_./:-])(?:([A-Za-z0-9][A-Za-z0-9._-]*)\/)?(w\d+:p\d+)(?![\p{L}\p{N}_/:-])/gu;

export interface PaneAddress {
  /** where it starts in the text */
  index: number;
  text: string;
  /** the PC named in front of it, as written; null for a bare address */
  machine: string | null;
  paneId: string;
}

export function paneAddresses(text: string): PaneAddress[] {
  return [...text.matchAll(ADDRESS)].map((match) => ({ index: match.index, text: match[0], machine: match[1] ?? null, paneId: match[2]! }));
}

/** A PC as the links read it: its id and name, and its roster's live panes (shared/machines.ts' Machine fits). */
export interface LinkMachine { id: string; name: string; snapshot: { panes: readonly { pane_id: string }[] } | null }

/**
 * The PC and pane an address opens, or null when no such pane is live: a bare address on
 * `source`, a named one on the PC whose name or id it gives (letter case aside).
 */
export function resolvePaneAddress(address: Pick<PaneAddress, "machine" | "paneId">, source: string, machines: readonly LinkMachine[]): { machineId: string; paneId: string } | null {
  const name = address.machine?.toLowerCase();
  const machine = name === undefined
    ? machines.find((candidate) => candidate.id === source)
    : machines.find((candidate) => candidate.id.toLowerCase() === name) ?? machines.find((candidate) => candidate.name.toLowerCase() === name);
  return machine?.snapshot?.panes.some((pane) => pane.pane_id === address.paneId) ? { machineId: machine.id, paneId: address.paneId } : null;
}

/**
 * What the links ask of the app: the PCs it knows and how to show a pane. One app per page sets
 * it (App.tsx); a terminal reads it when a row is hovered, so it is never stale.
 * ponytail: a module value, not a context, so the terminal mount takes no new dependency.
 */
let target: { machines: readonly LinkMachine[]; open: (machineId: string, paneId: string) => void } = { machines: [], open: () => {} };

/** Called on every App render (a plain call: App keeps its hook count down), so it holds the latest roster. */
export function setPaneLinkTarget(machines: readonly LinkMachine[], open: (machineId: string, paneId: string) => void): void { target = { machines, open }; }

/** Ctrl-click opens it, Cmd-click on a Mac: a plain click in a terminal is the program's. */
export const paneLinkPressed = (event: MouseEvent): boolean => event.button === 0 && (event.ctrlKey || event.metaKey);

export function terminalPaneLinks(buffer: IBuffer, lineNumber: number, source: string, machines: readonly LinkMachine[], open: (machineId: string, paneId: string, event: MouseEvent) => void): ILink[] {
  const line = logicalLine(buffer, lineNumber);
  if (line === null) return [];
  const links: ILink[] = [];
  for (const address of paneAddresses(line.text)) {
    const resolved = resolvePaneAddress(address, source, machines);
    const start = line.positions[address.index];
    const last = line.positions[address.index + address.text.length - 1];
    if (!resolved || !start || !last || lineNumber < start.y || lineNumber > last.y) continue;
    links.push({
      range: { start: { x: start.x, y: start.y }, end: { x: last.x + last.width - 1, y: last.y } },
      text: address.text,
      activate: (event) => open(resolved.machineId, resolved.paneId, event),
    });
  }
  return links;
}

/** The provider a terminal on PC `source` registers. */
export function terminalPaneLinkProvider(buffer: () => IBuffer, source: string): ILinkProvider {
  return {
    provideLinks: (line, callback) => callback(terminalPaneLinks(buffer(), line, source, target.machines, (machineId, paneId, event) => {
      if (paneLinkPressed(event)) target.open(machineId, paneId);
    })),
  };
}
