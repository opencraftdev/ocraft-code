/**
 * The header's Assistant | Code switch and the Assistant VM's address, both per device, in keys of
 * their own like the sidebar width (never in ovis:settings, which an older tab rewrites whole).
 */
import { useState } from "react";

export type AppMode = "assistant" | "code";

const MODE_KEY = "ovis:app-mode";
const ADDRESS_KEY = "ovis:assistant-address";

/** The install command the setup page shows; the script is the repository's own. */
export const ASSISTANT_INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/opencraftdev/ocraft-code/main/scripts/install-assistant.sh | bash";

/** Anything but "assistant" is Code mode: today's app is the default. */
export function parseAppMode(stored: string | null): AppMode {
  return stored === "assistant" ? "assistant" : "code";
}

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}

export function storedAppMode(): AppMode { return parseAppMode(read(MODE_KEY)); }
export function storeAppMode(mode: AppMode): void { write(MODE_KEY, mode); }
export function storedAssistantAddress(): string { return read(ADDRESS_KEY) ?? ""; }
export function storeAssistantAddress(address: string): void { write(ADDRESS_KEY, address); }

/** The typed address as an http(s) link (https:// when no scheme is given), or null when it is none. */
export function assistantLink(address: string): string | null {
  const text = address.trim();
  if (text === "") return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The header's switch: the mode this device last chose, and the way to choose another. */
export function useAppMode(): [AppMode, (mode: AppMode) => void] {
  const [mode, setMode] = useState<AppMode>(storedAppMode);
  return [mode, (next) => { setMode(next); storeAppMode(next); }];
}
