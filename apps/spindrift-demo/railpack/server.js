/**
 * A service with no Dockerfile, which is the whole point.
 *
 * `buildkit.ts` switches frontends on `[ -f Dockerfile ]` in the scope, so
 * this directory staying Dockerfile-free is what routes it through railpack.
 * It is also self-contained — no workspace dependency, no root lockfile —
 * because the zero-config arm builds with the *scope* as its context, not the
 * repository root.
 *
 * Node built-ins only, deliberately. A dependency here would prove railpack
 * can install one, but it would also make the demo fail for a reason that has
 * nothing to do with Spindrift the first time a registry is slow.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT) || 3000;
const startedAt = new Date();

/** What the build wrote, or null if the build phase never ran. */
function buildStamp() {
  try {
    return JSON.parse(
      readFileSync(new URL('./build-stamp.json', import.meta.url), 'utf-8'),
    );
  } catch {
    return null;
  }
}

const routes = {
  '/': () => {
    const stamp = buildStamp();
    return {
      service: 'spindrift-demo-railpack',
      builtBy: 'railpack (no Dockerfile in this scope)',
      build: stamp ?? 'MISSING — `npm run build` never ran',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    };
  },
  // A liveness answer that is cheap and says nothing else, so a probe pointed
  // at it does not depend on the build having succeeded.
  '/healthz': () => ({ ok: true }),
  '/env': () => ({
    // Only the names. Printing a value here would make the obvious demo of
    // "wire a secret to this App" the same thing as leaking it.
    names: Object.keys(process.env).sort(),
  }),
};

createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const handler = routes[path];
  res.writeHead(handler ? 200 : 404, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(
    `${JSON.stringify(
      handler ? handler() : { error: 'not found', routes: Object.keys(routes) },
      null,
      2,
    )}\n`,
  );
}).listen(port, () => {
  console.log(`spindrift-demo-railpack listening on :${port}`);
});
