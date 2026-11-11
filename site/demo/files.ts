import type { DirectoryListing, FileInfo } from "../../shared/protocol.ts";

/** Small fictional source files, held in memory. The public demo never reads a real disk. */
const SOURCES: Record<string, string> = {
  "README.md": "# Workspace files\n\nThis is a fictional project in the Ovis demo.\n\nBrowse the source folder, open a file beside your conversation, and switch between Preview and Source for Markdown.\n",
  "package.json": '{\n  "name": "demo-workspace",\n  "private": true,\n  "scripts": { "test": "bun test" }\n}\n',
  "cli-tools.toml": '# Defaults for the command line tools\nretries = 3\nregistry = "https://registry.example.com"\n',
  "src/config.ts": 'export interface Config {\n  retries: number;\n  registry: string;\n}\n\nexport const defaults: Config = {\n  retries: 3,\n  registry: "https://registry.example.com",\n};\n\nexport function resolveConfig(file: Partial<Config>, flags: Partial<Config>): Config {\n  return { ...defaults, ...file, ...flags };\n}\n',
  "src/metrics.ts": 'export const metrics = {\n  payments_idempotent_replays_total: 0,\n};\n\nexport function recordReplay(): void {\n  metrics.payments_idempotent_replays_total++;\n}\n',
  "src/lib/idempotency.ts": 'const replies = new Map<string, unknown>();\n\nexport function cachedReply(key: string): unknown {\n  return replies.get(key);\n}\n\nexport function rememberReply(key: string, reply: unknown): void {\n  replies.set(key, reply);\n}\n',
  "src/routes/payments.ts": 'import { cachedReply, rememberReply } from "../lib/idempotency";\n\nexport function payment(key: string, amount: number): unknown {\n  const cached = cachedReply(key);\n  if (cached) return cached;\n  const reply = { id: "payment-demo", amount };\n  rememberReply(key, reply);\n  return reply;\n}\n',
  "src/money.ts": 'export function cents(amount: number): number {\n  return Math.round(amount * 100);\n}\n',
  "src/money.test.ts": 'import { expect, test } from "bun:test";\nimport { cents } from "./money";\n\ntest("money is rounded to cents", () => {\n  expect(cents(12.34)).toBe(1234);\n});\n',
  "src/pages/Reports.tsx": 'export function Reports() {\n  return <main><h1>Reports</h1><button>Export report</button></main>;\n}\n',
  ".gitignore": "node_modules/\ndist/\n.env\n",
};
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function demoFilePath(asked: string, cwd = "/home/demo"): string {
  const absolute = asked === "~" ? "/home/demo" : asked.startsWith("~/") ? `/home/demo/${asked.slice(2)}` : asked.startsWith("/") ? asked : `${cwd}/${asked}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function demoSourceFile(path: string, roots: readonly string[]): { info: FileInfo; text: string } | null {
  const root = roots.filter(root => path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const name = path.slice(root.length + 1), text = SOURCES[name];
  if (text === undefined) return null;
  return { text, info: { path, name: name.split("/").at(-1)!, size: bytes(text), modified: "2026-10-28T00:00:00Z", mime: name.endsWith(".md") ? "text/markdown" : "text/plain", kind: "text" } };
}

export function demoDirectory(path: string, roots: readonly string[], hidden: boolean, files: boolean): DirectoryListing | null {
  if (demoSourceFile(path, roots)) return null;
  const prefix = path === "/" ? "/" : `${path}/`;
  const directories = new Set<string>();
  const entries = new Map<string, number>();
  for (const root of roots) {
    if (root.startsWith(prefix)) directories.add(root.slice(prefix.length).split("/")[0]!);
    for (const [name, text] of Object.entries(SOURCES)) {
      const full = `${root}/${name}`;
      if (!full.startsWith(prefix)) continue;
      const tail = full.slice(prefix.length), first = tail.split("/")[0]!;
      if (!hidden && first.startsWith(".")) continue;
      if (tail.includes("/")) directories.add(first);
      else entries.set(first, bytes(text));
    }
  }
  return { path, parent: path === "/" ? null : path.replace(/\/[^/]*$/, "") || "/", home: "/home/demo", directories: [...directories].sort(), truncated: false,
    ...(files ? { files: [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, size]) => ({ name, size })) } : {}) };
}
