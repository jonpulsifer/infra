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
import { dbApi } from './documents.ts';
import { type Config, readConfig } from './env.ts';
import {
  addressOf,
  hostOf,
  logCause,
  ok,
  portOf,
  refuse,
  requestId,
  sameOrigin,
  siteOf,
  siteUrl,
} from './http.ts';
import {
  spendAll,
  TokenBucket,
  WRITE_ADDRESS,
  WRITE_SITE,
  WRITE_VISITOR,
} from './limits.ts';
import { type Me, meOf } from './me.ts';
import { Pg } from './pg.ts';
import { type SocketData, socketsFull, websocket } from './realtime.ts';
import { ensureRelease, releaseDir } from './releases.ts';
import {
  decodePath,
  faviconResponse,
  notHere,
  staticResponse,
} from './serve.ts';
import { type Ctx, opensSite, sitesApi } from './sites.ts';

/** The one sentence a v1 site's old calls get. No shim: they fail loudly. */
const RETIRED = 'the /_/ API is retired; use /api/ — https://kthx.dev/skill.md';

const READ_METHODS = new Set(['GET', 'HEAD']);

/** The server-wide body ceiling; every route caps below it. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function asset(path: string, type: string, cacheControl: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      'content-type': type,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * The landing page, with its two endpoint literals moved to this API.
 *
 * `packages/kthx/landing.html` is one file served by two processes: the v1 apex
 * Spindrift still answers reads the same asset, and every button on it would
 * break the moment a republished image carried v2's paths. So the file on disk
 * stays v1's and this process rewrites it as it serves.
 *
 * ponytail: two string replacements, read once. They are deleted with
 * `apps/spindrift/src/kthx/` in the migration ticket, which is what makes the
 * asset ours to edit.
 */
let landing: Promise<string> | null = null;

