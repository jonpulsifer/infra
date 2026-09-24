import { afterAll, beforeAll, expect, test } from "bun:test";
import { onRequest } from "../functions/mcp";
import { site } from "./helpers";

let s: Awaited<ReturnType<typeof site>>;
let docs: unknown;
beforeAll(async () => {
  s = await site();
  docs = await s.json("pages.json");
});
afterAll(() => s.cleanup());

const rpc = async (method: string, params?: unknown) => {
  const res = await onRequest({
    request: new Request("https://wiki.lolwtf.ca/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env: { ASSETS: { fetch: async () => new Response(JSON.stringify(docs)) } },
  });
  return res.json() as Promise<{ result?: any; error?: any }>;
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text as string, isError: Boolean(result.isError) };
};

test("initialize advertises three tools", async () => {
  expect((await rpc("initialize")).result.capabilities.tools).toBeDefined();
  const { tools } = (await rpc("tools/list")).result;
  expect(tools.map((t: { name: string }) => t.name)).toEqual(["list_pages", "search", "read_page"]);
});

test("list_pages is in nav order, grouped by section, with descriptions", async () => {
  const { text } = await tool("list_pages");
  const lines = text.split("\n");
  expect(lines).toContain("## Apps");
  expect(lines).toContain("- apps/mate: Rowbutt [parked]. A Discord bot that answers coding questions in a thread.");
  expect(text.indexOf("## Apps")).toBeLessThan(text.indexOf("## Platform"));
  expect(text.indexOf("apps/kthx:")).toBeLessThan(text.indexOf("apps/kthx/built-apps:"));
});

test("read_page accepts a path, a URL or a title, in any case", async () => {
  for (const page of ["apps/mate", "/apps/mate/", "https://wiki.lolwtf.ca/apps/mate/", "ROWBUTT", "docs/apps/mate.md"]) {
    const { text, isError } = await tool("read_page", { page });
    expect(isError).toBe(false);
    expect(text.split("\n")[0]).toBe("# Rowbutt");
  }
  expect((await tool("read_page", { page: "/" })).text).toStartWith("# Home");
});

test("read_page follows the links a page's Markdown carries", async () => {
  const cases = {
    "../kthx.md#before-you-start": "# kthx",
    "kthx/built-apps.md": "# Built apps",
    "./mate.md": "# Rowbutt",
    "../../runbooks/deploy-a-nixos-host.md": "# Deploy a NixOS host",
    "https://wiki.lolwtf.ca/platform/network/#two-sites": "# Network",
    "/apps/mate/?ref=x": "# Rowbutt",
  };
  for (const [page, title] of Object.entries(cases)) expect((await tool("read_page", { page })).text).toStartWith(title);
});

test("read_page returns the Markdown source, commands intact", async () => {
  const { text } = await tool("read_page", { page: "kthx" });
  expect(text).toContain("https://wiki.lolwtf.ca/apps/kthx/");
  expect(text).toContain("nix run .#<hostname> -- switch");
  expect(text).toContain("| jq '.result.tools | length'");
  expect(text).toContain("## Before you start");
});

test("read_page takes a unique suffix, and lists candidates when there are several", async () => {
  expect((await tool("read_page", { page: "built-apps" })).text).toStartWith("# Built apps");
  expect((await tool("read_page", { page: "unifi network" })).text).toStartWith("# Inspect the UniFi network");
  const many = await tool("read_page", { page: "crds" });
  expect(many.isError).toBe(true);
  expect(many.text).toContain("- runbooks/adopt-the-folly-monitoring-crds (Adopt the folly monitoring CRDs)");
  expect(many.text).toContain("- runbooks/adopt-the-folly-prometheus-operator-crds");
});

test("a missing page and an unknown tool both say so", async () => {
  const missing = await tool("read_page", { page: "nope" });
  expect(missing).toEqual({ text: expect.stringContaining("no such wiki page"), isError: true });
  expect((await rpc("tools/call", { name: "bogus", arguments: {} })).error.code).toBe(-32601);
});

test("search matches commands and ranks pages matching every term first", async () => {
  const hit = await tool("search", { query: "nix run .#" });
  expect(hit.text.split("\n")[0]).toBe("## kthx");
  expect(hit.text).toContain("path: apps/kthx");
  const both = await tool("search", { query: "folly crds" });
  expect(both.text).toStartWith("## Adopt the folly");
  expect((await tool("search", { query: "zzzz" })).text).toBe("no wiki page matches zzzz");
});
