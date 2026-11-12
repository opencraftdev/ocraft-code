/**
 * The Assistant VM's address, per device, in a key of its own like the sidebar width (never in
 * ovis:settings, which an older tab rewrites whole), and how Code mode tells the Assistant apart.
 */
import { useState } from "react";

export type AppMode = "assistant" | "code";

const ADDRESS_KEY = "ovis:assistant-address";

/** The install command the setup page shows; the script is the repository's own. */
export const ASSISTANT_INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/opencraftdev/ocraft-code/main/scripts/install-assistant.sh | bash";

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}

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

/** The Assistant's own pane: its agent runs in the Assistant's folder on the VM (server/assistant-sessions.ts). */
export function isAssistantPane(cwd: string | null | undefined): boolean {
  return typeof cwd === "string" && /\/ovis\/assistant\/agent\/?$/.test(cwd);
}

/** Assistant mode (the setup page, from the ⋯ menu) or Code mode: every visit starts in Code. */
export function useAppMode(): [AppMode, (mode: AppMode) => void] {
  return useState<AppMode>("code");
}
