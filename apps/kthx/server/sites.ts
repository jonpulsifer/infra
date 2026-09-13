/**
 * The control API: claim a name, upload a release, choose which one serves.
 *
 * Answered on the apex — or, where `KTHX_CONTROL_HOST` or `KTHX_IDENTITY_HOST`
 * name a private host, there alone. Ownership is two credentials and a row may
 * carry either: the bearer minted at claim and shown once, of which the row
 * keeps only a SHA-256, and the tailnet login the identity door vouched for.
 * There is still no session and no reset — a visitor who lost the token has
 * lost the site unless its row also names a login, which is the deal the
 * landing page states.
 *
 * The upload boundary is `@repo/archive`: `normalizeArchive` turns a ZIP into
 * the gzipped tar everything downstream opens, the depot stores it under its
 * own digest, and the bundle is read once so an archive with no entry page is
 * refused before it is stored. What this file adds is the *order*: bytes land
 * in the depot, then on the volume, and only then does a row say a site serves
 * them.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { base64urlEncode } from '@repo/archive/bytes';
import type { SQL } from 'bun';
import { aiUsage, MAX_AI_REQUESTS_DAY, MAX_AI_TOKENS_DAY } from './ai.ts';
import type { Caller } from './caller.ts';
import type { ReleaseRow, SiteRow } from './db.ts';
import type { Depot } from './depot.ts';
import { isPlainObject } from './documents.ts';
import type { Config } from './env.ts';
import {
  dropFiles,
  filesBytes,
  MAX_FILE_BYTES,
  MAX_FILES_BYTES,
} from './files.ts';
import {
  bodyWithin,
  type Code,
  empty,
  isJson,
  logCause,
  ok,
  refuse,
  sameOrigin,
  siteUrl,
  timingSafeEquals,
} from './http.ts';
import {
  CLAIM_BUCKET,
  DailyCap,
  DIRECTORY_BUCKET,
  secondsToMidnight,
  TokenBucket,
} from './limits.ts';
import { nameProblem } from './names.ts';
import type { Pg } from './pg.ts';
import {
  KEEP_RELEASES,
  MAX_ARCHIVE_BYTES,
  placeTree,
  pruneSite,
  readRelease,
  releaseDir,
  siteDir,
  slotsFull,
  takeSlot,
  UploadRefused,
  writeTree,
} from './releases.ts';

export { NAME_PATTERN, nameProblem, RESERVED_NAMES } from './names.ts';

/** How many live sites this process carries before it stops taking names. */
export const MAX_LIVE_SITES = 5000;
/** Claims per address /64 per UTC day. */
export const MAX_CLAIMS_PER_DAY = 20;
/** Uploads per site per UTC day. */
export const MAX_UPLOADS_PER_DAY = 60;
/** How long a release body may take to arrive. */
export const BODY_TIMEOUT_MS = 120_000;
/** Far more than any legal `{name}` body, and far less than the server's cap. */
const MAX_CLAIM_BYTES = 64 * 1024;

const claims = new TokenBucket(CLAIM_BUCKET);
const claimsPerDay = new DailyCap(MAX_CLAIMS_PER_DAY);
const uploadsPerDay = new DailyCap(MAX_UPLOADS_PER_DAY);

/** Everything a handler is given: the deployment, the stores, this request. */
export interface Ctx {
  readonly config: Config;
  readonly sql: SQL;
  /** The site databases: provisioning, pools, quotas. */
  readonly pg: Pg;
  readonly depot: Depot;
  readonly server: Bun.Server<unknown> | undefined;
  readonly id: string;
  readonly host: string;
  /** The port the request named, so a local run answers with a reachable URL. */
  readonly port: string;
  /** Which door this arrived through, who it is, and what keys its buckets. */
  readonly caller: Caller;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(seconds) };
}

/** The two columns that decide who opens a site. */
export interface Owned {
  readonly token_hash: string | null;
  readonly owner_login: string | null;
}

/**
 * Whether this caller opens this site.
 *
 * Two credentials, both permanent: the bearer minted at claim, and the tailnet
 * login the identity door vouched for. Neither supersedes the other — a tagged
 * node gets no identity header at all, so identity-only ownership would lock
 * every agent out of its own sites on the day it shipped.
 *
 * Reach is not one of them. Everyone on the tailnet can dial the identity host,
 * so arriving there says which door was used and nothing about who came
 * through it.
 *
 * A null `token_hash` opens nothing, and is checked before the compare rather
 * than inside it: the live column is nullable, and `timingSafeEquals` against
 * a null is a throw in the middle of a request that should have been a 403.
 *
 * On a site host a bearer that is not this site's is *ignored* rather than
 * refused — the OpenAI SDK puts one on every call to `/api/ai` — so this
 * answers a question, not a challenge.
 */
