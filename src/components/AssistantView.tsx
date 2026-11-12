import { useCallback, useState } from "react";

import { ASSISTANT_INSTALL_COMMAND, assistantLink, storeAssistantAddress, storedAssistantAddress } from "../lib/assistantMode.ts";
import { useT } from "../lib/i18n.ts";
import { AssistantSetupDialog } from "./AssistantSetupDialog.tsx";
import { Command } from "./PhonePanel.tsx";

import "./AssistantView.css";

/**
 * Assistant mode is only this setup page, opened from the ⋯ menu of an Ovis that is not the VM.
 * The Assistant itself lives in Code mode: its chat is an ordinary pane (the VM's Assistant
 * workspace, tagged on the machine's sidebar row), and beside it Code mode's own agent panel, with
 * the agent sessions it can delegate to (AssistantSessions.tsx).
 */
export function AssistantSetup({ onBack }: { onBack?: () => void }) {
  const t = useT();
  const [address, setAddress] = useState(storedAssistantAddress);
  const [settingUp, setSettingUp] = useState(false);
  const link = assistantLink(address);
  // the address the install printed: kept as one typed in the field is
  const found = useCallback((next: string) => { setAddress(next); storeAssistantAddress(next); }, []);
  return (
    <main className="assistant-setup" data-testid="assistant-setup">
      <div className="assistant-setup-inner">
        <h1 className="assistant-title">{t("Assistant")}</h1>
        <p>{t("The Assistant is a coding agent that runs all day on a cloud VM you own. You message it, it turns what you write into tasks, runs each one on the right PC in your tailnet, and brings back only what needs you. Run this on a fresh Linux VM to set it up:")}</p>
        <Command command={ASSISTANT_INSTALL_COMMAND} />
        <p>{t("Or set it up from here over SSH:")}</p>
        <div><button type="button" className="btn" onClick={() => setSettingUp(true)}>{t("Set up a VM")}</button></div>
        {settingUp && <AssistantSetupDialog onClose={() => setSettingUp(false)} onAddress={found} />}
        <label className="field assistant-address">
          <span className="field-label">{t("Assistant VM address")}</span>
          <input className="input" autoComplete="off" spellCheck={false} placeholder="ovis-assistant.your-tailnet.ts.net" value={address}
            onChange={(event) => { setAddress(event.target.value); storeAssistantAddress(event.target.value); }} />
        </label>
        {link !== null && <a href={link} target="_blank" rel="noreferrer">{link}</a>}
        <p className="assistant-dim">{t("Add the VM in Settings > Remote PCs: its Assistant chat shows in Code mode, with the sessions it can delegate to in the right panel.")}</p>
        {onBack && <div><button type="button" className="btn" onClick={onBack}>{t("Back to Code")}</button></div>}
      </div>
    </main>
  );
}
