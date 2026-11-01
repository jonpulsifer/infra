/**
 * The control API over the sites bucket: the public directory, a name's
 * standing, an owner's report, and deletes. A site exists while its marker
 * does; `kthx deploy` writes the bucket itself, so nothing here uploads. A
 * site's control row, database and files are made the first time its API is
 * used, and go when the site is deleted or its marker disappears.
 */
import type { SQL } from 'bun';
import { aiUsage, MAX_AI_REQUESTS_DAY, MAX_AI_TOKENS_DAY } from './ai.ts';
import type { Marker } from './bucket.ts';
import type { Caller } from './caller.ts';
import type { Depot } from './depot.ts';
import type { EngineKeys } from './engine.ts';
import type { Config } from './env.ts';
import {
  dropFiles,
  filesBytes,
  MAX_FILE_BYTES,
  MAX_FILES_BYTES,
} from './files.ts';
import { empty, logCause, ok, refuse, sameOrigin, siteUrl } from './http.ts';
import { DIRECTORY_BUCKET, TokenBucket } from './limits.ts';
import type { Sites } from './markers.ts';
import { nameProblem } from './names.ts';
import type { Pg } from './pg.ts';

export { NAME_PATTERN, nameProblem, RESERVED_NAMES } from './names.ts';

/**
 * The advisory lock class an engine reservation takes per name, so two
 * reservations of one name have one winner.
 */
export const NAME_LOCK = 0x6b746878;

export interface Ctx {
  readonly config: Config;
  readonly sql: SQL;
  readonly pg: Pg;
  readonly depot: Depot;
  readonly sites: Sites;
  readonly server: Bun.Server<unknown> | undefined;
  readonly id: string;
  readonly host: string;
  /** The request's port, so a local run answers with a reachable URL. */
  readonly port: string;
  readonly caller: Caller;
  /** `null` when the engine surface is off. */
  readonly engine: EngineKeys | null;
  /** The request's verified Google ID token email, checked at most once. */
  readonly identity: () => Promise<string | null>;
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(seconds) };
}

/**
 * The owner opens a site: a Google ID token whose email the marker names, or,
 * on the identity host, the tailnet login it names.
 */
export async function opensSite(ctx: Ctx, marker: Marker): Promise<boolean> {
  if (marker.owner === '') return false;
  if (ctx.caller.login !== null && ctx.caller.login === marker.owner) {
    return true;
  }
  return (await ctx.identity()) === marker.owner;
}

/** Who the caller is to this server: the tailnet login, else the token's email. */
async function whoami(ctx: Ctx): Promise<string | null> {
  return ctx.caller.login ?? (await ctx.identity());
}

/**
 * Makes the control row a site's API needs, and with `database` its Postgres
 * database, the first time each is asked for.
 */
export async function ensureSite(
  ctx: Pick<Ctx, 'sql' | 'pg' | 'sites'>,
  name: string,
  database: boolean,
): Promise<void> {
  if (ctx.sites.databases.has(name)) return;
  if (!ctx.sites.rows.has(name)) {
    await ctx.sql`insert into sites (name) values (${name}) on conflict do nothing`;
    ctx.sites.rows.add(name);
  }
  if (!database) return;
  const [row] = (await ctx.sql`
    select provisioned_at from sites where name = ${name}
  `) as { provisioned_at: Date | null }[];
  if (row?.provisioned_at === null) await ctx.pg.repair(name);
  ctx.sites.databases.add(name);
}

