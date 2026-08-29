/**
 * kthx: the API. Claim a name, upload a release, choose which one serves.
 *
 * Five hand-authored paths under `/kthx/`, answered on the apex only, with
 * `{ code, message }` refusals. Ownership is one bearer per site, minted at
 * claim and shown once; the row keeps its SHA-256 and nothing else. There is
 * no user, no session, and no Spindrift principal behind a site — a visitor
 * who lost the token has lost the site, which is the deal the landing page
 * states.
 *
 * The upload boundary is the one `/internal/upload` already has:
 * `normalizeArchive` turns a ZIP into the gzipped tar every reader opens,
 * `stageArchiveBytes` puts it in the installation's depot, and the digest is
 * over what was staged. What kthx adds is reading the bundle back once, so
 * an archive with no `index.html` at its root is refused before it is stored.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, max } from 'drizzle-orm';
import { BundleError } from '../adapters/deploy/static/bundle.ts';
import { base64urlEncode } from '../auth/bytes.ts';
import { kthxKv, kthxReleases, kthxSites } from '../db/schema.ts';
import {
  ArchiveFormatError,
  normalizeArchive,
} from '../storage/archive-format.ts';
import { stageArchiveBytes } from '../storage/archives.ts';
import {
  type KthxDeps,
  kthxUrl,
  rememberSiteFiles,
  siteFiles,
  siteOf,
} from './serve.ts';

/** The API, as `Bun.serve` route keys. Every one is a decision `routes.ts` names. */
export const KTHX_PATHS = [
  '/kthx/sites',
  '/kthx/sites/:name',
  '/kthx/sites/:name/releases',
  '/kthx/sites/:name/serve',
  '/kthx/sites/:name/hold',
] as const;

export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
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
]);

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
/** What an archive may unpack to; the compressed size says nothing about it. */
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 2000;

/** Why a name cannot be claimed, or `null`. */
export function nameProblem(name: string): 'INVALID_NAME' | 'RESERVED' | null {
  if (name.length < 3 || name.length > 40 || !NAME_PATTERN.test(name)) {
    return 'INVALID_NAME';
  }
  return RESERVED_NAMES.has(name) ? 'RESERVED' : null;
}

type Handler = (
  request: Request,
  server?: Bun.Server<unknown>,
) => Promise<Response>;

export function kthxRoutes(deps: KthxDeps): Record<string, Handler> {
  return {
    [KTHX_PATHS[0]]: on(deps, { POST: claim }),
    [KTHX_PATHS[1]]: on(deps, {
      GET: owned(inspect),
      DELETE: owned(remove),
    }),
    [KTHX_PATHS[2]]: on(deps, { POST: owned(release) }),
    [KTHX_PATHS[3]]: on(deps, { POST: owned(serve) }),
    [KTHX_PATHS[4]]: on(deps, { DELETE: owned(unhold) }),
  };
}

type Act = (
  request: Request,
  deps: KthxDeps,
  server?: Bun.Server<unknown>,
) => Promise<Response>;

