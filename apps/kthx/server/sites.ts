/**
 * The control API: claim a name, upload a release, choose which one serves.
 *
 * Answered on the apex only. An owner is a Google account: every route here
 * carries an ID token this server verified, the row keeps the `sub` it compares
 * and the address it displays, and a site is therefore attributable. Sites
 * claimed before identities keep their bearer until `adopt` trades it for one.
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
import type { SQL } from 'bun';
import { aiUsage, MAX_AI_REQUESTS_DAY, MAX_AI_TOKENS_DAY } from './ai.ts';
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
  addressOf,
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
import { bearerOf, identityOf } from './identity.ts';
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
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(seconds) };
}

/** Whether this request carries the pre-identity bearer of this site. */
function opensSite(request: Request, tokenHash: string): boolean {
  const bearer = bearerOf(request);
  return bearer !== null && timingSafeEquals(hash(bearer), tokenHash);
}

/** What an owner check reads off a row, wherever the row was selected. */
export interface Owned {
  readonly owner_sub: string | null;
  readonly token_hash: string | null;
}

/**
 * Whether this request is this site's owner.
 *
 * Two credentials open a site, and only ever one at a time: the verified
 * identity a row names, or — while the row still has a `token_hash`, which is
 * to say until it is adopted — the bearer minted before identities existed.
 *
 * On a site host a credential that is not this site's is *ignored* rather than
 * refused — the OpenAI SDK puts a bearer on every call to `/api/ai` — so this
 * answers a question, not a challenge.
 */
export async function ownsSite(
  request: Request,
  ctx: Pick<Ctx, 'config' | 'server' | 'id'>,
  row: Owned,
): Promise<boolean> {
  const identity = await identityOf(request, ctx);
  if (identity !== null) {
    return row.owner_sub !== null && row.owner_sub === identity.sub;
  }
  return row.token_hash !== null && opensSite(request, row.token_hash);
}

/** `GET /api/whoami`: the address this server just verified. */
export async function whoami(request: Request, ctx: Ctx): Promise<Response> {
  const identity = await identityOf(request, ctx);
  if (identity === null) return refuse('UNAUTHENTICATED', ctx.id);
  return ok({ email: identity.email }, ctx.id);
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
  // Ahead of `siteFor`, which asks whether the caller already owns the site:
  // adopting is what a caller who does not yet own it does.
  if (tail === 'adopt') {
    return method === 'POST'
      ? adopt(request, ctx, name)
      : refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
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
    return ['', 'releases', 'serve', 'hold', 'adopt'].includes(tail)
      ? refuse('METHOD_NOT_ALLOWED', ctx.id)
      : refuse('NOT_FOUND', ctx.id);
  }

  const site = await siteFor(request, name, ctx);
  if ('code' in site) return refuse(site.code, ctx.id);
  return act(request, ctx, site.row);
}

/**
 * The row this name names, once the caller is shown to own it.
 *
 * A deleted name is 410 before a credential is even read — the site is gone for
 * its owner too. A name with no row is 404 whether or not a credential came
 * with it, which is what makes an unauthenticated `GET` a taken-probe: 401
 * means claimed, 404 means free.
 */
async function siteFor(
  request: Request,
  name: string,
  ctx: Ctx,
): Promise<{ row: SiteRow } | { code: Code }> {
  const [row] = (await ctx.sql`
    select name, owner_sub, owner_email, token_hash, serving, held, deleted_at
    from sites where name = ${name} limit 1
  `) as SiteRow[];
  if (row === undefined) return { code: 'NOT_FOUND' };
  if (row.deleted_at !== null) return { code: 'GONE' };

  const identity = await identityOf(request, ctx);
  if (identity !== null) {
    // An identity that is not this owner is refused rather than falling back to
    // the bearer: a verified caller is a decision, not an attempt.
    return row.owner_sub === identity.sub ? { row } : { code: 'FORBIDDEN' };
  }
  if (bearerOf(request) === null) return { code: 'UNAUTHENTICATED' };
  if (row.token_hash === null || !opensSite(request, row.token_hash)) {
    return { code: 'FORBIDDEN' };
  }
  return { row };
}

