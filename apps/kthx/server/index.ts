/**
 * The kthx server. It dispatches by `Host` before path: the apex and the
 * private hosts are this process's own, and on a site host it answers `/api/*`
 * and `/files/*`, which nginx forwards. nginx serves every other site path
 * from the sites bucket.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeploymentFederation } from '@repo/archive/federation-credential';
import { federatedAuth } from '@repo/archive/gcs';
import { LANDING_PATH, SDK_PATH, SKILL_PATH } from '@repo/kthx/assets';
import { FAVICON_PATH } from '@repo/kthx/favicon';
import { AI_IDLE_SECONDS, aiApi } from './ai.ts';
import type { Marker } from './bucket.ts';
import { buildApi } from './build.ts';
import { type Caller, callerOf } from './caller.ts';
import { createClient, migrate } from './db.ts';
import { bucketDepot, type Depot, diskDepot } from './depot.ts';
import { dbApi } from './documents.ts';
import { EngineKeys, engineApi } from './engine.ts';
import { type Config, readConfig } from './env.ts';
import { filesApi, serveFile } from './files.ts';
import {
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
import { looksLikeJwt, verifyIdToken } from './identity.ts';
import { spendAll, writes } from './limits.ts';
import { Sites } from './markers.ts';
import { mcpApi } from './mcp.ts';
import { type Me, meOf } from './me.ts';
import { decodePath, faviconResponse, notHere } from './pages.ts';
import { Pg } from './pg.ts';
import { type SocketData, socketsFull, websocket } from './realtime.ts';
import {
  type Ctx,
  ensureSite,
  nameStatus,
  opensSite,
  opensZone,
  sitesApi,
  sweepSites,
} from './sites.ts';

const RETIRED = 'the /_/ API is retired; use /api/ — https://kthx.dev/skill.md';

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Every route caps its body below this. */
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

/** Read once: the file does not change under a running process. */
let landing: Promise<string> | null = null;

/**
 * Tells the page what a browser cannot see: the zone (a private host's name is
 * not it), which door it is, admin rights, the tailnet login and the console's
 * address.
 * These are hints only; every route decides again from the request.
 */
async function landingHtml(
  zone: string,
  caller: Caller,
  admin: boolean,
  consoleUrl: string | null,
): Promise<string> {
  landing ??= Bun.file(LANDING_PATH).text();
  const who =
    caller.login === null ? '' : ` data-login="${attribute(caller.login)}"`;
  const onTailnet = caller.door === 'identity';
  const identity = onTailnet ? ` data-identity${who}` : '';
  const linked =
    consoleUrl === null ? '' : ` data-console="${attribute(consoleUrl)}"`;
  const body = onTailnet ? await whole(landing) : await slim(landing);
  return body.replace(
    '<html lang="en">',
    `<html lang="en" data-zone="${zone}"${caller.control ? '' : ' data-readonly'}${admin ? ' data-admin' : ''}${identity}${linked}>`,
  );
}

/**
 * A builder fence post in `landing.html`, in any of its three comment syntaxes,
 * so one expression strips the builder's markup, rules and script.
 */
const POST = String.raw`[/<]\*?!?-{0,2}\s*builder:%s\s*-{0,2}\*?/?>?`;
const FENCE = new RegExp(`${POST.replace('%s', '(?:start|end)')}\n?`, 'g');
const BUILDER = new RegExp(
  `${POST.replace('%s', 'start')}[\\s\\S]*?${POST.replace('%s', 'end')}`,
  'g',
);

let cut: Promise<string> | undefined;
let kept: Promise<string> | undefined;

/** The page without the builder, for doors that cannot use it. */
function slim(full: Promise<string>): Promise<string> {
  cut ??= full.then((text) => text.replace(BUILDER, '').replace(FENCE, ''));
  return cut;
}

/** The page with the builder, fences removed. */
function whole(full: Promise<string>): Promise<string> {
  kept ??= full.then((text) => text.replace(FENCE, ''));
  return kept;
}

/** For a double-quoted attribute: the login comes from a request header. */
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The CLI tarball `bun add -g` installs, built into the image by `pack.ts`. */
const TARBALL = join(import.meta.dir, '..', 'dist', 'kthx.tgz');
const TARBALL_VERSION = join(import.meta.dir, '..', 'dist', 'version.json');

