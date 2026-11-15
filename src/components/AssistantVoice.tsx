import { useEffect, useRef } from "react";
import { AudioLines, Check, MessageSquare, Mic, MicOff, Pause, PhoneOff, X } from "lucide-react";

import type { AssistantView } from "../lib/assistantMode.ts";
import { assistantVoice, minutesLeft, useAssistantVoice, type CallPhase, type VoiceTrouble } from "../lib/assistantVoice.ts";
import { unlockAlertSound } from "../lib/alertSound.ts";
import { useT, type Translate } from "../lib/i18n.ts";

import "./AssistantVoice.css";

const GUIDE = "https://github.com/opencraftdev/ocraft-code/blob/main/docs/guide.md#assistant";

/**
 * Chat | Voice in the header, for the Assistant's own pane only (App decides; `shown` false draws
 * nothing). Chat is the default and today's chat unchanged; Voice is the call screen below.
 */
export function AssistantViewSwitch({ shown, view, onChange }: { shown: boolean; view: AssistantView; onChange: (view: AssistantView) => void }) {
  const t = useT();
  if (!shown) return null;
  return (
    <div className="segmented assistant-view-switch" role="group" aria-label={t("Assistant view")}>
      <button type="button" aria-pressed={view === "chat"} aria-label={t("Assistant chat")} onClick={() => onChange("chat")}>
        <MessageSquare aria-hidden="true" /><span className="assistant-view-word">{t("Chat")}</span>
      </button>
      <button type="button" aria-pressed={view === "voice"} aria-label={t("Assistant voice")} onClick={() => onChange("voice")}>
        <AudioLines aria-hidden="true" /><span className="assistant-view-word">{t("Voice")}</span>
      </button>
    </div>
  );
}

function phaseWord(t: Translate, phase: CallPhase): string {
  switch (phase) {
    case "idle": return t("Tap to talk");
    case "connecting": return t("Connecting…");
    case "listening": return t("Listening");
    case "thinking": return t("Thinking…");
    case "speaking": return t("Speaking");
  }
}

function troubleLine(t: Translate, trouble: VoiceTrouble): string {
  switch (trouble) {
    case "no_key": return t("Voice needs an ElevenLabs key");
    case "mic": return t("The microphone was refused. Allow it in the browser's site settings.");
    case "offline": return t("The Assistant VM is offline.");
    case "provider_auth": return t("ElevenLabs refused the key on the VM.");
    case "provider": return t("ElevenLabs did not answer.");
    case "minutes": return t("This month's voice minutes are used up.");
    case "failed": return t("The call could not start.");
  }
}

/** "Assistant working… N tasks", while a sent task works and no call is open */
function WorkingLine({ count }: { count: number }) {
  const t = useT();
  return <><span className="assistant-voice-dot" aria-hidden="true" />{count === 1 ? t("Assistant working… 1 task") : t("Assistant working… {n} tasks", { n: count })}</>;
}

