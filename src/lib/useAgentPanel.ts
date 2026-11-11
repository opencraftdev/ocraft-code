import { useCallback, useRef, useState } from "react";

export type AgentPanelView = "agents" | "tasks" | "details" | "graph";
/** View state stays in this window. Agent/session data belongs to the keyed panel. */
export function useAgentPanel(owner: string | null) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(() => window.matchMedia("(min-width: 1200px)").matches);
  const [agentPanelTab, setAgentPanelTab] = useState<AgentPanelView>("agents");
  const [drawer, setDrawer] = useState({ owner, open: false });
  const agentDrawerOpen = drawer.owner === owner && drawer.open;
  const setAgentDrawerOpen = useCallback((open: boolean) => setDrawer({ owner, open }), [owner]);
  const agentPanelToggle = useRef<HTMLButtonElement>(null);
  const closeAgentPanel = useCallback(() => { setAgentPanelOpen(false); setDrawer(before => ({ ...before, open: false })); agentPanelToggle.current?.focus({ preventScroll: true }); }, []);
  // an agent the composer's strip asked the panel to open (`task:<id>`), until the panel takes it
  const [focusAgent, setFocusAgent] = useState<string | null>(null);
  const clearFocusAgent = useCallback(() => setFocusAgent(null), []);
  return { focusAgent, setFocusAgent, clearFocusAgent, agentPanelOpen, setAgentPanelOpen, agentPanelTab, setAgentPanelTab, agentDrawerOpen, setAgentDrawerOpen, agentPanelToggle, closeAgentPanel };
}
