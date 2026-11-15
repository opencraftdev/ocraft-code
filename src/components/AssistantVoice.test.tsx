import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isAssistantPane, useAssistantView } from "../lib/assistantMode.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AssistantCallDot, AssistantViewSwitch, AssistantVoiceBar, AssistantVoiceToast, OnCallDot } from "./AssistantVoice.tsx";

const wrap = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(SettingsProvider, { children: element }));

/** the header's switch as App draws it: for the Assistant's own pane only, on this device's choice */
function Header({ cwd }: { cwd: string }) {
  const [view, setView] = useAssistantView();
  return createElement(AssistantViewSwitch, { shown: isAssistantPane(cwd), view, onChange: setView });
}

describe("the Assistant's Chat | Voice switch", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterAll(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("shows in the Assistant's pane only, on Chat by default", () => {
    const assistant = wrap(createElement(Header, { cwd: "/home/me/.config/ovis/assistant/agent" }));
    expect(assistant).toContain("assistant-view-switch");
    expect([...assistant.matchAll(/aria-pressed="(\w+)" aria-label="([\w ]+)"/g)].map((match) => [match[2], match[1]])).toEqual([["Assistant chat", "true"], ["Assistant voice", "false"]]);
    expect(wrap(createElement(Header, { cwd: "/home/me/code/ovis" }))).toBe("");
  });

  it("leaves Chat as it was: no bar over the composer and no toast without a call or a voice task", () => {
    expect(wrap(createElement(AssistantVoiceBar, { onVoice: () => {} }))).toBe("");
    expect(wrap(createElement(AssistantVoiceToast, { onHear: () => {} }))).toBe("");
  });

  it("marks the Assistant's PC in the sidebar only while a call is open", () => {
    const dot = wrap(createElement(OnCallDot, { shown: true, persona: "Nara" }));
    expect(dot).toContain("class=\"assistant-call-dot\"");
    expect(dot).toContain("role=\"img\"");
    expect(dot).toContain("aria-label=\"On call with Nara\"");
    expect(wrap(createElement(OnCallDot, { shown: false, persona: "Nara" }))).toBe("");
    // no call on this page: no mark on any PC
    expect(wrap(createElement(AssistantCallDot, { machineId: "raka-devs" }))).toBe("");
  });
});
