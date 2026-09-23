/** Preview server for dist/ — `bun run dev`. Serves /mcp through functions/mcp.ts, as Cloudflare Pages does. */
import { join } from "node:path";
import { onRequest } from "./functions/mcp";

const DIST = join(import.meta.dir, "dist");

const asset = async (path: string) => {
  for (const candidate of [path, join(path, "index.html")]) {
    const f = Bun.file(join(DIST, candidate));
    if (await f.exists()) return new Response(f);
  }
  return new Response(Bun.file(join(DIST, "404.html")), { status: 404 });
};

Bun.serve({
  port: 8787,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp")
      return onRequest({ request, env: { ASSETS: { fetch: (req) => asset(new URL(req instanceof Request ? req.url : req).pathname) } } });
    return asset(path);
  },
});

console.log("wiki preview → http://localhost:8787");
