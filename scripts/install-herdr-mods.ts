/**
 * Builds the herdr-app mods in herdr-mods/ and copies them into a herdr-app home's mods folder,
 * where the app picks them up live. Then, given a herdr-app binary, runs its `check` on each.
 *
 *   bun scripts/install-herdr-mods.ts [mods-dir] [--check <herdr-app binary>]
 *
 * mods-dir defaults to $HERDR_APP_HOME/mods, else ~/.config/herdr-app/mods.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildHerdrMods, MODS_DIR } from "./build-herdr-mods.ts";

/** Sources that stay in the repo: the bundle's entry and anything test-only. */
const KEEP_OUT = /^lib\.entry\.ts$|\.test\.[jt]s$/;

export function defaultModsDir(env: Record<string, string | undefined> = process.env): string {
  return env["HERDR_APP_HOME"] ? join(env["HERDR_APP_HOME"], "mods") : join(homedir(), ".config", "herdr-app", "mods");
}

/** Copies every mod into `target`, replacing an earlier copy whole; returns the installed folders. */
export async function installHerdrMods(target: string): Promise<string[]> {
  await buildHerdrMods();
  mkdirSync(target, { recursive: true });
  return readdirSync(MODS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => {
    const out = join(target, name);
    rmSync(out, { recursive: true, force: true });
    cpSync(join(MODS_DIR, name), out, { recursive: true, filter: (source) => !KEEP_OUT.test(source.split(/[\\/]/).at(-1)!) });
    return out;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--check");
  const binary = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !binary) throw new Error("--check needs the herdr-app binary's path");
  const target = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1) ?? defaultModsDir();
  let failed = false;
  for (const dir of await installHerdrMods(target)) {
    console.log(`installed ${dir}`);
    if (!binary) continue;
    if (!existsSync(binary)) throw new Error(`no herdr-app at ${binary}`);
    const check = Bun.spawnSync([binary, "check", dir], { stdout: "inherit", stderr: "inherit" });
    failed ||= check.exitCode !== 0;
  }
  if (failed) process.exit(1);
}
