/** Preview server for dist/ — `bun run dev`. */
import { join } from "node:path";

const DIST = join(import.meta.dir, "dist");

Bun.serve({
  port: 8787,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    for (const candidate of [path, join(path, "index.html")]) {
      const f = Bun.file(join(DIST, candidate));
      if (await f.exists()) return new Response(f);
    }
    return new Response(Bun.file(join(DIST, "404.html")), { status: 404 });
  },
});

console.log("wiki preview → http://localhost:8787");
