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

import { join } from 'node:path';
import { LANDING_PATH, SDK_PATH, SKILL_PATH } from '@repo/kthx/assets';
import { FAVICON_PATH } from '@repo/kthx/favicon';
import { AI_IDLE_SECONDS, aiApi } from './ai.ts';
import { createClient, migrate } from './db.ts';
import { bucketDepot, type Depot, diskDepot } from './depot.ts';
import { dbApi } from './documents.ts';
import { type Config, readConfig } from './env.ts';
import { filesApi, serveFile } from './files.ts';
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
import { spendAll, writes } from './limits.ts';
import { mcpApi } from './mcp.ts';
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
 * The landing page, as v2 tells it.
 *
 * `packages/kthx/landing.html` is one file served by two processes: the v1 apex
 * Spindrift still answers reads the same asset, and every button on it would
 * break the moment a republished image carried v2's paths. So the file on disk
 * stays v1's and this process rewrites it as it serves.
 *
 * ponytail: a list of literal swaps, applied once. The whole table is deleted
 * with `apps/spindrift/src/kthx/` in the migration ticket, which is what makes
 * the asset ours to edit in place.
 */
const V2: readonly (readonly [string, string])[] = [
  ['const API = "/kthx/sites"', 'const API = "/api/sites"'],
  ['"/_/sdk.js"', '"/api/sdk.js"'],
  [
    '<b>alias kthx="bun ~/src/infra/apps/kthx/cli/main.ts"</b>  <i># apps/kthx, from a checkout of this repo</i>',
    '<b>bun add -g https://kthx.dev/cli/kthx.tgz</b>  <i># the only install; there is no npm package</i>',
  ],
  [
    '<span class="p">$</span> <b>kthx dev</b>\n<i>  serves ./ on http://localhost:4321 — sdk in local mode, data stays on this machine</i>',
    '<span class="p">$</span> <b>kthx init</b>\n<i>  quiet-lynx-73 — kthx.json, SKILL.md and index.html written; run kthx deploy</i>\n\n<span class="p">$</span> <b>kthx dev</b>\n<i>  serves ./ on http://localhost:4321</i>\n<i>  /api and /files go to</i> <u>https://quiet-lynx-73.kthx.dev</u> <i>— the live database, not a copy</i>',
  ],
  [
    '<span>Releases and rollbacks come from Spindrift.</span>',
    '<span>Every site keeps its releases; <code>kthx rollback</code> serves an earlier one.</span>',
  ],
];

let landing: Promise<string> | null = null;

function landingHtml(): Promise<string> {
  landing ??= Bun.file(LANDING_PATH)
    .text()
    .then((html) => {
      let out = html;
      for (const [from, to] of V2) out = out.replace(from, to);
      return out;
    });
  return landing;
}

/**
 * The CLI, as the tarball `bun add -g` installs from.
 *
 * Built into the image by `apps/kthx/pack.ts`, so the command line a site's
 * owner installs is always the one this server answers. A checkout that has
 * not run `bun run pack` has no tarball and says so rather than serving a file
 * that is not there.
 */
const TARBALL = join(import.meta.dir, '..', 'dist', 'kthx.tgz');

async function tarball(id: string): Promise<Response> {
  return (await Bun.file(TARBALL).exists())
    ? asset(TARBALL, 'application/gzip', 'public, max-age=300')
    : refuse('NOT_FOUND', id);
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
  if (path === '/cli/kthx.tgz') return tarball(ctx.id);
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
 * `files` sits ahead of the provisioning wait on purpose: its rows are in the
 * control database, so a site's bytes keep being served while its own database
 * is being made or repaired.
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

  // Public bytes: no cookie is minted on them, because a `set-cookie` would
  // take every one out of the edge cache, and no same-site guard either —
  // there is nothing here a foreign page could not fetch as an image anyway.
  if (path === '/files' || path.startsWith('/files/')) {
    return serveFile(request, ctx, name, path);
  }

  const owner = opensSite(request, row.token_hash);
  // The upgrade is a `GET` and is guarded all the same: a socket is a write
  // channel, and a foreign page opening one is exactly what this stops.
  const guarded = request.method !== 'GET' || path === '/api/ws';
  if (guarded && !owner && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const me = meOf(request, name, ctx.config.meKey, ctx.config.mePreviousKey);
  const address = addressOf(request, ctx.server, ctx.config.trustedProxies);

  if (path === '/api/files' || path.startsWith('/api/files/')) {
    const refusal = charge(
      ctx,
      name,
      me,
      owner,
      address,
      request.method === 'PUT' || request.method === 'DELETE',
    );
    if (refusal !== null) return refusal;
    return cookied(await filesApi(request, ctx, name, path, me, owner), me);
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

  if (path === '/api/mcp') {
    // No stream to open, so nothing but `POST` is a message.
    if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    if (!owner) {
      return refuse(
        request.headers.get('authorization') === null
          ? 'UNAUTHENTICATED'
          : 'FORBIDDEN',
        ctx.id,
      );
    }
    // The bucket is spent inside, per tool: a `tools/list` or a `db_query` is
    // a read, and the contract leaves reads unmetered over every transport.
    // No cookie: this surface has a bearer, and a visitor id it never uses.
    return mcpApi(request, ctx, name);
  }

  if (segments[2] === 'db') {
    // A bulk `POST` is one unit, and `POST …/query` is a read spelled with a
    // body — neither is the thing the write buckets are counting.
    const metered =
      !READ_METHODS.has(request.method) && segments[4] !== 'query';
    const refusal = charge(ctx, name, me, owner, address, metered);
    if (refusal !== null) return refusal;
    return cookied(await dbApi(request, ctx, name, segments, owner), me);
  }
  if (segments[2] === 'ai') {
    // The two GETs here — `usage` and the model list — are this server's own
    // numbers, reach no upstream and cost nothing. Charging them would leave a
    // foreign page able to spend a victim site's day on a `no-cors` GET, which
    // carries no `Origin` for the guard above to catch.
    const refusal = read ? null : charge(ctx, name, me, owner, address, true);
    if (refusal !== null) return refusal;
    // A model thinks for longer than Bun's 10 s connection idle timeout, which
    // would otherwise cut a streaming completion off mid-answer.
    ctx.server?.timeout(request, AI_IDLE_SECONDS);
    return cookied(await aiApi(request, ctx, name, segments, address), me);
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
 * `metered` is the caller's to decide, because it is not the same question on
 * every backend: reads and `POST …/query` are free on `/api/db` (a bulk `POST`
 * is one unit), a `GET /api/files` is a listing, and every `/api/ai` call costs
 * the operator money and is charged whatever its method. An owner bearer skips
 * the visitor and address buckets and never the site one, so a token that leaks
 * cannot outrun the site's own ceiling.
 */
function charge(
  ctx: Ctx,
  name: string,
  me: Me,
  owner: boolean,
  address: string | null,
  metered: boolean,
): Response | null {
  if (!metered) return null;
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
