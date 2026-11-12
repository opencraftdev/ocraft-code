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

/**
 * The VM's page to embed in Assistant mode: only an https tailnet address (`*.ts.net`), the one the
 * install prints and the one this Ovis's policy may frame (server/static.ts withAssistantFraming).
 */
export function assistantEmbed(address: string): string | null {
  const link = assistantLink(address);
  if (link === null) return null;
  const url = new URL(link);
  return url.protocol === "https:" && url.hostname.endsWith(".ts.net") ? url.href : null;
}

/**
 * Whether a remote PC's SSH destination (`user@host`, `host:port`, or a short tailnet name) is the
 * Assistant VM saved on this device: its host is the saved address's host, or that host's first label.
 * ponytail: matched by name on this device only; the VM could say so itself over its bridge if
 * another device needs the tag without the address saved.
 */
export function isAssistantMachine(destination: string | undefined, address = storedAssistantAddress()): boolean {
  const link = assistantLink(address);
  if (!destination || link === null) return false;
  const host = destination.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  const vm = new URL(link).hostname.toLowerCase();
  return host === vm || host === vm.split(".")[0];
}

/**
 * The query flag the setup page's frame loads the VM with: that page shows its Assistant alone, with
 * no header, mode switch or Code sidebar. It changes only the layout, and only for that load.
 */
export const ASSISTANT_EMBED_PARAM = "assistant-embed";

export function embeddedAssistant(search: string): boolean {
  return new URLSearchParams(search).get(ASSISTANT_EMBED_PARAM) === "1";
}

/** The address the frame loads: the VM's page with the embed flag. */
export function assistantFrame(embed: string): string {
  const url = new URL(embed);
  url.searchParams.set(ASSISTANT_EMBED_PARAM, "1");
  return url.href;
}

/**
 * The mode a page load starts in, without storing it: Assistant in the frame, Code for a link to a
 * pane (a task opened from the frame's board), else the one this device last chose.
 */
export function initialAppMode(search: string): AppMode {
  if (embeddedAssistant(search)) return "assistant";
  return new URLSearchParams(search).has("pane") ? "code" : storedAppMode();
}

/** The header's switch: the mode this load starts in, the way to choose another, and whether this load is the frame. */
export function useAppMode(): [AppMode, (mode: AppMode) => void, boolean, boolean, (editing: boolean) => void] {
  const [mode, setMode] = useState<AppMode>(() => initialAppMode(window.location.search));
  // the setup page shown over a saved VM address (the header's ⋯ menu, Change address)
  const [editing, setEditing] = useState(false);
  return [mode, (next) => { setMode(next); storeAppMode(next); }, embeddedAssistant(window.location.search), editing, setEditing];
}