type Act = (request: Request, ctx: Ctx, site: SiteRow) => Promise<Response>;

// --- the directory ----------------------------------------------------------

/** How many sites a page of the directory holds, and what it may be asked for. */
const DIRECTORY_PAGE = 200;
const MAX_DIRECTORY_PAGE = 500;
/** How long the default page is answered from memory rather than the database. */
const DIRECTORY_CACHE_MS = 10_000;

/** One site as the directory shows it: no usage, no hold, no credential. */
interface Listed {
  readonly name: string;
  /** The owner's address, or null while the site is unadopted. */
  readonly owner_email: string | null;
  readonly serving: number | null;
  readonly releases: number;
  readonly at: Date;
}

interface Page {
  readonly rows: readonly Listed[];
  readonly next: string | null;
  readonly at: number;
}

/**
 * The default page, as this process last answered it.
 *
 * One entry rather than a map keyed by the query, because the caller writes
 * both halves of such a key: invented cursors would fill it, evict what every
 * other visitor is reading, and still cost a query each. Every other shape
 * goes to the database, behind {@link directoryReads}.
 *
 * ponytail: process-wide and in memory, like every other counter here — there
 * is one replica by construction. Dropped whenever the set of names changes,
 * so "I claimed a site and it is not on the list" is never the cache's doing;
 * a release or a rollback is left to age out, because what those move is a
 * number beside a name rather than the list of names.
 */
let cachedPage: Page | null = null;

/** How fast one address may ask for a page the cache does not hold. */
const directoryReads = new TokenBucket(DIRECTORY_BUCKET);

/** The kept page is stale: a name was claimed or deleted. */
function forgetPages(): void {
  cachedPage = null;
}

/**
 * Every live site, newest claim first — the public directory.
 *
 * Public by construction: a name answers on `<name>.<zone>` to anyone who
 * dials it, so listing the names gives away nothing a walk of the zone would
 * not. The owner's address is here on purpose — attribution is why identities
 * exist — while everything about *running* a site stays behind the credential:
 * the usage, the hold, the release digests.
 *
 * One statement, whatever the page: the cursor names the last site of the
 * previous one and the query finds its place itself, so a caller paging to the
 * end costs one indexed lookup a page rather than a growing `offset`.
 */
