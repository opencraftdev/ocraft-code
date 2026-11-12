import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { assistantLink, isAssistantMachine, isAssistantPane, storeAssistantAddress, storedAssistantAddress } from "./assistantMode.ts";

describe("this device", () => {
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

    it("remembers the VM address per device, and nothing when storage is blocked", () => {
      expect(storedAssistantAddress()).toBe("");
      storeAssistantAddress("ovis-assistant.example.ts.net");
      expect(storedAssistantAddress()).toBe("ovis-assistant.example.ts.net");
      failing = true;
      expect(storedAssistantAddress()).toBe("");
    });
  });
});

describe("the Assistant in Code mode", () => {
  it("knows the Assistant's pane by its folder", () => {
    expect(isAssistantPane("/home/opencraft/.config/ovis/assistant/agent")).toBe(true);
    expect(isAssistantPane("/home/opencraft/.config/ovis/assistant/agent/")).toBe(true);
    expect(isAssistantPane("/home/opencraft/repo")).toBe(false);
    expect(isAssistantPane(null)).toBe(false);
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

describe("isAssistantMachine", () => {
  const address = "raka-devs.tail38376d.ts.net";
  it("matches the saved VM by its host, with or without a user, port or tailnet suffix", () => {
    expect(isAssistantMachine("opencraft@raka-devs.tail38376d.ts.net", address)).toBe(true);
    expect(isAssistantMachine("raka-devs:2222", address)).toBe(true);
    expect(isAssistantMachine("opencraft@RAKA-DEVS", "https://raka-devs.tail38376d.ts.net")).toBe(true);
  });
  it("matches nothing else, and nothing with no address saved", () => {
    expect(isAssistantMachine("potenlab-macbookpro", address)).toBe(false);
    expect(isAssistantMachine("raka-devs-2.tail38376d.ts.net", address)).toBe(false);
    expect(isAssistantMachine(undefined, address)).toBe(false);
    expect(isAssistantMachine("raka-devs", "")).toBe(false);
  });
});