export function opensSite(caller: Caller, site: Owned): boolean {
  if (
    site.token_hash !== null &&
    caller.bearer !== null &&
    timingSafeEquals(hash(caller.bearer), site.token_hash)
  ) {
    return true;
  }
  return site.owner_login !== null && site.owner_login === caller.login;
}

/**
 * Dispatch under `/api/sites`, or `null` when the path is not one of ours.
 *
 * `segments` is the split pathname, so `/api/sites/notes/releases` arrives as
 * `['', 'api', 'sites', 'notes', 'releases']`.
 */
export async function sitesApi(
  request: Request,
  ctx: Ctx,
  segments: readonly string[],
): Promise<Response | null> {
  if (segments.length === 3) {
    if (request.method === 'GET') return directory(request, ctx);
    if (request.method === 'DELETE') return nuke(request, ctx);
    if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return claim(request, ctx);
  }
  if (segments.length > 5) return null;

  let name: string;
  try {
    name = decodeURIComponent(segments[3] ?? '');
  } catch {
    return refuse('NOT_FOUND', ctx.id);
  }

  const tail = segments[4] ?? '';
  const method = request.method;
  const act =
    tail === '' && method === 'GET'
      ? inspect
      : tail === '' && method === 'DELETE'
        ? remove
        : tail === 'releases' && method === 'POST'
          ? release
          : tail === 'serve' && method === 'POST'
            ? chooseRelease
            : tail === 'hold' && method === 'DELETE'
              ? unhold
              : null;
  if (act === null) {
    // A path we do not have is 404; one we have with the wrong verb is 405.
    return ['', 'releases', 'serve', 'hold'].includes(tail)
      ? refuse('METHOD_NOT_ALLOWED', ctx.id)
      : refuse('NOT_FOUND', ctx.id);
  }

  // Every owner-scoped write under `:name`, in one place. An identity header is
  // set by the proxy on whatever reaches it, so the credential is ambient the
  // moment a browser is on that host: without this a foreign page publishes a
  // release to somebody else's site with nothing but their address bar. `GET`
  // is left alone — this server sends no CORS header, so a cross-origin read
  // cannot be read.
  if (method !== 'GET' && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const site = await siteFor(name, ctx);
  if ('code' in site) return refuse(site.code, ctx.id);
  return act(request, ctx, site.row);
}

/**
 * The row this name names, once its bearer is the one presented.
 *
 * A deleted name is 410 before the bearer is even read — the site is gone for
 * its owner too. A name with no row is 404 whether or not a token came with it,
 * which is what makes an unauthenticated `GET` the landing page's taken-probe:
 * 401 means claimed, 404 means free.
 */
async function siteFor(
  name: string,
  ctx: Ctx,
): Promise<{ row: SiteRow } | { code: Code }> {
  const [row] = (await ctx.sql`
    select name, token_hash, owner_login, serving, held, deleted_at
    from sites where name = ${name} limit 1
  `) as SiteRow[];
  if (row === undefined) return { code: 'NOT_FOUND' };
  if (row.deleted_at !== null) return { code: 'GONE' };

  if (opensSite(ctx.caller, row)) return { row };
  // An unauthenticated read is still 401, which is what makes it the landing
  // page's taken-probe. A verified login is not a credential *offered* for this
  // site, so it does not turn that 401 into a 403 and break the probe on the
  // identity host.
  if (ctx.caller.authorization === null) return { code: 'UNAUTHENTICATED' };
  return { code: 'FORBIDDEN' };
}

type Act = (request: Request, ctx: Ctx, site: SiteRow) => Promise<Response>;

// --- the directory ----------------------------------------------------------

/** How many sites a page of the directory holds, and what it may be asked for. */
const DIRECTORY_PAGE = 200;
const MAX_DIRECTORY_PAGE = 500;

/** One site as the directory shows it: no token hash, no usage, no hold. */
interface Listed {
  readonly name: string;
  readonly owner_login: string | null;
  readonly serving: number | null;
  readonly releases: number;
  readonly at: Date;
}

interface Page {
  readonly rows: readonly Listed[];
  readonly next: string | null;
}

/** How fast one address may ask for a page. */
const directoryReads = new TokenBucket(DIRECTORY_BUCKET);

/**
 * Every live site, newest claim first — the public directory.
 *
 * Public by construction: a name answers on `<name>.<zone>` to anyone who
 * dials it, so listing the names gives away nothing a walk of the zone would
 * not. What stays behind the bearer is everything about *owning* a site: the
 * token hash, the usage, the hold, the release digests — and who owns it. A
 * row's `owner` is its login only when it is the caller's own, because an
 * owner is an email address and the directory is read by anyone.
 *
 * `?owner=me` is the same page filtered to the caller's own sites — "your
 * websites", which is the only list a person landing on the identity host
 * wants. Any other `?owner=` is refused rather than answered: listing by
 * somebody else's address is the leak this route must not have.
 *
 * One statement, whatever the page: the cursor names the last site of the
 * previous one and the query finds its place itself, so a caller paging to the
 * end costs one indexed lookup a page rather than a growing `offset`.
 *
 * Nothing is kept and nothing is cached — `no-store`, one query per request.
 * A directory that is a few seconds behind is a demo where the site somebody
 * just claimed is not on the page, and a live zone is at most a few thousand
 * indexed rows. What bounds it is {@link directoryReads}, now on every request
 * rather than only the ones a cache could not answer.
 */
async function directory(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const owner = query.get('owner');
  if (owner !== null && owner !== 'me') return refuse('INVALID_QUERY', ctx.id);
  if (owner === 'me' && ctx.caller.login === null) {
    return refuse('UNAUTHENTICATED', ctx.id);
  }
  const after = query.get('after');
  // A reserved name is a name: it matches no row, so it ends the walk rather
  // than being refused. Only a string that is not a name at all is a bad query.
  if (after !== null && nameProblem(after) === 'INVALID_NAME') {
    return refuse('INVALID_QUERY', ctx.id);
  }
  // `?limit=` is the parameter left empty, which is the default, not zero.
  const raw = query.get('limit');
  const asked = raw ? Number(raw) : DIRECTORY_PAGE;
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_DIRECTORY_PAGE)
    : DIRECTORY_PAGE;

  if (directoryReads.spend(ctx.caller.bucket)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  const login = ctx.caller.login;
  const page = await listSites(
    ctx,
    limit,
    after,
    owner === 'me' ? login : null,
  );

  return ok(
    {
      items: page.rows.map((row) => ({
        name: row.name,
        url: siteUrl(ctx.config.zone, row.name, ctx.port),
        owner: row.owner_login === login ? login : null,
        serving: row.serving,
        releases: row.releases,
        at: row.at.toISOString(),
      })),
      next: page.next,
    },
    ctx.id,
  );
}

/**
 * One page of live sites, and the cursor for the page after it.
 *
 * The keyset is `(at, name)` under the order the list is in, resolved from the
 * cursor's own name inside the same statement. A cursor naming a site that
 * never existed matches nothing and ends the walk; one naming a *deleted* site
 * still pages correctly, because that row keeps its claim time and only drops
 * out of the list itself.
 */
async function listSites(
  ctx: Ctx,
  limit: number,
  after: string | null,
  mine: string | null,
): Promise<Page> {
  const rows = (await ctx.sql`
    with mark as (
      select created_at, name from sites where name = ${after}
    )
    select s.name, s.owner_login, s.serving, s.created_at as at,
           (select count(*)::int from releases r where r.site = s.name)
             as releases
    from sites s
    where s.deleted_at is null
      and (${mine}::text is null or s.owner_login = ${mine})
      and (${after}::text is null or exists (
        select 1 from mark m
        where s.created_at < m.created_at
           or (s.created_at = m.created_at and s.name > m.name)
      ))
    order by s.created_at desc, s.name asc
    limit ${limit + 1}
  `) as Listed[];
  const kept = rows.slice(0, limit);
  return {
    rows: kept,
    next: rows.length > limit ? (kept.at(-1)?.name ?? null) : null,
  };
}

// --- the name probe ---------------------------------------------------------

/**
 * Whether a name can be claimed.
 *
 * This is the question the landing page used to ask by reading a 401 off
 * `GET /api/sites/:name` — a probe that only worked because an owner route
 * answers differently to a name that exists, and that says "taken" to anyone
 * who is simply not its owner. Asked plainly it is one indexed row.
 *
 * **No `deleted_at` filter.** A deleted name is taken forever: its row is what
 * makes the site host answer 410 rather than handing the name to the next
 * claimer, and a probe that called it free would offer a name the claim then
 * refuses.
 *
 * A fast no, never a promise of a yes: a claim also refuses a name already in
 * `pg_database` or `pg_roles`, and two callers racing for the last free name
 * still both see `available`. Those two catalogue lookups stay off a public
 * unauthenticated route; the claim is the authority.
 */
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
  const why = nameProblem(name);
  if (why !== null) return ok({ name, available: false, why }, ctx.id);
  const [row] = (await ctx.sql`
    select name from sites where name = ${name} limit 1
  `) as { name: string }[];
  const taken = row !== undefined;
  return ok({ name, available: !taken, why: taken ? 'TAKEN' : null }, ctx.id);
}

