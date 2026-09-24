/**
 * The control API: claim a name, upload a release, choose which one serves.
 * An upload is stored in the depot, then on the volume, and only then does a row
 * say the site serves it. A lost token without an owner login loses the site.
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

/** Live sites before claims stop. */
export const MAX_LIVE_SITES = 5000;
/** Claims per caller bucket per UTC day. */
export const MAX_CLAIMS_PER_DAY = 20;
/** Uploads per site per UTC day. */
export const MAX_UPLOADS_PER_DAY = 60;
export const BODY_TIMEOUT_MS = 120_000;
/** Far above any legal `{name}` body, far below the server's cap. */
const MAX_CLAIM_BYTES = 64 * 1024;

const claims = new TokenBucket(CLAIM_BUCKET);
const claimsPerDay = new DailyCap(MAX_CLAIMS_PER_DAY);
const uploadsPerDay = new DailyCap(MAX_UPLOADS_PER_DAY);

export interface Ctx {
  readonly config: Config;
  readonly sql: SQL;
  readonly pg: Pg;
  readonly depot: Depot;
  readonly server: Bun.Server<unknown> | undefined;
  readonly id: string;
  readonly host: string;
  /** The request's port, so a local run answers with a reachable URL. */
  readonly port: string;
  readonly caller: Caller;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(seconds) };
}

export interface Owned {
  readonly token_hash: string | null;
  readonly owner_login: string | null;
}

/**
 * The bearer or the owner login opens a site; the bearer stays because a tagged
 * node sends no identity header. A foreign bearer is ignored: OpenAI SDKs send
 * one to `/api/ai`.
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

/** `segments` is the split pathname; `null` for a path this route lacks. */
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
    return ['', 'releases', 'serve', 'hold'].includes(tail)
      ? refuse('METHOD_NOT_ALLOWED', ctx.id)
      : refuse('NOT_FOUND', ctx.id);
  }

  // The proxy's identity header makes a login ambient, so a foreign page could
  // write here. `GET` is exempt: without CORS headers its answer is unreadable.
  if (method !== 'GET' && !sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const site = await siteFor(name, ctx);
  if ('code' in site) return refuse(site.code, ctx.id);
  return act(request, ctx, site.row);
}

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
  // The landing page reads 401 as taken and 404 as free. A verified login is
  // no credential offered, so it must not turn that 401 into a 403.
  if (ctx.caller.authorization === null) return { code: 'UNAUTHENTICATED' };
  return { code: 'FORBIDDEN' };
}

type Act = (request: Request, ctx: Ctx, site: SiteRow) => Promise<Response>;

const DIRECTORY_PAGE = 200;
const MAX_DIRECTORY_PAGE = 500;

/** Public fields only: no token hash, usage or hold. */
interface Listed {
  readonly name: string;
  readonly owner_login: string | null;
  readonly serving: number | null;
  readonly releases: number;
  readonly at: Date;
  /** The newest release's time, or null for a name with none. */
  readonly changed: Date | null;
}

interface Page {
  readonly rows: readonly Listed[];
  readonly next: string | null;
}

const directoryReads = new TokenBucket(DIRECTORY_BUCKET);

/**
 * The public directory; any site already answers on `<name>.<zone>`. An owner
 * login is an email address, so it is shown only to that owner, and listing by
 * anyone else's login is refused.
 */
async function directory(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const owner = query.get('owner');
  if (owner !== null && owner !== 'me') return refuse('INVALID_QUERY', ctx.id);
  if (owner === 'me' && ctx.caller.login === null) {
    return refuse('UNAUTHENTICATED', ctx.id);
  }
  const after = query.get('after');
  // A reserved name matches no row and ends the walk; a non-name is refused.
  if (after !== null && nameProblem(after) === 'INVALID_NAME') {
    return refuse('INVALID_QUERY', ctx.id);
  }
  // An empty `?limit=` means the default, not zero.
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
        changed: row.changed?.toISOString() ?? null,
      })),
      next: page.next,
    },
    ctx.id,
  );
}

/**
 * Keyset paging on `(at, name)` from the cursor's row. A deleted site's cursor
 * still pages, since its row keeps its claim time.
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
             as releases,
           (select max(r.at) from releases r where r.site = s.name)
             as changed
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

export interface Standing {
  /** Never true for a name with a row, deleted or not. */
  readonly available: boolean;
  readonly why: 'INVALID_NAME' | 'RESERVED' | 'TAKEN' | null;
  /** `null` unless the caller opens the site; `empty` means no release yet. */
  readonly yours: 'empty' | 'live' | null;
}

/**
 * A fast no, never a promised yes: the claim also checks the Postgres catalogs
 * and settles races. A deleted name stays taken and is nobody's.
 */
