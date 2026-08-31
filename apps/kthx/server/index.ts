/**
 * The kthx server: one Bun process, behind the Gateway, answering the apex and
 * every site host.
 *
 * Dispatch is by `Host` before it is by path, because the same `/` means the
 * landing page on `kthx.dev` and a site's `index.html` on `notes.kthx.dev`.
 * Nothing is minted per site — no route, no record, no certificate: the
 * wildcard for the zone reaches this process, and a name is live the moment its
 * row says which release it serves.
 */

import { LANDING_PATH, SDK_PATH, SKILL_PATH } from '@repo/kthx/assets';
import { FAVICON_PATH } from '@repo/kthx/favicon';
import { createClient, migrate } from './db.ts';
import { bucketDepot, type Depot, diskDepot } from './depot.ts';
import { type Config, readConfig } from './env.ts';
import {
  hostOf,
  logCause,
  ok,
  portOf,
  refuse,
  requestId,
  siteOf,
  siteUrl,
} from './http.ts';
import { ensureRelease, releaseDir } from './releases.ts';
import {
  decodePath,
  faviconResponse,
  notHere,
  staticResponse,
} from './serve.ts';
import { type Ctx, sitesApi } from './sites.ts';

/** The one sentence a v1 site's old calls get. No shim: they fail loudly. */
const RETIRED = 'the /_/ API is retired; use /api/ — https://kthx.dev/skill.md';

const READ_METHODS = new Set(['GET', 'HEAD']);

function asset(path: string, type: string, cacheControl: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      'content-type': type,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    },
  });
}

// --- the apex ---------------------------------------------------------------