async function directory(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
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

  const now = Date.now();
  const canonical = after === null && limit === DIRECTORY_PAGE;
  let page = canonical ? cachedPage : null;
  if (page === null || now - page.at > DIRECTORY_CACHE_MS) {
    // Spent on the query, not on the request: the page everyone lands on stays
    // free while it is hot, and what is bounded is work on the control
    // database — the same connection every site host serves its files through.
    const address = addressOf(request, ctx.server, ctx.config.trustedProxies);
    if (directoryReads.spend(address)) {
      return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
    }
    page = await listSites(ctx, limit, after, now);
    if (canonical) cachedPage = page;
  }

  return ok(
    {
      items: page.rows.map((row) => ({
        name: row.name,
        url: siteUrl(ctx.config.zone, row.name, ctx.port),
        owner: row.owner_email,
        serving: row.serving,
        releases: row.releases,
        at: row.at.toISOString(),
      })),
      next: page.next,
    },
    ctx.id,
    200,
    'public, max-age=30',
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
  at: number,
): Promise<Page> {
  const rows = (await ctx.sql`
    with mark as (
      select created_at, name from sites where name = ${after}
    )
    select s.name, s.owner_email, s.serving, s.created_at as at,
           (select count(*)::int from releases r where r.site = s.name)
             as releases
    from sites s
    where s.deleted_at is null
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
    at,
  };
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

  const address = addressOf(request, ctx.server, ctx.config.trustedProxies);
  if (claims.spend(address)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  if (address !== null && claimsPerDay.full(address)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(secondsToMidnight()));
  }

  // Behind the buckets, so a flood of anonymous claims costs a lookup rather
  // than a signature check each. A name now belongs to an account, which is
  // what makes the directory able to say whose it is.
  const identity = await identityOf(request, ctx);
  if (identity === null) return refuse('UNAUTHENTICATED', ctx.id);

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

  // A deleted name stays taken: the row is what makes it answer 410.
  const claimed = (await ctx.sql`
    insert into sites (name, owner_sub, owner_email)
    values (${name}, ${identity.sub}, ${identity.email})
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
  forgetPages();
  // No token in the answer: there is nothing shown once any more. What opens
  // this site is the account that just claimed it.
  return ok(
    { name, url: siteUrl(ctx.config.zone, name, ctx.port) },
    ctx.id,
    201,
  );
}

// --- adopt ------------------------------------------------------------------

/**
 * An identity takes a site that was claimed with a bearer.
 *
 * The old string is the proof: whoever holds it held the site under the deal
 * that was on offer when it was claimed. It is spent here — `token_hash` goes
 * null in the same statement that writes the owner — so a site has exactly one
 * kind of credential at any moment, and a leaked bearer stops opening anything
 * the moment its holder adopts.
 */
async function adopt(
  request: Request,
  ctx: Ctx,
  name: string,
): Promise<Response> {
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_CLAIM_BYTES) {
    return refuse('TOO_LARGE', ctx.id);
  }
  // A bearer is 32 random bytes and cannot be guessed, but this is still the
  // one route that says whether a string opens a site.
  if (claims.spend(addressOf(request, ctx.server, ctx.config.trustedProxies))) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  const identity = await identityOf(request, ctx);
  if (identity === null) return refuse('UNAUTHENTICATED', ctx.id);

  const [row] = (await ctx.sql`
    select owner_sub, token_hash, deleted_at from sites
    where name = ${name} limit 1
  `) as Pick<SiteRow, 'owner_sub' | 'token_hash' | 'deleted_at'>[];
  if (row === undefined) return refuse('NOT_FOUND', ctx.id);
  if (row.deleted_at !== null) return refuse('GONE', ctx.id);
  if (row.owner_sub !== null) return refuse('OWNED', ctx.id);

  const body = await jsonBody(request);
  const token = typeof body.token === 'string' ? body.token : '';
  if (
    row.token_hash === null ||
    !timingSafeEquals(hash(token), row.token_hash)
  ) {
    return refuse('FORBIDDEN', ctx.id);
  }

  // The row read above is a moment old, so the `owner_sub is null` guard is
  // what actually decides it: two callers holding the same bearer both get
  // here, and only one changes a row. The other is told what it would have been
  // told a moment later — 409, not a 204 for a site it does not own.
  const took = (await ctx.sql`
    update sites
    set owner_sub = ${identity.sub}, owner_email = ${identity.email},
        token_hash = null
    where name = ${name} and owner_sub is null
    returning name
  `) as { name: string }[];
  if (took.length === 0) return refuse('OWNED', ctx.id);
  forgetPages();
  return empty(ctx.id);
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
      owner: site.owner_email,
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
  if (claims.spend(addressOf(request, ctx.server, ctx.config.trustedProxies))) {
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
      delete from releases where site = ${name} and n not in (
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

const chooseRelease: Act = async (request, ctx, site) => {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await jsonBody(request);
  const n = Number(body.n);
  if (!Number.isInteger(n) || n <= 0) return refuse('NOT_FOUND', ctx.id);
  const found = (await ctx.sql`
    select n from releases where site = ${site.name} and n = ${n} limit 1
  `) as { n: number }[];
  if (found.length === 0) return refuse('NOT_FOUND', ctx.id);
  await ctx.sql`
    update sites set serving = ${n}, held = true where name = ${site.name}
  `;
  return ok({ serving: n, held: true }, ctx.id);
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
  forgetPages();
  return empty(ctx.id);
};
