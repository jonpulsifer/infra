/**
 * The wiki over MCP, as a Cloudflare Pages Function: stateless streamable HTTP,
 * public and read-only, one JSON-RPC request in and one JSON response out.
 * Pages come from the pages.json that build.ts writes, in nav order.
 */

export interface Doc {
  path: string;
  url: string;
  title: string;
  description: string;
  section: string | null;
  status: string | null;
  markdown: string;
}

const SITE = "https://wiki.lolwtf.ca";

const TOOLS = [
  {
    name: "list_pages",
    description:
      "List every page of the jonpulsifer homelab wiki in reading order, grouped by section (Apps, Platform, Hosts, Runbooks, Reference), with each page's path and one-line description. Start here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description:
      "Search the homelab wiki's titles, descriptions and Markdown bodies, commands included. Returns the best matching pages with their path and an excerpt.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "words to search for" } },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Read one homelab wiki page as Markdown. Accepts its path ('platform/kubernetes'), its URL ('/platform/kubernetes/' or the full https URL) or its title ('Kubernetes'), case-insensitive. A unique ending also works ('kubernetes'), so a relative link from a page's Markdown ('../platform/kubernetes.md#flux') can be passed as-is.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "string", description: "page path, URL or title" } },
      required: ["page"],
    },
  },
];

/** A page's links are relative to its file, so `../bosun.md#x` names `bosun`. */
const pathOf = (q: string) =>
  q
    .replace(/[#?].*$/, "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^docs\//, "")
    .replace(/\.md$/, "")
    .replace(/(?:^|\/)index$/, "");

function find(docs: Doc[], page: string): Doc | string {
  const q = page.trim().toLowerCase();
  if (!q) return "read_page needs a page path, URL or title. Use list_pages to see them.";
  const path = pathOf(q);
  const exact = docs.filter((d) => d.path === path || d.title.toLowerCase() === q);
  const pool = exact.length
    ? exact
    : docs.filter((d) => (path && d.path.endsWith(`/${path}`)) || d.title.toLowerCase().endsWith(` ${q}`));
  if (pool.length === 1) return pool[0];
  if (!pool.length) return `no such wiki page: ${page}. Use list_pages to see what exists.`;
  return `"${page}" matches ${pool.length} pages; ask for one by path:\n${pool.map((d) => `- ${d.path} (${d.title})`).join("\n")}`;
}

function list(docs: Doc[]): string {
  let out = `The homelab wiki, ${docs.length} pages. Read one with read_page and its path.\n`;
  let section: string | null | undefined;
  for (const d of docs) {
    if (d.section !== section) out += `\n## ${d.section ?? "Home"}\n`;
    section = d.section;
    out += `- ${d.path || "/"}: ${d.title}${d.status ? ` [${d.status}]` : ""}. ${d.description}\n`;
  }
  return out.trimEnd();
}

function search(docs: Doc[], query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return "empty query";
  const hits = docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const hay = `${d.description}\n${d.markdown}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const n = hay.split(t).length - 1 + (title.includes(t) ? 10 : 0);
        if (n) score += 100 + n;
      }
      return { d, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!hits.length) return `no wiki page matches ${query}`;
  return hits
    .map(({ d }) => {
      const at = d.markdown.toLowerCase().indexOf(terms.find((t) => d.markdown.toLowerCase().includes(t)) ?? "\0");
      const excerpt = at < 0 ? d.description : d.markdown.slice(Math.max(0, at - 200), at + 400).trim();
      return `## ${d.title}\npath: ${d.path || "/"} · ${SITE}${d.url}\n\n…${excerpt}…`;
    })
    .join("\n\n---\n\n");
}

function call(docs: Doc[], name: string, args: Record<string, unknown>) {
  if (name === "list_pages") return { text: list(docs) };
  if (name === "search") return { text: search(docs, String(args.query ?? "")) };
  if (name === "read_page") {
    const doc = find(docs, String(args.page ?? ""));
    if (typeof doc === "string") return { text: doc, isError: true };
    return { text: `# ${doc.title}\n${SITE}${doc.url}\n\n> ${doc.description}\n\n${doc.markdown.trim()}\n` };
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

/** The Pages Functions context, typed here to avoid depending on @cloudflare/workers-types. */
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
  const error = (message: string) => json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message } });

  switch (rpc.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "homelab-wiki", version: "2" },
      });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const docs: Doc[] = await (await ctx.env.ASSETS.fetch(new URL("/pages.json", ctx.request.url))).json();
      const out = call(docs, rpc.params?.name ?? "", rpc.params?.arguments ?? {});
      if (!out) return error(`unknown tool ${rpc.params?.name}`);
      return reply({ content: [{ type: "text", text: out.text }], ...(out.isError && { isError: true }) });
    }
    default:
      // Notifications (no id) expect no response body.
      if (rpc.id === undefined) return new Response(null, { status: 202, headers: CORS });
      return error(`unknown method ${rpc.method}`);
  }
};
