/**
 * homelab MCP — the wiki, served over the Model Context Protocol.
 *
 * A Cloudflare Pages Function on the same project as the static site, so the
 * MCP endpoint deploys with the wiki and has no infrastructure of its own.
 * Stateless streamable HTTP: one JSON-RPC request in, one JSON response out,
 * no sessions and no SSE. Public and read-only, exactly like the site.
 *
 * Content comes from `pages.json`, the full-text dump build.ts emits next to
 * the rendered pages.
 */

interface Doc {
  t: string; // page name, e.g. "Architecture/Kubernetes"
  u: string; // page url, e.g. "/architecture/kubernetes/"
  x: string; // plain text of every block
}

const SITE = "https://wiki.lolwtf.ca";

const TOOLS = [
  {
    name: "list_pages",
    description:
      "List every page in the jonpulsifer homelab wiki (infrastructure, Kubernetes clusters, NixOS hosts, Terraform, runbooks). Start here to see what is documented.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description:
      "Full-text search across the homelab wiki. Returns matching pages with the surrounding text.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "words to search for" } },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Read one homelab wiki page in full, by its name (e.g. 'Architecture/Kubernetes') or its url path.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "string", description: "page name or url path" } },
      required: ["page"],
    },
  },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function find(docs: Doc[], page: string): Doc | undefined {
  const want = norm(page);
  return (
    docs.find((d) => norm(d.t) === want || norm(d.u) === want) ??
    docs.find((d) => norm(d.t).endsWith(want))
  );
}

function search(docs: Doc[], query: string): string {
  const terms = norm(query).split(" ").filter(Boolean);
  if (terms.length === 0) return "empty query";
  const hits = docs
    .map((d) => {
      const hay = norm(`${d.t} ${d.x}`);
      const score = terms.reduce(
        (n, t) => n + (hay.split(t).length - 1) + (norm(d.t).includes(t) ? 10 : 0),
        0,
      );
      return { d, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (hits.length === 0) return `no wiki page matches ${query}`;
  return hits
    .map(({ d }) => {
      const at = d.x.toLowerCase().indexOf(terms[0]);
      const excerpt = at < 0 ? d.x.slice(0, 400) : d.x.slice(Math.max(0, at - 200), at + 400);
      return `## ${d.t}\n${SITE}${d.u}\n\n…${excerpt.trim()}…`;
    })
    .join("\n\n---\n\n");
}

function call(docs: Doc[], name: string, args: Record<string, unknown>) {
  if (name === "list_pages")
    return docs.map((d) => `${d.t} — ${SITE}${d.u}`).join("\n");
  if (name === "search") return search(docs, String(args.query ?? ""));
  if (name === "read_page") {
    const doc = find(docs, String(args.page ?? ""));
    if (!doc) return `no such wiki page: ${args.page}. Use list_pages to see what exists.`;
    return `# ${doc.t}\n${SITE}${doc.u}\n\n${doc.x}`;
  }
  return null;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...CORS },
  });

/** Pages Functions supply the static assets binding; typed here to avoid a dependency on @cloudflare/workers-types. */
type Ctx = { request: Request; env: { ASSETS: { fetch: (req: Request | URL | string) => Promise<Response> } } };

export const onRequest = async (ctx: Ctx) => {
  if (ctx.request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (ctx.request.method !== "POST")
    // Clients probe with GET before opening an SSE stream; this endpoint has none.
    return new Response("homelab MCP: POST JSON-RPC here", { status: 405, headers: CORS });

  const rpc = (await ctx.request.json()) as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });

  switch (rpc.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "homelab-wiki", version: "1" },
      });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const docs: Doc[] = await (await ctx.env.ASSETS.fetch(new URL("/pages.json", ctx.request.url))).json();
      const out = call(docs, rpc.params?.name ?? "", rpc.params?.arguments ?? {});
      if (out === null)
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `unknown tool ${rpc.params?.name}` },
        });
      return reply({ content: [{ type: "text", text: out }] });
    }
    default:
      // Notifications (no id) expect no response body.
      if (rpc.id === undefined) return new Response(null, { status: 202, headers: CORS });
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `unknown method ${rpc.method}` },
      });
  }
};