/** Nara's call screen, over the Assistant's chat in its pane. Switching here never starts a call: the orb does. */
export function AssistantVoiceScreen() {
  const t = useT();
  const voice = useAssistantVoice();
  const orb = useRef<HTMLButtonElement>(null);
  const { phase, trouble } = voice;
  const live = phase !== "idle";

  useEffect(() => {
    assistantVoice.setVoiceShown(true);
    void assistantVoice.refresh();
    return () => assistantVoice.setVoiceShown(false);
  }, [voice.machineId]);

  // the orb follows the voice heard: one frame loop writing a custom property, no React render per frame
  useEffect(() => {
    if (phase === "idle" || phase === "connecting") return;
    let frame = 0;
    const paint = () => {
      const { input, output } = assistantVoice.levels();
      orb.current?.style.setProperty("--level", Math.min(1, phase === "speaking" ? output : input).toFixed(3));
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => { cancelAnimationFrame(frame); orb.current?.style.removeProperty("--level"); };
  }, [phase]);

  const left = minutesLeft(voice.status);
  const working = voice.tasks.filter((task) => task.state === "working" && !task.waiting).length;
  return (
    <section className="assistant-voice" data-phase={phase} aria-label={t("Assistant voice")}>
      <div className="assistant-voice-stage">
        <button ref={orb} type="button" className="assistant-voice-orb" disabled={live || trouble === "no_key"}
          aria-label={live ? phaseWord(t, phase) : t("Start a call")}
          onClick={() => { void unlockAlertSound(); void assistantVoice.start(); }}>
          <span className="assistant-voice-orb-core" aria-hidden="true" />
        </button>
        <p className="assistant-voice-name">{voice.persona}</p>
        <p className="assistant-voice-phase" role="status">{phaseWord(t, phase)}</p>
      </div>
      {trouble !== null && (
        <p className="assistant-voice-trouble" role="alert">
          <span>{troubleLine(t, trouble)}</span>
          {trouble === "no_key" && <a href={GUIDE} target="_blank" rel="noreferrer">{t("Open the guide")}</a>}
          <button type="button" className="btn" onClick={() => void assistantVoice.refresh()}>{t("Try again")}</button>
        </p>
      )}
      {voice.captions.length > 0 && (
        <ol className="assistant-voice-captions" aria-live="polite">
          {voice.captions.map((line) => <li key={line.id} className={`is-${line.who}`}><span className="assistant-voice-who">{line.who === "user" ? t("You") : voice.persona}</span> {line.text}</li>)}
        </ol>
      )}
      {voice.tasks.length > 0 && (
        <ul className="assistant-voice-tasks" aria-label={t("Tasks")}>
          {voice.tasks.map((task) => (
            <li key={task.id} className={`assistant-voice-task is-${task.waiting ? "waiting" : task.state}`}>
              <span className="assistant-voice-task-text">{task.text}</span>
              <span className="assistant-voice-task-state">
                {task.waiting ? <><Pause aria-hidden="true" />{t("Waiting for your OK")}</>
                  : task.state === "done" ? <><Check aria-hidden="true" />{t("Done")}</>
                  : <><span className="assistant-voice-dot" aria-hidden="true" />{t("Working…")}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!live && working > 0 && <p className="assistant-voice-bar is-inline" role="status"><WorkingLine count={working} /></p>}
      <div className="assistant-voice-controls">
        {left !== null && <span className="assistant-voice-minutes">{t("{n} min left", { n: left })}</span>}
        {live && <>
          <button type="button" className="btn assistant-voice-mute" aria-pressed={voice.muted} onClick={() => assistantVoice.toggleMute()}>
            {voice.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{t(voice.muted ? "Unmute" : "Mute")}
          </button>
          <button type="button" className="btn btn-danger assistant-voice-end" onClick={() => assistantVoice.end()}>
            <PhoneOff aria-hidden="true" />{t("End")}
          </button>
        </>}
      </div>
    </section>
  );
}

/**
 * The thin line over the Assistant's composer in Chat: the open call (tap: back to Voice), or the
 * tasks still working after a call ended. Nothing otherwise, so Chat stays as it was.
 */
export function AssistantVoiceBar({ onVoice }: { onVoice: () => void }) {
  const t = useT();
  const voice = useAssistantVoice();
  const working = voice.tasks.filter((task) => task.state === "working" && !task.waiting).length;
  if (voice.phase !== "idle") {
    return <button type="button" className="assistant-voice-bar" onClick={onVoice}><span className="assistant-voice-dot is-call" aria-hidden="true" />{t("On call with {name}", { name: voice.persona })}</button>;
  }
  if (working === 0) return null;
  return <button type="button" className="assistant-voice-bar" onClick={onVoice}><WorkingLine count={working} /></button>;
}

/** A result that came while the user was elsewhere: a tap goes to the Assistant and hears it. */
export function AssistantVoiceToast({ onHear }: { onHear: () => void }) {
  const t = useT();
  const voice = useAssistantVoice();
  if (voice.result === null) return null;
  return (
    <div className="assistant-voice-toast" role="status">
      <button type="button" className="assistant-voice-toast-hear" onClick={onHear}>
        <AudioLines aria-hidden="true" />{t("Assistant done — tap to hear")}
      </button>
      <button type="button" className="icon-button" aria-label={t("Dismiss")} onClick={() => assistantVoice.dismissResult()}><X aria-hidden="true" /></button>
    </div>
  );
}

/** The sidebar's mark on the Assistant's PC while a call is open: the call goes on as audio wherever the user is. */
export function OnCallDot({ shown, persona }: { shown: boolean; persona: string }) {
  const t = useT();
  if (!shown) return null;
  const label = t("On call with {name}", { name: persona });
  // the Voice switch's glyph, not a second green dot beside the PC's connection dot
  return <span className="assistant-call-dot" role="img" aria-label={label} title={label}><AudioLines aria-hidden="true" /></span>;
}

/** OnCallDot for one PC's header: shown on the PC the call's Assistant is on. */
export function AssistantCallDot({ machineId }: { machineId: string }) {
  const voice = useAssistantVoice();
  return <OnCallDot shown={voice.machineId === machineId && voice.phase !== "idle"} persona={voice.persona} />;
}