// --- the nuke ---------------------------------------------------------------

/**
 * Whether this caller opens the whole zone.
 *
 * One predicate for two readers — the route, and the page that decides whether
 * to show a control at all — because a page that offers a button the route
 * refuses is worse than no button. A login is only ever set on the identity
 * host, so naming a door here would be saying the same thing twice.
 */
export function opensZone(caller: Caller, config: Config): boolean {
  return (
    config.adminLogins.length > 0 &&
    caller.login !== null &&
    config.adminLogins.includes(caller.login)
  );
}

/**
 * Every site gone — the clean slate a demo starts from.
 *
 * A hard delete, not the soft one `DELETE /api/sites/:name` does: the rows go
 * too, so the names come free again. Release archives stay in the depot. They
 * are keyed by content digest and may be shared between sites, and after a
 * hard delete no row references them — nothing collects them.
 *
 * Opened by a name in `KTHX_ADMIN_LOGINS` and nothing else, which means the
 * identity host and nothing else: a login is only ever vouched for there, by a
 * proxy this server trusts. With the list empty — the default — this answers
 * 404, the same as a path this server does not have, so a deployment without
 * an operator does not advertise that a nuke exists.
 *
 * There is no rate limit and it needs none. A key could be mistyped in front
 * of an audience, guessed at wire speed, or left in a tab's `sessionStorage`;
 * an address that a tailnet vouched for is none of those, and the caller who
 * fails this check is a real person the log can name.
 */
