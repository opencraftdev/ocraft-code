import { useState } from "react";

import { ASSISTANT_INSTALL_COMMAND, assistantLink, storeAssistantAddress, storedAssistantAddress } from "../lib/assistantMode.ts";
import { useT } from "../lib/i18n.ts";
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
  return (
    <div className="assistant-layout" data-testid="assistant-layout">
      <nav className="assistant-sidebar" aria-label={t("Assistant")}>
        <Section title={t("Machines")} />
        <Section title={t("Projects")} />
        <Section title={t("Sessions")} />
      </nav>
      <main className="assistant-chat" aria-label={t("Chat")} />
      <aside className="assistant-board" aria-label={t("Tasks")}>
        <Section title={t("Tasks")} />
      </aside>
    </div>
  );
}

function Section({ title }: { title: string }) {
  const t = useT();
  return (
    <section className="assistant-section">
      <h2 className="sidebar-section-label">{title}</h2>
      <p className="assistant-empty">{t("None yet")}</p>
    </section>
  );
}
