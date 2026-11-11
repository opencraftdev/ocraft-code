import { afterEach, expect, it, mock } from "bun:test";
import { fetchPaneDagr } from "./api.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const fakeFetch = (read: (url: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => read(String(input), init)) as unknown as typeof fetch;
};

it("reads the pane's dagr file through the selected machine without executing action data", async () => {
  const urls: string[] = [];
  fakeFetch(async url => { urls.push(url); return Response.json({ dagr: 3, run: { id: "test" }, tasks: [], actions: { command: "never execute this" } }); });
  expect(await fetchPaneDagr("pane & id", "remote-pc")).toMatchObject({ dagr: 3 });
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("/api/machines/remote-pc/fs/file?");
  const query = new URL(urls[0]!, "http://local.test").searchParams;
  expect(query.get("pane_id")).toBe("pane & id");
  expect(query.get("path")).toBe(".dagr/run.json");
});

it("falls back only when absent and ignores an unrelated run.json", async () => {
  const urls: string[] = [];
  fakeFetch(async url => { urls.push(url); return urls.length === 1 ? new Response("missing", { status: 404 }) : Response.json({ application: "another tool" }); });
  expect(await fetchPaneDagr("p")).toBeNull();
  expect(urls).toHaveLength(2);
  expect(new URL(urls[1]!, "http://local.test").searchParams.get("path")).toBe("run.json");
});

it("does not try another file after a permission refusal", async () => {
  const read = mock(async () => new Response("forbidden", { status: 403 }));
  fakeFetch(read);
  expect(await fetchPaneDagr("p")).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

it("cancels a file whose streamed bytes exceed the bound even without a length header", async () => {
  const cancelled = mock(() => undefined);
  fakeFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel: cancelled })));
  await expect(fetchPaneDagr("p")).rejects.toThrow("dagr_too_large");
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("preserves a producer parse failure rather than turning it into an empty workflow", async () => {
  fakeFetch(async () => new Response('{"dagr":3,"tasks":'));
  await expect(fetchPaneDagr("p")).rejects.toThrow();
});
