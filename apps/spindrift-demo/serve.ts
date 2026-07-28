/**
 * Static file server — serves dist/ for production, or src/ for dev.
 */
const dir = Bun.env.NODE_ENV === "production" ? "dist" : "src";

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./${dir}${path}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "content-type":
            path.endsWith(".html") ? "text/html; charset=utf-8"
            : path.endsWith(".css") ? "text/css; charset=utf-8"
            : path.endsWith(".js") ? "application/javascript; charset=utf-8"
            : "application/octet-stream",
        },
      });
    }
    return new Response("404", { status: 404 });
  },
});

console.log(`spindrift-demo → http://localhost:${Bun.env.PORT || 3000} (${dir}/)`);
