/**
 * The control API: claim a name, upload a release, choose which one serves.
 *
 * Answered on the apex only. Ownership is one bearer per site, minted at claim
 * and shown once; the row keeps its SHA-256 and nothing else. There is no user
 * and no session — a visitor who lost the token has lost the site, which is the
 * deal the landing page states.
 *
 * The upload boundary is `@repo/archive`: `normalizeArchive` turns a ZIP into
 * the gzipped tar everything downstream opens, the depot stores it under its
 * own digest, and the bundle is read once so an archive with no entry page is
 * refused before it is stored. What this file adds is the *order*: bytes land
 * in the depot, then on the volume, and only then does a row say a site serves
 * them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { base64urlEncode } from '@repo/archive/bytes';
import type { SQL } from 'bun';
import type { ReleaseRow, SiteRow } from './db.ts';
import type { Depot } from './depot.ts';
import type { Config } from './env.ts';
import {
  addressOf,
  type Code,
  empty,
  isJson,
  logCause,
  ok,
  refuse,
  sameOrigin,
  siteUrl,
} from './http.ts';
import {
  CLAIM_BUCKET,
  DailyCap,
  secondsToMidnight,
  TokenBucket,
} from './limits.ts';
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

export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Names nobody may claim.
 *
 * Three groups: the hostnames a zone owes itself, the path prefixes reserved on
 * every site host (a site called `files` would still be reachable, but the
 * confusion is not worth the label), and the Postgres identifiers a site name
 * becomes — a name is also a database and a role, so `postgres` and the
 * templates are taken before anyone asks.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'mail',
  'ftp',
  'sdk',
  'static',
  'assets',
  'cdn',
  'fn',
  'dev',
  'test',
  'staging',
  'kthx',
  'lolwtf',
  'spindrift',
  'root',
  'internal',
  '_',
  'files',
  'client',
  'ai',
  'mcp',
  'cli',
  'postgres',
  'template0',
  'template1',
  'template_kthx',
  'kthx_site',
  'public',
  'none',
]);

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

/** Why a name cannot be claimed, or `null`. */
export function nameProblem(name: string): 'INVALID_NAME' | 'RESERVED' | null {
  if (name.length < 3 || name.length > 40 || !NAME_PATTERN.test(name)) {
    return 'INVALID_NAME';
  }
  return RESERVED_NAMES.has(name) ? 'RESERVED' : null;
}

/** Everything a handler is given: the deployment, the stores, this request. */
export interface Ctx {
  readonly config: Config;
  readonly sql: SQL;
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

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(seconds) };
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

  const site = await siteFor(request, name, ctx);
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
  request: Request,
  name: string,
  ctx: Ctx,
): Promise<{ row: SiteRow } | { code: Code }> {
  const [row] = (await ctx.sql`
    select name, token_hash, serving, held, deleted_at
    from sites where name = ${name} limit 1
  `) as SiteRow[];
  if (row === undefined) return { code: 'NOT_FOUND' };
  if (row.deleted_at !== null) return { code: 'GONE' };

  const bearer = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get('authorization') ?? '',
  )?.[1];
  if (bearer === undefined) return { code: 'UNAUTHENTICATED' };
  if (!sameHash(hash(bearer), row.token_hash)) return { code: 'FORBIDDEN' };
  return { row };
}

type Act = (request: Request, ctx: Ctx, site: SiteRow) => Promise<Response>;

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

  const body = await jsonBody(request);
  const name =
    typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  const problem = nameProblem(name);
  if (problem !== null) return refuse(problem, ctx.id);

  const [live] = (await ctx.sql`
    select count(*)::int as live from sites where deleted_at is null
  `) as { live: number }[];
  if ((live?.live ?? 0) >= MAX_LIVE_SITES) return refuse('BUSY', ctx.id);

  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  // A deleted name stays taken: the row is what makes it answer 410.
  const claimed = (await ctx.sql`
    insert into sites (name, token_hash) values (${name}, ${hash(token)})
    on conflict do nothing returning name
  `) as { name: string }[];
  if (claimed.length === 0) return refuse('TAKEN', ctx.id);

  if (address !== null) claimsPerDay.count(address);
  return ok(
    { name, url: siteUrl(ctx.config.zone, name, ctx.port), token },
    ctx.id,
    201,
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

// --- inspect ----------------------------------------------------------------

/** The ceilings the contract fixes, reported so a client need not hard-code them. */
const QUOTAS = {
  doc_bytes: 1024 * 1024,
  db_bytes: 256 * 1024 * 1024,
  file_bytes: 25 * 1024 * 1024,
  files_bytes: 256 * 1024 * 1024,
  ai_requests_day: 200,
  ai_tokens_day: 500_000,
} as const;

const inspect: Act = async (_request, ctx, site) => {
  const rows = (await ctx.sql`
    select n, digest, size, at from releases
    where site = ${site.name} order by n desc
  `) as ReleaseRow[];
  return ok(
    {
      name: site.name,
      url: siteUrl(ctx.config.zone, site.name, ctx.port),
      serving: site.serving,
      held: site.held,
      releases: rows.map((row) => ({
        n: row.n,
        digest: row.digest,
        size: Number(row.size),
        at: row.at.toISOString(),
      })),
      // The meters land with the backends they measure: `db_bytes` with
      // `/api/db`, the rest with `/api/files` and `/api/ai`. A site with none of
      // them yet has spent none of them.
      usage: {
        db_bytes: 0,
        files_bytes: 0,
        ai_requests_today: 0,
        ai_tokens_today: 0,
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

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await withDeadline(request));
  } catch (cause) {
    logCause(ctx.id, 'reading the upload', cause);
    return refuse('TIMEOUT', ctx.id);
  }
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) return refuse('TOO_LARGE', ctx.id);

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

/** The body, or a rejection once the contract's deadline passes. */
async function withDeadline(request: Request): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.arrayBuffer(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the body did not arrive in time')),
          BODY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  // The release rows and their content-addressed objects stay — they may be
  // shared, and the nightly dump is the undo path. The bytes on this volume are
  // not, so they go now.
  await rm(siteDir(ctx.config.sitesDir, site.name), {
    recursive: true,
    force: true,
  });
  return empty(ctx.id);
};