/** Apex only, one act per method, 405 for the rest. */
function on(deps: KthxDeps, acts: Record<string, Act>): Handler {
  return async (request, server) => {
    if (siteOf(request, deps.zone) !== '') {
      return refuse(404, 'NOT_FOUND', 'the kthx API answers on the apex only');
    }
    const act = acts[request.method];
    if (act === undefined) {
      return refuse(
        405,
        'METHOD_NOT_ALLOWED',
        `${request.method} is not something this path does`,
      );
    }
    return act(request, deps, server);
  };
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

// --- ownership --------------------------------------------------------------

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Site = typeof kthxSites.$inferSelect;

type OwnedAct = (
  request: Request,
  deps: KthxDeps,
  site: Site,
  server?: Bun.Server<unknown>,
) => Promise<Response>;

/** The site the path names, if its bearer is the one presented. */
function owned(act: OwnedAct): Act {
  return async (request, deps, server) => {
    let name: string;
    try {
      name = decodeURIComponent(
        new URL(request.url).pathname.split('/')[3] ?? '',
      );
    } catch {
      return refuse(404, 'NOT_FOUND', 'that is not a site name');
    }
    const [site] = await deps.db
      .select()
      .from(kthxSites)
      .where(eq(kthxSites.name, name))
      .limit(1);
    if (site === undefined || site.deletedAt !== null) {
      return refuse(404, 'NOT_FOUND', `no site is called ${name}`);
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(
      request.headers.get('authorization') ?? '',
    )?.[1];
    if (bearer === undefined) {
      return refuse(
        401,
        'UNAUTHENTICATED',
        'this site is opened with its token: Authorization: Bearer <token>',
      );
    }
    if (!same(hash(bearer), site.tokenHash)) {
      return refuse(403, 'FORBIDDEN', 'that token does not open this site');
    }
    return act(request, deps, site, server);
  };
}

// --- the abuse floor --------------------------------------------------------

/** Thirty in a burst, then six a minute, per address, on claim and upload. */
const BUCKET = { capacity: 30, perSecond: 0.1 };
const buckets = new Map<string, { tokens: number; at: number }>();

// ponytail: per-replica and in memory; the address is what the edge says it
// is. Upgrade path is a counter in Postgres when a second replica or a
// forged header becomes the problem.
export function limited(
  request: Request,
  server: Bun.Server<unknown> | undefined,
): boolean {
  const address =
    request.headers.get('cf-connecting-ip') ??
    server?.requestIP(request)?.address ??
    null;
  if (address === null) return false;
  const now = Date.now();
  const bucket = buckets.get(address) ?? { tokens: BUCKET.capacity, at: now };
  bucket.tokens = Math.min(
    BUCKET.capacity,
    bucket.tokens + ((now - bucket.at) / 1000) * BUCKET.perSecond,
  );
  bucket.at = now;
  buckets.set(address, bucket);
  if (buckets.size > 10_000) evict();
  if (bucket.tokens < 1) return true;
  bucket.tokens -= 1;
  return false;
}

/**
 * Make room by dropping a bucket that is still near full — one a flood of
 * fresh addresses left behind — so the flood evicts only itself and never
 * resets an address that is being held.
 */
function evict(): void {
  for (const [address, bucket] of buckets) {
    if (bucket.tokens >= BUCKET.capacity - 1) {
      buckets.delete(address);
      return;
    }
  }
  buckets.delete(buckets.keys().next().value as string);
}

// --- acts -------------------------------------------------------------------

const claim: Act = async (request, deps, server) => {
  if (limited(request, server)) {
    return refuse(
      429,
      'RATE_LIMITED',
      'too many claims from here; wait a minute',
    );
  }
  const body = await bodyOf(request);
  const name =
    typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  const problem = nameProblem(name);
  if (problem !== null) {
    return refuse(
      400,
      problem,
      problem === 'RESERVED'
        ? `${name} is reserved`
        : 'a name is 3 to 40 of a-z, 0-9 and -, and does not start or end with -',
    );
  }
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const [claimed] = await deps.db
    .insert(kthxSites)
    .values({ name, tokenHash: hash(token) })
    // A deleted name stays taken: the row is what makes it answer 410.
    .onConflictDoNothing()
    .returning({ name: kthxSites.name });
  if (claimed === undefined) {
    return refuse(409, 'TAKEN', `${name} is taken`);
  }
  return Response.json(
    { name, url: kthxUrl(request, deps.zone, name), token },
    { status: 201 },
  );
};

const inspect: OwnedAct = async (request, deps, site) => {
  const rows = await deps.db
    .select({
      n: kthxReleases.n,
      digest: kthxReleases.digest,
      size: kthxReleases.size,
      at: kthxReleases.createdAt,
    })
    .from(kthxReleases)
    .where(eq(kthxReleases.site, site.name))
    .orderBy(desc(kthxReleases.n));
  return Response.json({
    name: site.name,
    url: kthxUrl(request, deps.zone, site.name),
    serving: site.serving,
    held: site.held,
    releases: rows.map((row) => ({ ...row, at: row.at.toISOString() })),
  });
};

/** `readBundle`'s refusals, in the archive vocabulary the contract promises. */
const BUNDLE_CODES = {
  NOT_GZIP: 'UNKNOWN_FORMAT',
  MALFORMED_TAR: 'MALFORMED_ZIP',
  PATH_ESCAPES_BUNDLE: 'PATH_ESCAPES_ARCHIVE',
  TOO_LARGE: 'TOO_LARGE',
} as const;

const release: OwnedAct = async (request, deps, site, server) => {
  if (limited(request, server)) {
    return refuse(
      429,
      'RATE_LIMITED',
      'too many uploads from here; wait a minute',
    );
  }
  const filename = request.headers.get('x-filename')?.trim() || 'site.zip';
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    return refuse(
      413,
      'TOO_LARGE',
      `an archive is at most ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB`,
    );
  }

  let archive: ReturnType<typeof normalizeArchive>;
  try {
    archive = normalizeArchive(filename, bytes, MAX_UNPACKED_BYTES);
  } catch (cause) {
    if (cause instanceof ArchiveFormatError) {
      return refuse(
        cause.code === 'TOO_LARGE' ? 413 : 400,
        cause.code,
        cause.message,
      );
    }
    throw cause;
  }

  let files: ReturnType<typeof siteFiles>;
  try {
    files = siteFiles(new Uint8Array(archive.bytes), MAX_UNPACKED_BYTES);
  } catch (cause) {
    if (cause instanceof BundleError) {
      return refuse(
        cause.code === 'TOO_LARGE' ? 413 : 400,
        BUNDLE_CODES[cause.code],
        cause.message,
      );
    }
    throw cause;
  }
  if (files.size > MAX_FILES) {
    return refuse(413, 'TOO_LARGE', `a site is at most ${MAX_FILES} files`);
  }
  if (!files.has('/index.html')) {
    return refuse(
      400,
      'NO_INDEX',
      'the archive has no index.html at its root; kthx needs one',
    );
  }

  let staged: Awaited<ReturnType<typeof stageArchiveBytes>>;
  try {
    staged = await stageArchiveBytes(
      archive.filename,
      archive.bytes,
      await deps.depot(),
    );
  } catch (cause) {
    return refuse(
      500,
      'STORAGE_FAILURE',
      cause instanceof Error ? cause.message : 'staging the archive failed',
    );
  }

  // One site's uploads are numbered under its own lock, so two arriving at
  // once get two numbers rather than one of them losing the primary key.
  const numbered = await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ held: kthxSites.held, serving: kthxSites.serving })
      .from(kthxSites)
      .where(eq(kthxSites.name, site.name))
      .for('update');
    const [top] = await tx
      .select({ n: max(kthxReleases.n) })
      .from(kthxReleases)
      .where(eq(kthxReleases.site, site.name));
    const n = Number(top?.n ?? 0) + 1;
    await tx.insert(kthxReleases).values({
      site: site.name,
      n,
      digest: staged.digest,
      location: staged.location,
      size: staged.size,
    });
    if (locked?.held) return { n, serving: locked.serving };
    await tx
      .update(kthxSites)
      .set({ serving: n })
      .where(eq(kthxSites.name, site.name));
    return { n, serving: n };
  });

  rememberSiteFiles(staged.digest, files);
  return Response.json(
    {
      ...numbered,
      digest: staged.digest,
      url: kthxUrl(request, deps.zone, site.name),
    },
    { status: 201 },
  );
};