/**
 * `build` is the id `pack.ts` wrote into the tarball; an installed CLI compares
 * it with one `HEAD`. The etag is the digest of the bytes served.
 */
interface Tarball {
  readonly etag: string;
  readonly build: string | null;
}

let tarballFacts: { key: string; facts: Promise<Tarball> } | null = null;

async function readTarballFacts(): Promise<Tarball | null> {
  const file = Bun.file(TARBALL);
  const stat = await file.stat().catch(() => null);
  if (stat === null) return null;
  const key = `${stat.size}:${stat.mtimeMs}`;
  if (tarballFacts?.key !== key) {
    tarballFacts = {
      key,
      facts: (async () => {
        const etag = `"${new Bun.CryptoHasher('sha256')
          .update(new Uint8Array(await file.arrayBuffer()))
          .digest('hex')}"`;
        const read = (await Bun.file(TARBALL_VERSION)
          .json()
          .catch(() => null)) as { version?: unknown; build?: unknown } | null;
        const build =
          typeof read?.version === 'string' && typeof read.build === 'string'
            ? `${read.version}+${read.build}`
            : null;
        return { etag, build };
      })(),
    };
  }
  return tarballFacts.facts;
}

async function tarball(request: Request, id: string): Promise<Response> {
  const facts = await readTarballFacts();
  if (facts === null) return refuse('NOT_FOUND', id);
  const headers: Record<string, string> = {
    'content-type': 'application/gzip',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    etag: facts.etag,
  };
  if (facts.build !== null) headers['x-kthx-build'] = facts.build;
  if (request.headers.get('if-none-match') === facts.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(TARBALL), { headers });
}

