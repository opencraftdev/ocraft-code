/**
 * The agent sessions the Assistant can delegate to, without React: the Assistant pane's Sessions
 * section (components/AssistantSessions.tsx), its composer's session tags (sessionTags.ts) and the
 * ovis-assistant herdr-app mod all list them alike.
 */
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { isAssistantMachine, isAssistantPane } from "./assistantMode.ts";

/** One PC's agent panes the Assistant can delegate to, in the Sessions section's order. */
export interface SessionGroup { machine: Machine; panes: HerdrPane[] }

/** working, then blocked (needs input), then the rest */
const rank = (pane: HerdrPane): number => pane.agent_status === "working" ? 0 : pane.agent_status === "blocked" ? 1 : 2;
export const sessionActive = (pane: HerdrPane): boolean => rank(pane) < 2;

/**
 * Every agent pane on the PCs this Ovis has, the Assistant VM and the Assistant's own pane excepted,
 * grouped by PC in the roster's order, each PC's panes ordered working, blocked, then the rest.
 */
export function assistantSessions(machines: readonly Machine[]): SessionGroup[] {
  return machines
    .filter((machine) => !(machine.kind === "ssh" && isAssistantMachine(machine.target?.destination)))
    .map((machine) => ({ machine, panes: (machine.snapshot?.panes ?? []).filter((pane) => pane.agent && !isAssistantPane(pane.cwd)).sort((a, b) => rank(a) - rank(b)) }))
    .filter((group) => group.panes.length > 0);
}

