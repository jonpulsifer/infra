/**
 * Static file server — serves dist/ for production, or src/ for dev.
 *
 * Beyond handing back files, it stamps one page — `/` — with the real runtime
 * the static host gave it, so a redeploy or a pod restart is visible on the
 * page rather than only in the UI that deployed it. The same facts are on
 * `/__runtime__` as JSON and `/healthz` as a liveness answer, so a probe or a
 * curious curl can read them without a browser.
 */
import { extname } from 'node:path';
import { hostname, platform, arch } from 'node:os';
import process from 'node:process';

const dir = Bun.env.NODE_ENV === 'production' ? 'dist' : 'src';
const startedAt = new Date();

/**
 * Which hosting platform is this, in its own words.
 *
 * Ordered most-specific first: Firebase App Hosting runs on Cloud Run and so
 * carries the `K_*` set too, so it has to be tested before the raw Cloud Run
 * arm or it reads as "Cloud Run" on an App Hosting release — the wrong logo.
 * Cloudflare Pages and Vercel set their own markers; Kubernetes leaves
 * `KUBERNETES_SERVICE_HOST`; AWS container surfaces put an account-shaped var
 * here. "unknown" is an honest answer rather than a guess.
 */
function detectPlatform(env: Record<string, string | undefined>): {
  id: string;
  name: string;
  by: string;
} {
  if (env.VERCEL || env.VERCEL_ENV)
    return {
      id: 'vercel',
      name: 'Vercel',
      by: env.VERCEL_ENV ? 'VERCEL_ENV' : 'VERCEL',
    };
  if (env.FIREBASE_CONFIG && (env.K_SERVICE || env.K_CONFIGURATION))
    return {
      id: 'firebase-app-hosting',
      name: 'Firebase App Hosting',
      by: 'FIREBASE_CONFIG + K_SERVICE',
    };
  if (
    env.K_SERVICE ||
    env.K_CONFIGURATION ||
    env.K_REVISION ||
    env.CLOUD_RUN_JOB
  )
    return {
      id: 'cloud-run',
      name: 'Google Cloud Run',
      by: env.K_SERVICE
        ? 'K_SERVICE'
        : env.CLOUD_RUN_JOB
          ? 'CLOUD_RUN_JOB'
          : 'K_CONFIGURATION',
    };
  if (env.KUBERNETES_SERVICE_HOST || env.KUBERNETES_SERVICE_PORT)
    return {
      id: 'kubernetes',
      name: 'Kubernetes',
      by: 'KUBERNETES_SERVICE_HOST',
    };
  if (env.CF_PAGES)
    return { id: 'cloudflare-pages', name: 'Cloudflare Pages', by: 'CF_PAGES' };
  if (
    env.AWS_EXECUTION_ENV ||
    env.ECS_CONTAINER_METADATA_URI_V4 ||
    env.AWS_REGION
  )
    return {
      id: 'aws',
      name: 'AWS',
      by: env.AWS_EXECUTION_ENV
        ? 'AWS_EXECUTION_ENV'
        : env.AWS_REGION
          ? 'AWS_REGION'
          : 'ECS_CONTAINER_METADATA_URI_V4',
    };
  return { id: 'unknown', name: 'Unknown host', by: '—' };
}

/**
 * Environment vars whose values are safe to print — they are platform-provided
 * identifiers, never operator secrets. Everything else is omitted, so wiring
 * a real secret to this App never leaks through the demo. The railpack
 * service's `/env` keeps the names-only surface plus this same curated set.
 */
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

/** A value-safe view of the environment: known-safe platform vars only. */
function envView(env: Record<string, string | undefined>) {
  const values: Record<string, string> = {};
  for (const name of [...SAFE_ENV].sort()) {
    const value = env[name];
    if (value !== undefined) values[name] = value;
  }
  return { values, names: Object.keys(values) };
}

/** The facts one page needs. Computed per request so the uptime stays honest. */
function runtimeFacts() {
  const plat = detectPlatform(process.env);
  const pm = runMode();
  return {
    server: {
      platform: plat.id,
      platformName: plat.name,
      detectedBy: plat.by,
      hostname: hostname(),
      pid: process.pid,
      port: Number(Bun.env.PORT) || 3000,
      runtime: pm,
      os: `${platform()}/${arch()}`,
      startedAt: startedAt.toISOString(),
      utcNow: new Date().toISOString(),
      build: Bun.env.SPINDRIFT_BUILD ?? null,
    },
    env: envView(process.env),
  };
}

/** What "Node" version this is, including the Bun-in-Node-interop name it reports. */
function runMode(): string {
  const bunVersion = (Bun as unknown as { version?: string }).version;
  return bunVersion ? `bun ${bunVersion}` : `node ${process.version}`;
}

/** JSON for an inline script must not let an environment value close the tag. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/healthz')
      return Response.json({ ok: true, since: startedAt.toISOString() });
    if (path === '/__runtime__')
      return Response.json(runtimeFacts(), {
        headers: { 'cache-control': 'no-store' },
      });

    const file = `${dir}${path === '/' ? '/index.html' : path}`;
    const buf = Bun.file(file);
    if (!(await buf.exists())) return new Response('404', { status: 404 });

    // Stamp `/` with the live runtime so the page carries the environment it
    // was served from. Done here rather than at build time, because the facts
    // are about *this* process, not the one that built the bundle.
    if (path === '/' || path === '/index.html') {
      let html = await buf.text();
      const inject = `<script>window.__SPINDRIFT_RUNTIME__=${inlineJson(runtimeFacts())};</script>`;
      html = html.replace('<!--{{RUNTIME}}-->', inject);
      return new Response(html, {
        headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' },
      });
    }

    return new Response(buf, {
      headers: {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      },
    });
  },
});

console.log(
  `spindrift-demo → http://localhost:${Bun.env.PORT || 3000} (${dir}/)`,
);
// Tell the operator where it landed, in the server's own words, the way the job does.
console.log(
  `spindrift-demo runtime → ${detectPlatform(process.env).name} (hostname ${hostname()})`,
);