async function apex(
  request: Request,
  ctx: Ctx,
  path: string,
): Promise<Response> {
  const segments = path.split('/');
  if (segments[1] === 'api' && segments[2] === 'sites') {
    return (
      (await sitesApi(request, ctx, segments)) ?? refuse('NOT_FOUND', ctx.id)
    );
  }
  // The v1 API. Gone rather than moved: its key→JSON plane had no real users,
  // and a shim would be a second contract to keep alive.
  if (path === '/kthx' || path.startsWith('/kthx/')) {
    return refuse('GONE', ctx.id);
  }
  if (path === '/healthz') {
    return new Response('ok\n', {
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  if (path === '/api' || path.startsWith('/api/')) {
    return refuse('NOT_FOUND', ctx.id);
  }

  if (!READ_METHODS.has(request.method)) {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (path === '/') {
    return asset(LANDING_PATH, 'text/html; charset=utf-8', 'no-cache');
  }
  if (path === '/sdk.js') {
    return asset(
      SDK_PATH,
      'text/javascript; charset=utf-8',
      'public, max-age=300',
    );
  }
  if (path === '/skill.md') {
    return asset(
      SKILL_PATH,
      'text/markdown; charset=utf-8',
      'public, max-age=300',
    );
  }
  if (path === FAVICON_PATH) return faviconResponse(request);
  // The tarball is built and served by the CLI ticket; until then the path
  // exists and is empty rather than pointing somewhere that lies.
  if (path === '/cli/kthx.tgz') return refuse('NOT_FOUND', ctx.id);
  return notHere(ctx.host, ctx.config.zone, 404, ctx.id, ctx.port);
}

// --- a site host ------------------------------------------------------------

interface Serving {
  readonly deleted_at: Date | null;
  readonly serving: number | null;
  readonly digest: string | null;
  readonly location: string | null;
}

async function site(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
): Promise<Response> {
  // `/_/` is retired on every name in the zone, claimed or not: it is a
  // statement about the API, not about this site.
  if (path === '/_' || path.startsWith('/_/')) {
    return Response.json(
      { code: 'GONE', message: RETIRED },
      {
        status: 410,
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-request-id': ctx.id,
        },
      },
    );
  }

  const page = (status: 404 | 410 | 503) =>
    notHere(ctx.host, ctx.config.zone, status, ctx.id, ctx.port);

  const [row] = (await ctx.sql`
    select s.deleted_at, s.serving, r.digest, r.location
    from sites s
    left join releases r on r.site = s.name and r.n = s.serving
    where s.name = ${name} limit 1
  `) as Serving[];

  const reserved =
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/files' ||
    path.startsWith('/files/');
  if (reserved) {
    if (row === undefined) return refuse('NOT_FOUND', ctx.id);
    if (row.deleted_at !== null) return refuse('GONE', ctx.id);
    return siteApi(request, ctx, name, path);
  }

  if (row === undefined) return page(404);
  if (row.deleted_at !== null) return page(410);
  if (!READ_METHODS.has(request.method)) {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (row.serving === null || row.digest === null || row.location === null) {
    return page(404);
  }

  const here = await ensureRelease(
    ctx.config.sitesDir,
    name,
    row.serving,
    row.location,
    ctx.depot,
  ).catch((cause) => {
    logCause(ctx.id, 'rehydrating a release', cause);
    return false;
  });
  if (!here) return page(503);

  const answered = await staticResponse(
    request,
    releaseDir(ctx.config.sitesDir, name, row.serving),
    row.digest,
    path,
  );
  return answered ?? page(404);
}

/**
 * What `/api` on a site answers today.
 *
 * `db`, `ws`, `me`, `ai`, `files` and `mcp` are their own tickets; until one
 * lands its path is a route this server does not have, which is a 404 and not a
 * promise.
 */
function siteApi(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
): Response {
  if (path === '/api' && READ_METHODS.has(request.method)) {
    return ok(
      {
        name,
        url: siteUrl(ctx.config.zone, name, ctx.port),
        docs: `${siteUrl(ctx.config.zone, undefined, ctx.port)}/skill.md`,
      },
      ctx.id,
    );
  }
  if (path === '/api/sdk.js' && READ_METHODS.has(request.method)) {
    return asset(
      SDK_PATH,
      'text/javascript; charset=utf-8',
      'public, max-age=300',
    );
  }
  return refuse('NOT_FOUND', ctx.id);
}

// --- the process ------------------------------------------------------------

export function handler(
  config: Config,
  sql: ReturnType<typeof createClient>,
  depot: Depot,
) {
  return async (
    request: Request,
    server?: Bun.Server<unknown>,
  ): Promise<Response> => {
    const id = requestId();
    const host = hostOf(request);
    const name = siteOf(host, config.zone);
    // A host outside the zone reached this process by mistake or on purpose;
    // either way it learns nothing about what is behind it.
    if (name === null) return refuse('NOT_FOUND', id);

    const ctx: Ctx = {
      config,
      sql,
      depot,
      server,
      id,
      host,
      port: portOf(request),
    };
    const path = decodePath(request.url);
    if (path === null) {
      return name === ''
        ? refuse('NOT_FOUND', id)
        : notHere(host, config.zone, 404, id, portOf(request));
    }

    try {
      return name === ''
        ? await apex(request, ctx, path)
        : await site(request, ctx, name, path);
    } catch (cause) {
      logCause(id, `${request.method} ${path}`, cause);
      return refuse('STORAGE_FAILURE', id);
    }
  };
}

export async function start(): Promise<Bun.Server<unknown>> {
  const config = readConfig();
  const sql = createClient(config.databaseUrl);
  const ran = await migrate(sql);
  if (ran.length > 0) console.log(`migrated: ${ran.join(', ')}`);

  const depot =
    config.bucket === null
      ? diskDepot(`${config.sitesDir}/.depot`)
      : bucketDepot(config.bucket);
  const fetch = handler(config, sql, depot);

  const server = Bun.serve({
    port: config.port,
    // Raised per request for an upload; this is the floor every other route
    // lives inside.
    idleTimeout: 30,
    fetch,
  });
  console.log(`kthx serving ${config.zone} on :${server.port}`);
  return server;
}

if (import.meta.main) await start();
