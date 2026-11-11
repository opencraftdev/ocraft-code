import { paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

/** Claude Code's folder-trust answer (server/dialogs/claude.ts parses the menu). */
export const TRUST_FOLDER = "Yes, I trust this folder";
const WATCH_MS = 45_000;
const POLL_MS = 500;

export interface TrustDeps {
  read: (paneId: string) => Promise<string>;
  send: (paneId: string, step: { keys?: string[]; text?: string }) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}
const herdr: TrustDeps = {
  read: async (paneId) => (await paneRead({ paneId, source: "detection", format: "text" })).text,
  send: async (paneId, step) => { if (step.keys) await paneSendKeys(paneId, step.keys); else if (step.text !== undefined) await paneSendText(paneId, step.text); },
  // fixed wait: the interval of trustNewFolder's deadline-bounded poll, and the gap between answer keys prompt.ts also leaves
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

/**
 * A Claude Code agent this app just started in a folder the user picked (the New page, a new tab, a
 * fork) answers Claude's folder-trust question itself, so the session never waits behind it: with
 * permission prompts off (agent-launch.ts) the trust check was the one question left. Another
 * account's config (an account-switching `claude` wrapper) asks it again for every folder.
 * Watches the pane for WATCH_MS; any other prompt is left to the chat's card. True when it answered.
 */
export async function trustNewFolder(paneId: string, deps: TrustDeps = herdr): Promise<boolean> {
  const deadline = deps.now() + WATCH_MS;
  while (deps.now() < deadline) {
    const screen = await deps.read(paneId).catch(() => null);
    const prompt = screen === null ? null : parseInteractivePrompt("claude", screen);
    const index = prompt?.options.findIndex((option) => option.label === TRUST_FOLDER) ?? -1;
    if (prompt && index >= 0) {
      for (const step of answerKeys(prompt, { option_index: index })) {
        await deps.send(paneId, step);
        await deps.sleep(30);
      }
      return true;
    }
    await deps.sleep(POLL_MS);
  }
  return false;
}