export async function nameStanding(ctx: Ctx, name: string): Promise<Standing> {
  const why = nameProblem(name);
  if (why !== null) return { available: false, why, yours: null };
  const [row] = (await ctx.sql`
    select token_hash, owner_login, serving, deleted_at from sites
    where name = ${name} limit 1
  `) as {
    token_hash: string | null;
    owner_login: string | null;
    serving: number | null;
    deleted_at: Date | null;
  }[];
  if (row === undefined) return { available: true, why: null, yours: null };
  const mine = row.deleted_at === null && opensSite(ctx.caller, row);
  return {
    available: false,
    why: 'TAKEN',
    yours: mine ? (row.serving === null ? 'empty' : 'live') : null,
  };
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
 * Hard-deletes every site so the names come free; release archives stay in the
 * depot, uncollected. Without `KTHX_ADMIN_LOGINS` the route is a hidden 404.
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

  // Deleted rows too: removing them frees their names.
  const rows = (await ctx.sql`select name from sites order by name`) as {
    name: string;
  }[];
  let deleted = 0;
  let failed = 0;
  // ponytail: one `DROP DATABASE` at a time. Batch it before a nuke must clear
  // thousands: the edge gives a request 100 s.
  for (const { name } of rows) {
    try {
      await erase(ctx, name);
      deleted += 1;
    } catch (cause) {
      logCause(ctx.id, `nuking ${name}`, cause);
      failed += 1;
    }
  }
  return ok({ deleted, failed }, ctx.id);
}

/**
 * The row delete cascades to `releases`, `files` and `ai_usage`, and precedes
 * the drop so `Pg.sweep` cleans up after any later failure.
 */
async function erase(ctx: Ctx, name: string): Promise<void> {
  // Before the row delete cascades away the rows naming its objects.
  await dropFiles(ctx, name);
  await ctx.sql`delete from sites where name = ${name}`;
  await ctx.pg.drop(name);
  await rm(siteDir(ctx.config.sitesDir, name), {
    recursive: true,
    force: true,
  });
}

async function claim(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  // Anonymous, so an oversized claim is refused before a byte is buffered.
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

  // A database or role without a row is a failed claim's residue; handing the
  // name out again would hand over its documents.
  if (await ctx.pg.inUse(name)) return refuse('TAKEN', ctx.id);

  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  // A deleted row still conflicts, keeping its 410. A bearer is minted on every
  // door: the CLI, agents and devices off the tailnet carry no login.
  const claimed = (await ctx.sql`
    insert into sites (name, token_hash, owner_login)
    values (${name}, ${hash(token)}, ${ctx.caller.login})
    on conflict do nothing returning name
  `) as { name: string }[];
  if (claimed.length === 0) return refuse('TAKEN', ctx.id);

  // `CREATE DATABASE` cannot join a transaction, so a failure deletes the row;
  // the `inUse` check above catches whatever was left behind.
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

/** Reported so a client need not hard-code them. */
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

const release: Act = async (request, ctx, site) => {
  // Before the rate limit: a full process is not this caller's doing and must
  // not spend its allowance. Only a probe; `stage` takes the slot.
  if (slotsFull()) return refuse('BUSY', ctx.id);
  if (claims.spend(ctx.caller.bucket)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(60));
  }
  if (uploadsPerDay.full(site.name)) {
    return refuse('RATE_LIMITED', ctx.id, retryAfter(secondsToMidnight()));
  }
  const answer = await stage(request, ctx, site);
  // Only a release that happened counts toward the day.
  if (answer.status === 201) uploadsPerDay.count(site.name);
  return answer;
};

interface Numbered {
  readonly n: number;
  readonly serving: number | null;
}

async function stage(
  request: Request,
  ctx: Ctx,
  site: SiteRow,
): Promise<Response> {
  // The server's 30 s idle timeout is too short for a real upload.
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

  // Only once the body is in: a caller trickling a body must not hold a slot.
  const slot = takeSlot();
  if (slot === null) return refuse('BUSY', ctx.id);
  try {
    return await unpack(ctx, site, bytes, request.headers.get('x-filename'));
  } finally {
    slot();
  }
}

async function unpack(
  ctx: Ctx,
  site: SiteRow,
  bytes: Uint8Array,
  filename: string | null,
): Promise<Response> {
  let read: ReturnType<typeof readRelease>;
  try {
    // A caller's assertion, used only in log lines: never echoed, never a path.
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
        // The site row lock gives concurrent uploads distinct numbers.
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
          // A held site stores the upload without serving it, so a deploy
          // during a rollback cannot undo the rollback.
          const serving = locked?.held ? locked.serving : n;
          if (!locked?.held) {
            await tx`update sites set serving = ${n} where name = ${site.name}`;
          }
          // Inside the transaction, so a failed rename rolls the row back.
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
 * Keeps whatever the site serves when the delete runs, so a concurrent rollback
 * keeps its row. The serving and previous releases stay on disk.
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
    // A failed prune costs disk, never correctness.
    logCause(ctx.id, 'pruning releases', cause);
  }
}

/**
 * An older release holds the site: later uploads are stored but do not serve.
 * The newest holds nothing, or the first rollback would stick forever.
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
  // Marked first, so requests answer 410 before the pool closes under them.
  await ctx.pg.drop(site.name);
  // Release rows and their objects stay: objects may be shared, and the
  // database backup is the undo path. File objects are this site's alone.
  await dropFiles(ctx, site.name);
  await rm(siteDir(ctx.config.sitesDir, site.name), {
    recursive: true,
    force: true,
  });
  return empty(ctx.id);
};