/** `segments` is the split pathname; `null` for a path this route lacks. */
export async function sitesApi(
  request: Request,
  ctx: Ctx,
  segments: readonly string[],
): Promise<Response | null> {
  if (segments.length === 3) {
    if (request.method === 'GET') return directory(request, ctx);
    if (request.method === 'DELETE') return nuke(request, ctx);
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (segments.length !== 4) return null;

  let name: string;
  try {
    name = decodeURIComponent(segments[3] ?? '');
  } catch {
    return refuse('NOT_FOUND', ctx.id);
  }
  if (nameProblem(name) !== null) return refuse('NOT_FOUND', ctx.id);

  const method = request.method;
  if (method !== 'GET' && method !== 'DELETE') {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  // The proxy's identity header makes a login ambient, so a foreign page could
  // delete here. `GET` is exempt: without CORS headers its answer is unreadable.
  if (method !== 'GET' && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const marker = await ctx.sites.marker(name, true);
  if (marker === null) return refuse('NOT_FOUND', ctx.id);
  const owner = await opensSite(ctx, marker);
  if (method === 'DELETE' && (owner || opensZone(ctx.caller, ctx.config))) {
    await deleteSite(ctx, name);
    return empty(ctx.id);
  }
  if (method === 'GET' && owner) return ok(await report(ctx, marker), ctx.id);
  // A login is ambient on the identity host, not a credential offered.
  return refuse(
    ctx.caller.authorization === null ? 'UNAUTHENTICATED' : 'FORBIDDEN',
    ctx.id,
  );
}

const DIRECTORY_PAGE = 200;
const MAX_DIRECTORY_PAGE = 500;

const directoryReads = new TokenBucket(DIRECTORY_BUCKET);

/** Newest deploy first, then by name, so a cursor is stable. */
function newestFirst(markers: readonly Marker[]): Marker[] {
  return [...markers].sort(
    (a, b) =>
      (b.deployed ?? '').localeCompare(a.deployed ?? '') ||
      a.name.localeCompare(b.name),
  );
}

/** Keyset paging on the sorted list, from the cursor's name. */
function pageOf(
  sorted: readonly Marker[],
  limit: number,
  after: string | null,
): { rows: Marker[]; next: string | null } {
  const from =
    after === null ? 0 : sorted.findIndex((one) => one.name === after) + 1;
  // A cursor that no longer names a site ends the walk.
  if (after !== null && from === 0) return { rows: [], next: null };
  const rows = sorted.slice(from, from + limit);
  const next =
    from + limit < sorted.length ? (rows.at(-1)?.name ?? null) : null;
  return { rows, next };
}

function limitOf(raw: string | null, fallback: number, most: number): number {
  // An empty `?limit=` means the default, not zero.
  const asked = raw ? Number(raw) : fallback;
  return Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), most)
    : fallback;
}

/**
 * The public directory; any site already answers on `<name>.<zone>`. An owner
 * is an email address, so it is shown only to that owner.
 */
async function directory(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const owner = query.get('owner');
  if (owner !== null && owner !== 'me') return refuse('INVALID_QUERY', ctx.id);
  const after = query.get('after');
  if (after !== null && nameProblem(after) === 'INVALID_NAME') {
    return refuse('INVALID_QUERY', ctx.id);
  }
  const limit = limitOf(query.get('limit'), DIRECTORY_PAGE, MAX_DIRECTORY_PAGE);
  if (directoryReads.spend(ctx.caller.bucket)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  const me = await whoami(ctx);
  if (owner === 'me' && me === null) return refuse('UNAUTHENTICATED', ctx.id);

  const markers = await ctx.sites.all();
  const chosen =
    owner === 'me' ? markers.filter((one) => one.owner === me) : markers;
  const page = pageOf(newestFirst(chosen), limit, after);
  return ok(
    {
      items: page.rows.map((one) => ({
        name: one.name,
        url: siteUrl(ctx.config.zone, one.name, ctx.port),
        owner: me !== null && one.owner === me ? me : null,
        deployed: one.deployed,
      })),
      next: page.next,
    },
    ctx.id,
  );
}

/** A site as the engine reads it. */
export interface EngineSite {
  readonly name: string;
  readonly owner: string;
  readonly deployed: string | null;
  readonly provisioned: boolean;
}

async function provisioned(ctx: Ctx, names: readonly string[]) {
  if (names.length === 0) return new Set<string>();
  const rows = (await ctx.sql`
    select name from sites
    where provisioned_at is not null
      and name = any(${ctx.sql.array([...names], 'TEXT')})
  `) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/** The directory's walk over every site, with the columns it leaves out. */
export async function listSitesForEngine(
  ctx: Ctx,
  limit: number,
  after: string | null,
): Promise<{
  total: number;
  rows: readonly EngineSite[];
  next: string | null;
}> {
  const markers = await ctx.sites.all();
  const page = pageOf(newestFirst(markers), limit, after);
  const ready = await provisioned(
    ctx,
    page.rows.map((one) => one.name),
  );
  return {
    total: markers.length,
    rows: page.rows.map((one) => ({
      name: one.name,
      owner: one.owner,
      deployed: one.deployed,
      provisioned: ready.has(one.name),
    })),
    next: page.next,
  };
}

/** One site for the engine, without asking who opens it. */
export async function siteForEngine(
  ctx: Ctx,
  name: string,
): Promise<{ site: EngineSite; marker: Marker } | undefined> {
  const marker = await ctx.sites.marker(name);
  if (marker === null) return undefined;
  const ready = await provisioned(ctx, [name]);
  return {
    marker,
    site: {
      name,
      owner: marker.owner,
      deployed: marker.deployed,
      provisioned: ready.has(name),
    },
  };
}

export interface Standing {
  readonly available: boolean;
  readonly why: 'INVALID_NAME' | 'RESERVED' | 'TAKEN' | null;
  /** `live` when the caller owns the site; `null` otherwise. */
  readonly yours: 'live' | null;
}

/**
 * A fast answer, never a promise: a claim is the marker write itself, which
 * settles races.
 */
export async function nameStanding(ctx: Ctx, name: string): Promise<Standing> {
  const why = nameProblem(name);
  if (why !== null) return { available: false, why, yours: null };
  const marker = await ctx.sites.marker(name);
  if (marker !== null) {
    const mine = await opensSite(ctx, marker);
    return { available: false, why: 'TAKEN', yours: mine ? 'live' : null };
  }
  const [held] = (await ctx.sql`
    select 1 as held from reservations where name = ${name} limit 1
  `) as { held: number }[];
  return held === undefined
    ? { available: true, why: null, yours: null }
    : { available: false, why: 'TAKEN', yours: null };
}

export async function nameStatus(ctx: Ctx, segment: string): Promise<Response> {
  if (directoryReads.spend(ctx.caller.bucket)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  let name: string;
  try {
    name = decodeURIComponent(segment).trim().toLowerCase();
  } catch {
    return refuse('NOT_FOUND', ctx.id);
  }
  return ok({ name, ...(await nameStanding(ctx, name)) }, ctx.id);
}

/**
 * Shared by the nuke route and the page, so the page never offers a button the
 * route refuses. Only the identity host sets a login.
 */
export function opensZone(caller: Caller, config: Config): boolean {
  return (
    config.adminLogins.length > 0 &&
    caller.login !== null &&
    config.adminLogins.includes(caller.login)
  );
}

/**
 * Deletes every site: each folder in the bucket, then every control row and
 * database. Names reserved for built apps stay. Without `KTHX_ADMIN_LOGINS`
 * the route is a hidden 404.
 */
async function nuke(request: Request, ctx: Ctx): Promise<Response> {
  if (ctx.config.adminLogins.length === 0) return refuse('NOT_FOUND', ctx.id);
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  const login = ctx.caller.login;
  if (!opensZone(ctx.caller, ctx.config)) {
    // No rate limit: a vouched login is a person the log can name.
    logCause(
      ctx.id,
      'the nuke',
      new Error(`${login ?? 'nobody'} does not open the zone`),
    );
    return refuse(login === null ? 'UNAUTHENTICATED' : 'FORBIDDEN', ctx.id);
  }

  const markers = await ctx.sites.all(true);
  const rows = (await ctx.sql`select name from sites`) as { name: string }[];
  const names = [
    ...new Set([...markers.map((one) => one.name), ...rows.map((r) => r.name)]),
  ].sort();
  let deleted = 0;
  let failed = 0;
  // ponytail: one site at a time. Batch it before a nuke must clear thousands:
  // the edge gives a request 100 s.
  for (const name of names) {
    try {
      await deleteSite(ctx, name);
      deleted += 1;
    } catch (cause) {
      logCause(ctx.id, `nuking ${name}`, cause);
      failed += 1;
    }
  }
  return ok({ deleted, failed }, ctx.id);
}

/** The folder, marker last, then everything this server keeps beside it. */
export async function deleteSite(ctx: Ctx, name: string): Promise<void> {
  await ctx.sites.remove(name);
  await erase(ctx, name);
}

/**
 * The row delete cascades to `files` and `ai_usage`, and precedes the drop so
 * `Pg.sweep` cleans up after any later failure.
 */
export async function erase(
  ctx: Pick<Ctx, 'sql' | 'pg' | 'depot' | 'sites' | 'id'>,
  name: string,
): Promise<void> {
  // Before the row delete cascades away the rows naming its objects.
  await dropFiles(ctx, name);
  await ctx.sql`delete from sites where name = ${name}`;
  ctx.sites.dropped(name);
  await ctx.pg.drop(name);
}

/**
 * Erases what this server keeps for a site whose marker is gone, such as after
 * `kthx rm`. A row is only erased once a sweep has seen its marker, so rows
 * that predate the bucket survive until their site is moved into it. Only a
 * complete listing counts: a failed one throws and erases nothing.
 */
export async function sweepSites(
  ctx: Pick<Ctx, 'sql' | 'pg' | 'depot' | 'sites' | 'id'>,
): Promise<string[]> {
  const live = new Set((await ctx.sites.all(true)).map((one) => one.name));
  const rows = (await ctx.sql`
    select name, marker_seen_at from sites
  `) as { name: string; marker_seen_at: Date | null }[];
  const seen = rows
    .filter((row) => live.has(row.name) && row.marker_seen_at === null)
    .map((row) => row.name);
  if (seen.length > 0) {
    await ctx.sql`
      update sites set marker_seen_at = now()
      where name = any(${ctx.sql.array(seen, 'TEXT')})
    `;
  }
  const gone = rows
    .filter((row) => !live.has(row.name) && row.marker_seen_at !== null)
    .map((row) => row.name);
  const erased: string[] = [];
  for (const name of gone) {
    try {
      await erase(ctx, name);
      erased.push(name);
    } catch (cause) {
      logCause(ctx.id, `sweeping ${name}`, cause);
    }
  }
  return erased;
}

/** Reported so a client need not hard-code them. */
const QUOTAS = {
  doc_bytes: 1024 * 1024,
  db_bytes: 256 * 1024 * 1024,
  file_bytes: MAX_FILE_BYTES,
  files_bytes: MAX_FILES_BYTES,
  ai_requests_day: MAX_AI_REQUESTS_DAY,
  ai_tokens_day: MAX_AI_TOKENS_DAY,
} as const;

/** A site's owner, last deploy, usage and quotas, for its owner and the engine. */
export async function report(
  ctx: Ctx,
  marker: Marker,
): Promise<Record<string, unknown>> {
  const spent = await aiUsage(ctx, marker.name);
  return {
    name: marker.name,
    url: siteUrl(ctx.config.zone, marker.name, ctx.port),
    owner: marker.owner,
    deployed: marker.deployed,
    usage: {
      db_bytes: await ctx.pg.bytes(marker.name),
      files_bytes: await filesBytes(ctx.sql, marker.name),
      ai_requests_today: spent.requests,
      ai_tokens_today: spent.tokens,
    },
    quotas: QUOTAS,
  };
}
