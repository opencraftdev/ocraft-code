import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { AssistantView } from "./AssistantView.tsx";

const render = (vm: boolean) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(AssistantView, { vm }) }));

describe("Assistant mode", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterAll(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("shows the setup page on an Ovis that is not the Assistant VM", () => {
    const page = render(false);
    expect(page).toContain("data-testid=\"assistant-setup\"");
    expect(page).toContain("scripts/install-assistant.sh | bash");
    expect(page).toContain("Assistant VM address");
    expect(page).not.toContain("assistant-layout");
  });

  it("shows the empty Assistant layout on the VM, with no made-up rows", () => {
    const page = render(true);
    expect(page).toContain("data-testid=\"assistant-layout\"");
    for (const section of ["Machines", "Projects", "Sessions", "Tasks"]) expect(page).toContain(`>${section}</h2>`);
    expect(page.match(/None yet/g)).toHaveLength(4);
    expect(page).not.toContain("assistant-setup");
  });
});
