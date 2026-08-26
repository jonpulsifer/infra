import { expect, test } from "bun:test";
import { onRequest } from "./mcp";

const docs = JSON.parse(await Bun.file(`${import.meta.dir}/../dist/pages.json`).text());
const env = {
  ASSETS: { fetch: async () => new Response(JSON.stringify(docs)) },
};
const rpc = async (method: string, params?: unknown) => {
  const res = await onRequest({
    request: new Request("https://wiki.lolwtf.ca/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  } as never);
  return res.json() as Promise<{ result?: any; error?: any }>;
};
const textOf = (r: { result?: any }) => r.result.content[0].text as string;

test("initialize advertises tools", async () => {
  expect((await rpc("initialize")).result.capabilities.tools).toBeDefined();
  expect((await rpc("tools/list")).result.tools).toHaveLength(3);
});

test("read_page resolves a page by name", async () => {
  const out = textOf(await rpc("tools/call", {
    name: "read_page",
    arguments: { page: "Architecture/Kubernetes" },
  }));
  expect(out).toContain("clusters/folly/");
});

test("search finds the pages that mention a term", async () => {
  const out = textOf(await rpc("tools/call", {
    name: "search",
    arguments: { query: "jellyfin" },
  }));
  expect(out).toContain("Architecture/Cluster Applications");
  expect(out).toContain("jellyfin");
});

test("a missing page and an unknown tool both say so", async () => {
  expect(textOf(await rpc("tools/call", { name: "read_page", arguments: { page: "nope" } })))
    .toContain("no such wiki page");
  expect((await rpc("tools/call", { name: "bogus", arguments: {} })).error.code).toBe(-32601);
});