async function nuke(request: Request, ctx: Ctx): Promise<Response> {
  if (ctx.config.adminLogins.length === 0) return refuse('NOT_FOUND', ctx.id);
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  const login = ctx.caller.login;
  if (!opensZone(ctx.caller, ctx.config)) {
    // Named in the log, because unlike a mistyped key this identifies a person
    // and the only interesting case is the one nobody expected.
    logCause(
      ctx.id,
      'the nuke',
      new Error(`${login ?? 'nobody'} does not open the zone`),
    );
    return refuse(login === null ? 'UNAUTHENTICATED' : 'FORBIDDEN', ctx.id);
  }

  // Deleted rows as well: taking those is what frees their names.
  const rows = (await ctx.sql`select name from sites order by name`) as {
    name: string;
  }[];
  let deleted = 0;
  let failed = 0;
  // ponytail: serial, one `DROP DATABASE` at a time. Tens of sites is a couple
  // of seconds and the zone has never held more; batch it the day a nuke has to
  // clear thousands, because the edge gives a request 100 s.
  for (const { name } of rows) {
    try {
      await erase(ctx, name);
      deleted += 1;
    } catch (cause) {
      // One database refusing to drop is not the other forty sites' problem.
      logCause(ctx.id, `nuking ${name}`, cause);
      failed += 1;
    }
  }
  return ok({ deleted, failed }, ctx.id);
}

/**
 * One site, hard: its files, its rows, its database, its role, its bytes.
 *
 * The row delete is one statement, so `releases`, `files` and `ai_usage` go
 * with it through their foreign keys — a site is never left half-listed. It
 * also runs *before* the database is dropped, which is what makes everything
 * after it recoverable: `Pg.sweep` drops any database or role whose site row
 * is gone, so a failure past that line costs disk until the nightly run rather
 * than leaving a name nobody can claim.
 */
