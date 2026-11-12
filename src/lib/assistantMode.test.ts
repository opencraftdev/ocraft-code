import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ASSISTANT_EMBED_PARAM, assistantEmbed, assistantFrame, assistantLink, embeddedAssistant, initialAppMode, parseAppMode, storeAppMode, storeAssistantAddress, storedAppMode, storedAssistantAddress } from "./assistantMode.ts";

describe("the app mode", () => {
  it("is Code unless Assistant was chosen", () => {
    expect(parseAppMode("assistant")).toBe("assistant");
    expect(parseAppMode("code")).toBe("code");
    expect(parseAppMode(null)).toBe("code");
    expect(parseAppMode("chat")).toBe("code");
  });

  describe("in this browser", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    let records: Map<string, string>;
    let failing = false;
    beforeEach(() => {
      records = new Map();
      failing = false;
      const guard = () => { if (failing) throw new Error("blocked"); };
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage: { getItem: (key: string) => { guard(); return records.get(key) ?? null; }, setItem: (key: string, value: string) => { guard(); records.set(key, value); } },
      } });
    });
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    });

    it("remembers the mode and the VM address per device", () => {
      expect(storedAppMode()).toBe("code");
      storeAppMode("assistant");
      expect(storedAppMode()).toBe("assistant");
      storeAppMode("code");
      expect(storedAppMode()).toBe("code");
      expect(storedAssistantAddress()).toBe("");
      storeAssistantAddress("ovis-assistant.example.ts.net");
      expect(storedAssistantAddress()).toBe("ovis-assistant.example.ts.net");
    });

    it("starts the frame in Assistant mode and a pane link in Code mode, leaving the stored mode alone", () => {
      storeAppMode("code");
      expect(initialAppMode("?assistant-embed=1")).toBe("assistant");
      expect(records.get("ovis:app-mode")).toBe("code");
      storeAppMode("assistant");
      expect(initialAppMode("?pane=p_3&machine=m1")).toBe("code");
      expect(initialAppMode("")).toBe("assistant");
      expect(initialAppMode("?assistant-embed=0")).toBe("assistant");
      expect(records.get("ovis:app-mode")).toBe("assistant");
    });

    it("falls back to Code mode when storage is blocked", () => {
      failing = true;
      storeAppMode("assistant");
      expect(storedAppMode()).toBe("code");
      expect(storedAssistantAddress()).toBe("");
    });
  });
});

describe("assistantLink", () => {
  it("makes an https link of a bare address and keeps an http(s) one", () => {
    expect(assistantLink(" ovis-assistant.example.ts.net ")).toBe("https://ovis-assistant.example.ts.net/");
    expect(assistantLink("http://100.64.0.1:7317")).toBe("http://100.64.0.1:7317/");
  });

  it("is no link for nothing or another scheme", () => {
    expect(assistantLink("")).toBeNull();
    expect(assistantLink("javascript://alert(1)")).toBeNull();
    expect(assistantLink("https://")).toBeNull();
  });
});

describe("assistantEmbed", () => {
  it("embeds only an https tailnet address", () => {
    expect(assistantEmbed("raka-devs.tail38376d.ts.net")).toBe("https://raka-devs.tail38376d.ts.net/");
    expect(assistantEmbed("https://raka-devs.tail38376d.ts.net/")).toBe("https://raka-devs.tail38376d.ts.net/");
    expect(assistantEmbed("http://raka-devs.tail38376d.ts.net")).toBeNull();
    expect(assistantEmbed("https://example.com")).toBeNull();
    expect(assistantEmbed("https://ts.net.example.com")).toBeNull();
    expect(assistantEmbed("")).toBeNull();
  });
});

describe("the embedded Assistant", () => {
  it("loads the VM with the embed flag, the one the VM reads back", () => {
    const frame = assistantFrame("https://raka-devs.tail38376d.ts.net/");
    expect(frame).toBe(`https://raka-devs.tail38376d.ts.net/?${ASSISTANT_EMBED_PARAM}=1`);
    expect(embeddedAssistant(new URL(frame).search)).toBe(true);
    expect(embeddedAssistant("")).toBe(false);
    expect(embeddedAssistant("?pane=p_1")).toBe(false);
  });
});