async function apex(
  request: Request,
  ctx: Ctx,
  path: string,
): Promise<Response> {
  const segments = path.split('/');
  if (segments[1] === 'api' && segments[2] === 'sites') {
    // The owner routes ask an ID token or a tailnet login, so every door has them.
    return (
      (await sitesApi(request, ctx, segments)) ?? refuse('NOT_FOUND', ctx.id)
    );
  }
  // Before the `/api/*` catch-all below.
  if (segments[1] === 'api' && segments[2] === 'names') {
    if (!READ_METHODS.has(request.method)) {
      return refuse('METHOD_NOT_ALLOWED', ctx.id);
    }
    const asked = segments.length === 4 ? (segments[3] ?? '') : '';
    if (asked === '') return refuse('NOT_FOUND', ctx.id);
    return nameStatus(ctx, asked);
  }
  // 404 on every other door: no credential would open the builder there.
  if (segments[1] === 'api' && segments[2] === 'build') {
    if (ctx.caller.door !== 'identity') return refuse('NOT_FOUND', ctx.id);
    return buildApi(request, ctx, segments);
  }
  if (path === '/api/whoami') {
    if (!READ_METHODS.has(request.method)) {
      return refuse('METHOD_NOT_ALLOWED', ctx.id);
    }
    // The tailnet login on the identity host, else a verified ID token.
    const login = ctx.caller.login ?? (await ctx.identity());
    return login === null
      ? refuse('UNAUTHENTICATED', ctx.id)
      : ok({ login }, ctx.id);
  }
  // The retired v1 API, with no shim.
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
  if (path === '/api' && READ_METHODS.has(request.method)) {
    // The CLI builds site addresses from this: its origin may not be the zone,
    // and a project file must not decide where a bearer is sent.
    const url = siteUrl(ctx.config.zone, undefined, ctx.port);
    return ok({ zone: ctx.config.zone, url, docs: `${url}/skill.md` }, ctx.id);
  }
  if (segments[1] === 'api' && segments[2] === 'engine') {
    return engineApi(request, ctx, segments);
  }
  if (path === '/api' || path.startsWith('/api/')) {
    return refuse('NOT_FOUND', ctx.id);
  }

  if (!READ_METHODS.has(request.method)) {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (path === '/') {
    const page = await landingHtml(
      ctx.config.zone,
      ctx.caller,
      opensZone(ctx.caller, ctx.config),
      ctx.config.consoleUrl,
    );
    return new Response(page, {
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
  if (path === '/cli/kthx.tgz') return tarball(request, ctx.id);
  return notHere(ctx.host, ctx.config.zone, 404, ctx.id, ctx.port);
}

async function site(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
): Promise<Response | undefined> {
  // Retired on every name in the zone, claimed or not.
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

  const reserved =
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/files' ||
    path.startsWith('/files/');
  // nginx serves every other path; one that reaches here was misrouted.
  if (!reserved) {
    return notHere(ctx.host, ctx.config.zone, 404, ctx.id, ctx.port);
  }

  let marker: Marker | null;
  try {
    marker = await ctx.sites.marker(name);
  } catch (cause) {
    logCause(ctx.id, 'reading the site marker', cause);
    return refuse('BUSY', ctx.id);
  }
  if (marker === null) return refuse('NOT_FOUND', ctx.id);
  return siteApi(request, ctx, name, path, marker);
}

async function siteApi(
  request: Request,
  ctx: Ctx,
  name: string,
  path: string,
  marker: Marker,
): Promise<Response | undefined> {
  const read = READ_METHODS.has(request.method);
  // Cacheable, so it is served before anything that sets a cookie.
  if (path === '/api/sdk.js' && read) {
    return asset(
      SDK_PATH,
      'text/javascript; charset=utf-8',
      'public, max-age=300',
    );
  }

  // Public bytes: a cookie would defeat the edge cache, and any page may fetch
  // them anyway. Rows live in the control database, so no database is needed.
  if (path === '/files' || path.startsWith('/files/')) {
    return serveFile(request, ctx, name, path);
  }

  const owner = await opensSite(ctx, marker);
  // `SameSite=Lax` cannot separate sites: the zone is not on the Public Suffix
  // List. The `/api/ws` GET is guarded too, since a socket is a write channel.
  const guarded = request.method !== 'GET' || path === '/api/ws';
  if (guarded && !owner && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const me = meOf(request, name, ctx.config.meKey, ctx.config.mePreviousKey);
  const address = ctx.caller.bucket;
  const segments = path.split('/');
  // A site gets its database on first use, not when its marker is written.
  const database =
    path === '/api/ws' || path === '/api/mcp' || segments[2] === 'db';
  try {
    await ensureSite(ctx, name, database);
  } catch (cause) {
    logCause(ctx.id, `preparing ${name}`, cause);
    return refuse('BUSY', ctx.id);
  }

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

  if (path === '/api/mcp') {
    // This endpoint opens no stream, so only `POST` carries a message.
    if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    if (!owner) {
      return refuse(
        request.headers.get('authorization') === null
          ? 'UNAUTHENTICATED'
          : 'FORBIDDEN',
        ctx.id,
      );
    }
    // Buckets are spent per tool inside, where reads stay free. No cookie:
    // every caller here holds the owner's ID token.
    return mcpApi(request, ctx, name);
  }

  if (segments[2] === 'db') {
    // A bulk `POST` is one unit; `POST …/query` is a read with a body.
    const metered =
      !READ_METHODS.has(request.method) && segments[4] !== 'query';
    const refusal = charge(ctx, name, me, owner, address, metered);
    if (refusal !== null) return refusal;
    return cookied(await dbApi(request, ctx, name, segments, owner), me);
  }
  if (segments[2] === 'ai') {
    // GETs reach no upstream. Charging them would let a foreign page spend a
    // site's day with a `no-cors` GET, which carries no `Origin` to guard on.
    const refusal = read ? null : charge(ctx, name, me, owner, address, true);
    if (refusal !== null) return refusal;
    // A model can think past the server's 30 s idle timeout mid-stream.
    ctx.server?.timeout(request, AI_IDLE_SECONDS);
    return cookied(await aiApi(request, ctx, name, segments, address), me);
  }
  return refuse('NOT_FOUND', ctx.id);
}

function cookied(response: Response, me: Me): Response {
  if (me.setCookie === null) return response;
  response.headers.append('set-cookie', me.setCookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * The owner skips the visitor and address buckets but never the site one, so a
 * leaked token cannot outrun the site's ceiling.
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
    // A cookieless request skips this bucket: a fresh cookie is no fresh
    // allowance.
    [
      writes.visitor,
      owner || me.setCookie !== null ? null : `${name}:${me.id}`,
    ],
    [writes.address, owner || address === null ? null : `${name}:${address}`],
    [writes.site, name],
  ]);
  return spent ? refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' }) : null;
}

function upgrade(
  request: Request,
  ctx: Ctx,
  name: string,
  me: Me,
): Response | undefined {
  const address = ctx.caller.bucket;
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

export interface Kthx {
  (
    request: Request,
    server?: Bun.Server<unknown>,
  ): Promise<Response | undefined>;
  /** Closes site pools; the control connection belongs to the caller. */
  close(): Promise<void>;
}

export function handler(
  config: Config,
  sql: ReturnType<typeof createClient>,
  depot: Depot,
  sites: Sites,
  pg: Pg = new Pg(config, sql),
): Kthx {
  const engine = config.engine === null ? null : new EngineKeys(config.engine);
  engine?.warm();
  const answer = async (
    request: Request,
    server?: Bun.Server<unknown>,
  ): Promise<Response | undefined> => {
    const id = requestId();
    const host = hostOf(request);
    const caller = callerOf(request, server, config, host);
    // Private hosts are outside the zone and always answer as the apex.
    const name = caller.door === 'public' ? siteOf(host, config.zone) : '';
    // A host outside the zone learns nothing about what is behind it.
    if (name === null) return refuse('NOT_FOUND', id);
    // The tunnel never carries private names, so one arriving through
    // Cloudflare is misrouted.
    if (caller.door !== 'public' && request.headers.has('cf-connecting-ip')) {
      return refuse('NOT_FOUND', id);
    }

    let verified: Promise<string | null> | null = null;
    const identity = (): Promise<string | null> => {
      const token = caller.bearer;
      if (token === null || !looksLikeJwt(token)) return Promise.resolve(null);
      verified ??= verifyIdToken(token, config).catch((cause: unknown) => {
        logCause(id, 'verifying an id token', cause);
        return null;
      });
      return verified;
    };
    const ctx: Ctx = {
      config,
      sql,
      pg,
      depot,
      sites,
      server,
      id,
      host,
      port: portOf(request),
      caller,
      engine,
      identity,
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

const SWEEP_MS = 24 * 60 * 60 * 1000;
/** How soon a site's database and files go after its marker does. */
const SITE_SWEEP_MS = 10 * 60 * 1000;

export async function start(): Promise<Bun.Server<unknown>> {
  const config = readConfig();
  const sql = createClient(config.databaseUrl);
  const ran = await migrate(sql);
  if (ran.length > 0) console.log(`migrated: ${ran.join(', ')}`);

  const pg = new Pg(config, sql);
  // Before serving: every site database is cloned from the template.
  await pg.bootstrap();

  const depot =
    config.bucket === null
      ? diskDepot(join(tmpdir(), 'kthx-depot'))
      : bucketDepot(config.bucket);
  const federation = await loadDeploymentFederation();
  if (federation === null && !Bun.env.STORAGE_EMULATOR_HOST) {
    throw new Error(
      'KTHX_SITES_BUCKET needs GOOGLE_APPLICATION_CREDENTIALS, or STORAGE_EMULATOR_HOST for a local run',
    );
  }
  const sites = new Sites({
    bucketName: config.sitesBucket,
    auth:
      federation === null
        ? { token: () => 'emulator' }
        : federatedAuth(federation),
  });
  const fetch = handler(config, sql, depot, sites, pg);

  const server = Bun.serve({
    port: config.port,
    // Seconds. Uploads, builds and AI calls raise it per request.
    idleTimeout: 30,
    // Bun buffers a body before a handler sees it; its default cap is 128 MiB.
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch,
    websocket,
  });
  console.log(`kthx serving ${config.zone} on :${server.port}`);

  // Not awaited: after a restore or `KTHX_PG_KEY` rotation, a site that is
  // asked for first is repaired on the way in.
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

  const siteSweep = setInterval(() => {
    void sweepSites({ sql, pg, depot, sites, id: 'sweep' })
      .then((erased) => {
        if (erased.length > 0) console.log(`erased: ${erased.join(', ')}`);
      })
      .catch((cause: unknown) => logCause('sweep', 'erasing sites', cause));
  }, SITE_SWEEP_MS);
  siteSweep.unref();
  return server;
}

if (import.meta.main) await start();