const serve: OwnedAct = async (request, deps, site) => {
  const body = await bodyOf(request);
  const n = Number(body.n);
  const [found] =
    Number.isInteger(n) && n > 0
      ? await deps.db
          .select({ n: kthxReleases.n })
          .from(kthxReleases)
          .where(and(eq(kthxReleases.site, site.name), eq(kthxReleases.n, n)))
          .limit(1)
      : [];
  if (found === undefined) {
    return refuse(404, 'NOT_FOUND', `${site.name} has no release ${body.n}`);
  }
  await deps.db
    .update(kthxSites)
    .set({ serving: n, held: true })
    .where(eq(kthxSites.name, site.name));
  return Response.json({ serving: n, held: true });
};

const unhold: OwnedAct = async (_request, deps, site) => {
  const [top] = await deps.db
    .select({ n: max(kthxReleases.n) })
    .from(kthxReleases)
    .where(eq(kthxReleases.site, site.name));
  const serving = top?.n === null || top === undefined ? null : Number(top.n);
  await deps.db
    .update(kthxSites)
    .set({ serving, held: false })
    .where(eq(kthxSites.name, site.name));
  return Response.json({ held: false, serving });
};

const remove: OwnedAct = async (_request, deps, site) => {
  await deps.db.delete(kthxKv).where(eq(kthxKv.site, site.name));
  await deps.db
    .update(kthxSites)
    .set({ deletedAt: new Date() })
    .where(eq(kthxSites.name, site.name));
  return new Response(null, { status: 204 });
};