async function erase(ctx: Ctx, name: string): Promise<void> {
  // First, while the rows that name its objects are still there to read.
  await dropFiles(ctx, name);
  await ctx.sql`delete from sites where name = ${name}`;
  await ctx.pg.drop(name);
  await rm(siteDir(ctx.config.sitesDir, name), {
    recursive: true,
    force: true,
  });
}

// --- claim ------------------------------------------------------------------

async function claim(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  // A claim is `{"name":"notes"}`. Anything near this size is not one, and
  // this route is anonymous, so it is refused before a byte is buffered.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_CLAIM_BYTES) {
    return refuse('TOO_LARGE', ctx.id);
  }

  const address = ctx.caller.bucket;
  if (claims.spend(address)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  if (address !== null && claimsPerDay.full(address)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(secondsToMidnight()));
  }

  const body = await jsonBody(request);
  const name =
    typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  const problem = nameProblem(name);
  if (problem !== null) return refuse(problem, ctx.id);

  const [live] = (await ctx.sql`
    select count(*)::int as live from sites where deleted_at is null
  `) as { live: number }[];
  if ((live?.live ?? 0) >= MAX_LIVE_SITES) return refuse('BUSY', ctx.id);

  // A name that is already a database or a role is taken even with no row: it
  // is the residue of a claim that failed after `CREATE DATABASE`, and handing
  // it out again would hand its documents to someone else.
  if (await ctx.pg.inUse(name)) return refuse('TAKEN', ctx.id);

  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  // A deleted name stays taken: the row is what makes it answer 410. A bearer
  // is minted whatever the door, so a site claimed by a person on the tailnet
  // carries both credentials — the login is only ever presented from a browser
  // on one host, and the CLI, an agent and a phone off the tailnet all still
  // need something to carry.
  const claimed = (await ctx.sql`
    insert into sites (name, token_hash, owner_login)
    values (${name}, ${hash(token)}, ${ctx.caller.login})
    on conflict do nothing returning name
  `) as { name: string }[];
  if (claimed.length === 0) return refuse('TAKEN', ctx.id);

  // The row holds the name while this runs. A failure takes the row with it,
  // so the caller is told the name is *not* taken — which the check above then
  // keeps honest about whatever was left behind.
  try {
    await ctx.pg.provision(name);
  } catch (cause) {
    logCause(ctx.id, `provisioning ${name}`, cause);
    await ctx.sql`delete from sites where name = ${name}`.catch(
      (second: unknown) =>
        logCause(ctx.id, 'unclaiming after a failure', second),
    );
    return refuse('STORAGE_FAILURE', ctx.id);
  }

  if (address !== null) claimsPerDay.count(address);
  return ok(
    { name, url: siteUrl(ctx.config.zone, name, ctx.port), token },
    ctx.id,
    201,
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return isPlainObject(body) ? body : {};
}

// --- inspect ----------------------------------------------------------------

/** The ceilings the contract fixes, reported so a client need not hard-code them. */
const QUOTAS = {
  doc_bytes: 1024 * 1024,
  db_bytes: 256 * 1024 * 1024,
  file_bytes: MAX_FILE_BYTES,
  files_bytes: MAX_FILES_BYTES,
  ai_requests_day: MAX_AI_REQUESTS_DAY,
  ai_tokens_day: MAX_AI_TOKENS_DAY,
} as const;

const inspect: Act = async (_request, ctx, site) => {
  const rows = (await ctx.sql`
    select n, digest, size, at from releases
    where site = ${site.name} order by n desc
  `) as ReleaseRow[];
  const spent = await aiUsage(ctx, site.name);
  return ok(
    {
      name: site.name,
      url: siteUrl(ctx.config.zone, site.name, ctx.port),
      owner: site.owner_login,
      serving: site.serving,
      held: site.held,
      releases: rows.map((row) => ({
        n: row.n,
        digest: row.digest,
        size: Number(row.size),
        at: row.at.toISOString(),
      })),
      // The database reports its own size, the file rows carry theirs, and
      // the AI budget is here already.
      usage: {
        db_bytes: await ctx.pg.bytes(site.name),
        files_bytes: await filesBytes(ctx.sql, site.name),
        ai_requests_today: spent.requests,
        ai_tokens_today: spent.tokens,
      },
      quotas: QUOTAS,
    },
    ctx.id,
  );
};

// --- release ----------------------------------------------------------------

