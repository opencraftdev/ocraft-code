import { expect, test } from "bun:test";
import { trustNewFolder } from "./trust-new-folder.ts";

const TRUST_SCREEN = " Accessing workspace:\n\n /Users/me/app\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";

test("a new Claude session answers the folder-trust question with trust", async () => {
  let clock = 0;
  const screens = ["Launching Account-1 [session mode]", TRUST_SCREEN];
  const sent: unknown[] = [];
  const answered = await trustNewFolder("p1", {
    read: async () => screens.shift() ?? "",
    send: async (_pane, step) => { sent.push(step); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  expect(answered).toBe(true);
  // one row down from "No, exit" to the trust row, then Enter
  expect(sent).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
});

test("a session with no trust question is left alone", async () => {
  let clock = 0;
  const sent: unknown[] = [];
  const answered = await trustNewFolder("p1", { read: async () => "❯ Try \"fix lint errors\"", send: async (_p, step) => { sent.push(step); }, sleep: async (ms) => { clock += ms; }, now: () => clock });
  expect(answered).toBe(false);
  expect(sent).toEqual([]);
});
