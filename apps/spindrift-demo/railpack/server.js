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
import { hostname } from 'node:os';

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

/** Which hosting platform this is, in its own words (same detection as serve.ts). */
function detectPlatform() {
  const e = process.env;
  if (e.VERCEL || e.VERCEL_ENV)
    return { id: 'vercel', name: 'Vercel', by: 'VERCEL' };
  if (e.FIREBASE_CONFIG && (e.K_SERVICE || e.K_CONFIGURATION))
    return {
      id: 'firebase-app-hosting',
      name: 'Firebase App Hosting',
      by: 'FIREBASE_CONFIG + K_SERVICE',
    };
  if (e.K_SERVICE || e.K_CONFIGURATION || e.K_REVISION || e.CLOUD_RUN_JOB)
    return {
      id: 'cloud-run',
      name: 'Google Cloud Run',
      by: e.K_SERVICE
        ? 'K_SERVICE'
        : e.CLOUD_RUN_JOB
          ? 'CLOUD_RUN_JOB'
          : 'K_CONFIGURATION',
    };
  if (e.KUBERNETES_SERVICE_HOST || e.KUBERNETES_SERVICE_PORT)
    return {
      id: 'kubernetes',
      name: 'Kubernetes',
      by: 'KUBERNETES_SERVICE_HOST',
    };
  if (e.CF_PAGES)
    return { id: 'cloudflare-pages', name: 'Cloudflare Pages', by: 'CF_PAGES' };
  if (e.AWS_EXECUTION_ENV || e.ECS_CONTAINER_METADATA_URI_V4 || e.AWS_REGION)
    return {
      id: 'aws',
      name: 'AWS',
      by: e.AWS_EXECUTION_ENV
        ? 'AWS_EXECUTION_ENV'
        : e.AWS_REGION
          ? 'AWS_REGION'
          : 'ECS_CONTAINER_METADATA_URI_V4',
    };
  return { id: 'unknown', name: 'Unknown host', by: '—' };
}

/** Platform vars whose values are safe to print (no secrets). */
const SAFE_ENV = new Set([
  'K_SERVICE',
  'K_CONFIGURATION',
  'K_REVISION',
  'K_PORT',
  'PORT',
  'HOSTNAME',
  'SPINDRIFT_BUILD',
  'SPINDRIFT_RUNTIME_LABEL',
  'NODE_ENV',
  'CF_PAGES',
  'CF_PAGES_COMMIT_SHA',
  'CF_PAGES_BRANCH',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_BRANCH',
  'AWS_EXECUTION_ENV',
  'AWS_REGION',
  'CLOUD_RUN_JOB',
  'CLOUD_RUN_EXECUTION',
  'CLOUD_RUN_TASK_INDEX',
  'DYNO',
]);

function envView() {
  const values = {};
  const names = [];
  for (const name of Object.keys(process.env).sort()) {
    names.push(name);
    if (SAFE_ENV.has(name)) values[name] = process.env[name] ?? '';
  }
  return { names, values };
}

const routes = {
  '/': () => {
    const stamp = buildStamp();
    const platform = detectPlatform();
    return {
      service: 'spindrift-demo-railpack',
      builtBy: 'railpack (no Dockerfile in this scope)',
      build: stamp ?? 'MISSING — `npm run build` never ran',
      // The dynamic facts the static demo shows on a page; here on JSON so a
      // probe or a curl sees the same evidence a browser would.
      runtime: {
        platformId: platform.id,
        platform: platform.name,
        detectedBy: platform.by,
        hostname: process.env.HOSTNAME ?? hostname(),
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        spindriftBuild: process.env.SPINDRIFT_BUILD ?? null,
      },
    };
  },
  // A liveness answer that is cheap and says nothing else, so a probe pointed
  // at it does not depend on the build having succeeded.
  '/healthz': () => ({ ok: true, since: startedAt.toISOString() }),
  '/env': () => envView(),
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
