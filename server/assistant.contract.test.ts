import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";

/** GET /api/health tells the client whether this server is the Assistant VM (OVIS_ASSISTANT=1). */
describe("the Assistant VM flag", () => {
  const webUi = async (environment: string | undefined) => {
    const saved = process.env["OVIS_ASSISTANT"];
    if (environment === undefined) delete process.env["OVIS_ASSISTANT"];
    else process.env["OVIS_ASSISTANT"] = environment;
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-assistant-"));
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/health`);
      expect(response.status).toBe(200);
      return ((await response.json()) as { web_ui: { assistant?: boolean } }).web_ui;
    } finally {
      if (saved === undefined) delete process.env["OVIS_ASSISTANT"];
      else process.env["OVIS_ASSISTANT"] = saved;
      app.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  it("is on only when OVIS_ASSISTANT is 1", async () => {
    expect((await webUi("1")).assistant).toBe(true);
    expect((await webUi(undefined)).assistant).toBe(false);
    expect((await webUi("yes")).assistant).toBe(false);
  });
});