const release: Act = async (request, ctx, site) => {
  // Ahead of the rate limit, because a refusal this caller did not cause must
  // not spend its allowance: a client that obeys "come back in a moment" would
  // otherwise burn its burst on a neighbour's uploads and land on 429. Not 429
  // itself either — the process is full, which clears on its own. A probe and
  // not a slot: the slot is taken in `stage`, once the body is in hand.
  if (slotsFull()) return refuse('BUSY', ctx.id);
  if (claims.spend(ctx.caller.bucket)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  if (uploadsPerDay.full(site.name)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(secondsToMidnight()));
  }
  const answer = await stage(request, ctx, site);
  // The day is charged for a release that happened, not for an archive this
  // boundary refused: sixty builds with no `index.html` must not lock a site
  // out until UTC midnight.
  if (answer.status === 201) uploadsPerDay.count(site.name);
  return answer;
};

/** The number a release took, and what the site serves once it has it. */
interface Numbered {
  readonly n: number;
  readonly serving: number | null;
}

async function stage(
  request: Request,
  ctx: Ctx,
  site: SiteRow,
): Promise<Response> {
  // Bun's connection idle timeout is 10 s, which no real upload fits inside.
  ctx.server?.timeout(request, BODY_TIMEOUT_MS / 1000 + 10);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) return refuse('TOO_LARGE', ctx.id);

  let bytes: Uint8Array | null;
  try {
    bytes = await bodyWithin(request, BODY_TIMEOUT_MS, MAX_ARCHIVE_BYTES);
  } catch (cause) {
    logCause(ctx.id, 'reading the upload', cause);
    return refuse('TIMEOUT', ctx.id);
  }
  if (bytes === null) return refuse('TOO_LARGE', ctx.id);

  // Only now: a slot is a share of the process's memory and its disk, and a
  // caller that trickles a body for two minutes must not hold one of the two
  // while sending nothing.
  const slot = takeSlot();
  if (slot === null) return refuse('BUSY', ctx.id);
  try {
    return await unpack(ctx, site, bytes, request.headers.get('x-filename'));
  } finally {
    slot();
  }
}

/** The archive in hand, from bytes to a numbered directory this site serves. */
async function unpack(
  ctx: Ctx,
  site: SiteRow,
  bytes: Uint8Array,
  filename: string | null,
): Promise<Response> {
  let read: ReturnType<typeof readRelease>;
  try {
    // The filename is a caller's assertion used only to name the container in a
    // log line; it is never echoed and never becomes a path.
    read = readRelease(filename?.trim() || 'site.zip', bytes);
  } catch (cause) {
    if (cause instanceof UploadRefused) {
      logCause(ctx.id, 'reading the archive', cause.why);
      return refuse(cause.code, ctx.id);
    }
    throw cause;
  }

  let location: string;
  try {
    location = await ctx.depot.put(
      `releases/${read.digest}.tar.gz`,
      read.archive.bytes,
    );
  } catch (cause) {
    logCause(ctx.id, 'storing the release', cause);
    return refuse('STORAGE_FAILURE', ctx.id);
  }

  const size = read.archive.bytes.byteLength;
  let numbered: Numbered;
  try {
    numbered = await writeTree(
      ctx.config.sitesDir,
      site.name,
      read.files,
      async (temp): Promise<Numbered> => {
        // One site's uploads are numbered under its own lock, so two arriving
        // at once take two numbers rather than one losing the primary key.
        return await ctx.sql.begin(async (tx: SQL) => {
          const [locked] = (await tx`
            select held, serving from sites where name = ${site.name} for update
          `) as { held: boolean; serving: number | null }[];
          const [top] = (await tx`
            select max(n) as n from releases where site = ${site.name}
          `) as { n: number | null }[];
          const n = Number(top?.n ?? 0) + 1;
          await tx`
            insert into releases (site, n, digest, size, location)
            values (${site.name}, ${n}, ${read.digest}, ${size}, ${location})
          `;
          // A hold is the owner saying "not yet": an upload onto a held site is
          // stored and numbered and does not serve until the hold is released.
          // That is the whole point of rolling back — a deploy that fires while
          // you are looking at what broke must not put it back.
          const serving = locked?.held ? locked.serving : n;
          if (!locked?.held) {
            await tx`update sites set serving = ${n} where name = ${site.name}`;
          }
          // Inside the transaction, so a rename that cannot happen rolls the
          // row back: a site must never say it serves a release whose directory
          // never landed. `writeTree` sweeps the temp tree either way.
          await placeTree(temp, releaseDir(ctx.config.sitesDir, site.name, n));
          return { n, serving };
        });
      },
    );
  } catch (cause) {
    logCause(ctx.id, 'unpacking the release', cause);
    return refuse('STORAGE_FAILURE', ctx.id);
  }

  await prune(ctx, site.name, numbered.serving);
  return ok(
    {
      n: numbered.n,
      serving: numbered.serving,
      digest: read.digest,
      url: siteUrl(ctx.config.zone, site.name, ctx.port),
    },
    ctx.id,
    201,
  );
}