function landingHtml(): Promise<string> {
  landing ??= Bun.file(LANDING_PATH)
    .text()
    .then((html) =>
      html
        .replace('const API = "/kthx/sites"', 'const API = "/api/sites"')
        .replace('"/_/sdk.js"', '"/api/sdk.js"'),
    );
  return landing;
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
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': ctx.id,
      },
    });
  }
  if (path === '/api' || path.startsWith('/api/')) {
    return refuse('NOT_FOUND', ctx.id);
  }

  if (!READ_METHODS.has(request.method)) {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (path === '/') {
    return new Response(await landingHtml(), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
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
  readonly provisioned_at: Date | null;
  readonly token_hash: string;
  readonly serving: number | null;
  readonly digest: string | null;
  readonly location: string | null;
}

/** The three buckets a write to a site's backends spends. */
const writes = {
  visitor: new TokenBucket(WRITE_VISITOR),
  address: new TokenBucket(WRITE_ADDRESS),
  site: new TokenBucket(WRITE_SITE),
};

async function site(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
): Promise<Response | undefined> {
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

  const reserved =
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/files' ||
    path.startsWith('/files/');

  // Every static byte costs this read, so a database that is briefly away must
  // read as "not here yet" rather than as a JSON 500 in the middle of a page.
  let row: Serving | undefined;
  try {
    [row] = (await ctx.sql`
      select s.deleted_at, s.provisioned_at, s.token_hash, s.serving,
             r.digest, r.location
      from sites s
      left join releases r on r.site = s.name and r.n = s.serving
      where s.name = ${name} limit 1
    `) as Serving[];
  } catch (cause) {
    logCause(ctx.id, 'reading the serving release', cause);
    return reserved ? refuse('BUSY', ctx.id) : page(503);
  }

  if (reserved) {
    if (row === undefined) return refuse('NOT_FOUND', ctx.id);
    if (row.deleted_at !== null) return refuse('GONE', ctx.id);
    return siteApi(request, ctx, name, path, row);
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
 * What `/api` on a site answers.
 *
 * The order matters. `/api/sdk.js` is the one path here that is cacheable and
 * must never carry a cookie, so it is served before anything that mints one.
 * The same-site guard comes next, because `kthx.dev` is not on the Public
 * Suffix List and `SameSite=Lax` therefore separates none of these hosts from
 * one another. Then provisioning: a name has a row before it has a database,
 * and a backend that would reach for one answers 503 rather than 500 while it
 * catches up.
 *
 * `ai`, `files` and `mcp` are their own tickets; until one lands its path is a
 * route this server does not have, which is a 404 and not a promise.
 */
async function siteApi(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
  row: Serving,
): Promise<Response | undefined> {
  const read = READ_METHODS.has(request.method);
  if (path === '/api/sdk.js' && read) {
    return asset(
      SDK_PATH,
      'text/javascript; charset=utf-8',
      'public, max-age=300',
    );
  }

  const owner = opensSite(request, row.token_hash);
  // The upgrade is a `GET` and is guarded all the same: a socket is a write
  // channel, and a foreign page opening one is exactly what this stops.
  const guarded = request.method !== 'GET' || path === '/api/ws';
  if (guarded && !owner && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  if (row.provisioned_at === null) {
    // Idempotent, deduplicated, and not waited for: the caller is told to come
    // back, and the site is repaired by the time it does.
    void ctx.pg.repair(name).catch((cause: unknown) => {
      logCause(ctx.id, `repairing ${name}`, cause);
    });
    return refuse('BUSY', ctx.id);
  }

  if (path === '/api' && read) {
    return ok(
      {
        name,
        url: siteUrl(ctx.config.zone, name, ctx.port),
        docs: `${siteUrl(ctx.config.zone, undefined, ctx.port)}/skill.md`,
      },
      ctx.id,
    );
  }

  const me = meOf(request, name, ctx.config.meKey, ctx.config.mePreviousKey);

  if (path === '/api/me') {
    if (!read) return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return cookied(
      ok(
        {
          id: me.id,
          site: { name, url: siteUrl(ctx.config.zone, name, ctx.port) },
        },
        ctx.id,
      ),
      me,
    );
  }

  if (path === '/api/ws') {
    if (!read) return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return upgrade(request, ctx, name, me);
  }

  const segments = path.split('/');
  if (segments[2] === 'db') {
    const refusal = charge(request, ctx, name, me, owner, segments);
    if (refusal !== null) return refusal;
    return cookied(await dbApi(request, ctx, name, segments, owner), me);
  }
  return refuse('NOT_FOUND', ctx.id);
}

/** Set the cookie on the responses that may carry one, and never cache them. */
function cookied(response: Response, me: Me): Response {
  if (me.setCookie === null) return response;
  response.headers.append('set-cookie', me.setCookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * Spend the write buckets, or say why not.
 *
 * Reads and `POST …/query` are unmetered; a bulk `POST` is one unit. An owner
 * bearer skips the visitor and address buckets and never the site one, so a
 * token that leaks cannot outrun the site's own ceiling.
 */
function charge(
  request: Request,
  ctx: Ctx,
  name: string,
  me: Me,
  owner: boolean,
  segments: readonly string[],
): Response | null {
  const method = request.method;
  const metered =
    method === 'POST' ||
    method === 'PATCH' ||
    method === 'PUT' ||
    method === 'DELETE';
  if (!metered || segments[4] === 'query') return null;
  const address = addressOf(request, ctx.server, ctx.config.trustedProxies);
  const spent = spendAll([
    // A request that arrived without a cookie is keyed by the two things it
    // did have: the cookie it is about to receive is not a fresh allowance.
    [
      writes.visitor,
      owner || me.setCookie !== null ? null : `${name}:${me.id}`,
    ],
    [writes.address, owner || address === null ? null : `${name}:${address}`],
    [writes.site, name],
  ]);
  return spent ? refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' }) : null;
}

/** The socket a tab opens, once it is inside both of the upgrade's caps. */
function upgrade(
  request: Request,
  ctx: Ctx,
  name: string,
  me: Me,
): Response | undefined {
  const address = addressOf(request, ctx.server, ctx.config.trustedProxies);
  if (socketsFull(name, me.id, address)) {
    return refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' });
  }
  const data: SocketData = {
    kind: 'kthx',
    site: name,
    me: me.id,
    address,
    rooms: new Set(),
    subscriptions: new Set(),
    budget: { tokens: 20, at: Date.now() },
  };
  const headers = new Headers();
  if (me.setCookie !== null) headers.append('set-cookie', me.setCookie);
  const upgraded = ctx.server?.upgrade(request, { data, headers }) ?? false;
  return upgraded ? undefined : refuse('MALFORMED_REQUEST', ctx.id);
}

// --- the process ------------------------------------------------------------

/** The server as a function, plus the pools it opened along the way. */
export interface Kthx {
  (
    request: Request,
    server?: Bun.Server<unknown>,
  ): Promise<Response | undefined>;
  /** Closes every site pool. The control connection is the caller's. */
  close(): Promise<void>;
}

export function handler(
  config: Config,
  sql: ReturnType<typeof createClient>,
  depot: Depot,
  pg: Pg = new Pg(config, sql),
): Kthx {
  const answer = async (
    request: Request,
    server?: Bun.Server<unknown>,
  ): Promise<Response | undefined> => {
    const id = requestId();
    const host = hostOf(request);
    const name = siteOf(host, config.zone);
    // A host outside the zone reached this process by mistake or on purpose;
    // either way it learns nothing about what is behind it.
    if (name === null) return refuse('NOT_FOUND', id);

    const ctx: Ctx = {
      config,
      sql,
      pg,
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
  const kthx = answer as Kthx;
  kthx.close = () => pg.close();
  return kthx;
}

/** Once a day: databases and roles no live site row names any more. */
const SWEEP_MS = 24 * 60 * 60 * 1000;

export async function start(): Promise<Bun.Server<unknown>> {
  const config = readConfig();
  const sql = createClient(config.databaseUrl);
  const ran = await migrate(sql);
  if (ran.length > 0) console.log(`migrated: ${ran.join(', ')}`);

  const pg = new Pg(config, sql);
  // The template and the group role, before a claim can want them.
  await pg.bootstrap();

  const depot =
    config.bucket === null
      ? diskDepot(`${config.sitesDir}/.depot`)
      : bucketDepot(config.bucket);
  const fetch = handler(config, sql, depot, pg);

  const server = Bun.serve({
    port: config.port,
    // Raised per request for an upload; this is the floor every other route
    // lives inside.
    idleTimeout: 30,
    // The contract's server-wide ceiling. Bun's default is 128 MiB, which is
    // four times what the largest route here takes and is buffered before any
    // handler sees a byte.
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch,
    websocket,
  });
  console.log(`kthx serving ${config.zone} on :${server.port}`);

  // Not awaited: after a restore or a `KTHX_PG_KEY` rotation every site needs
  // its role's password re-applied, and a site that is asked for first is
  // repaired on the way in anyway. Serving must not wait on the whole estate.
  void pg
    .repairAll()
    .then((failed) => {
      if (failed.length > 0) {
        console.error(`sites still to repair: ${failed.join(', ')}`);
      }
    })
    .catch((cause: unknown) => logCause('boot', 'repairing sites', cause));

  const sweep = setInterval(() => {
    void pg
      .sweep()
      .then((dropped) => {
        if (dropped.length > 0) console.log(`swept: ${dropped.join(', ')}`);
      })
      .catch((cause: unknown) => logCause('sweep', 'dropping orphans', cause));
  }, SWEEP_MS);
  sweep.unref();
  return server;
}

if (import.meta.main) await start();