/**
 * Drop the rows past {@link KEEP_RELEASES} and the directories nothing needs.
 *
 * The row a site serves is never one of them: a rollback that lands while this
 * upload commits would otherwise lose what names the release the site answers
 * with, so it keeps {@link KEEP_RELEASES} plus whatever the site row says it is
 * serving by the time the delete runs.
 *
 * The serving release and the one before it are what stays on disk; everything
 * else is a rehydrate away, and only goes when the volume is under pressure.
 */
async function prune(
  ctx: Ctx,
  name: string,
  serving: number | null,
): Promise<void> {
  try {
    await ctx.sql`
      delete from releases where site = ${name}
      and n is distinct from (select serving from sites where name = ${name})
      and n not in (
        select n from releases where site = ${name}
        order by n desc limit ${KEEP_RELEASES}
      )
    `;
    const rows = (await ctx.sql`
      select n from releases where site = ${name} order by n desc
    `) as { n: number }[];
    const known = new Set(rows.map((row) => row.n));
    const previous = rows.find((row) => serving !== null && row.n < serving)?.n;
    const guaranteed = new Set(
      [serving, previous].filter(
        (n): n is number => n !== null && n !== undefined,
      ),
    );
    await pruneSite(ctx.config.sitesDir, name, known, guaranteed);
  } catch (cause) {
    // A prune that fails costs disk, never correctness: the release is already
    // stored, numbered and serving.
    logCause(ctx.id, 'pruning releases', cause);
  }
}

// --- serve, hold, delete ----------------------------------------------------

/**
 * Roll back — or forward — to a numbered release.
 *
 * The latch says where `serving` sits, not that this route was called. Holding
 * is what an older release means: uploads keep arriving and keep being stored,
 * and none of them serves until the hold is released, so a deploy that fires
 * while somebody is looking at what broke cannot put it back. Choosing the
 * newest release is the ordinary state and holds nothing — setting the latch
 * there too would make the first rollback of a site's life permanent, with
 * every later release stored and invisible.
 */
const chooseRelease: Act = async (request, ctx, site) => {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await jsonBody(request);
  const n = Number(body.n);
  if (!Number.isInteger(n) || n <= 0) return refuse('NOT_FOUND', ctx.id);
  const [found] = (await ctx.sql`
    select max(n) as top, bool_or(n = ${n}) as chosen
    from releases where site = ${site.name}
  `) as { top: number | null; chosen: boolean | null }[];
  if (found?.chosen !== true) return refuse('NOT_FOUND', ctx.id);
  const held = n !== found.top;
  await ctx.sql`
    update sites set serving = ${n}, held = ${held} where name = ${site.name}
  `;
  return ok({ serving: n, held }, ctx.id);
};

const unhold: Act = async (_request, ctx, site) => {
  const [top] = (await ctx.sql`
    select max(n) as n from releases where site = ${site.name}
  `) as { n: number | null }[];
  const serving = top?.n === null || top === undefined ? null : Number(top.n);
  await ctx.sql`
    update sites set serving = ${serving}, held = false where name = ${site.name}
  `;
  return ok({ held: false, serving }, ctx.id);
};

const remove: Act = async (_request, ctx, site) => {
  await ctx.sql`
    update sites set deleted_at = now(), serving = null where name = ${site.name}
  `;
  // Marked first, then dropped: the row is what makes every later request 410,
  // and it has to say so before the pool closes under the requests in flight.
  await ctx.pg.drop(site.name);
  // The release rows and their content-addressed objects stay — they may be
  // shared, and the nightly dump is the undo path. A file's object is this
  // site's alone and is nobody's undo path, so the rows and the objects both
  // go; then the volume, which carries the bytes of both.
  await dropFiles(ctx, site.name);
  await rm(siteDir(ctx.config.sitesDir, site.name), {
    recursive: true,
    force: true,
  });
  return empty(ctx.id);
};
