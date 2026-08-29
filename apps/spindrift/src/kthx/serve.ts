/**
 * kthx: the serving half. Which requests are kthx's, and the bytes a site
 * answers with.
 *
 * `Bun.serve` matches routes by path and nothing else, so a request for `/`
 * on `Host: notes.kthx.dev` would land on the console. {@link withKthxHost}
 * wraps the whole table once so that a kthx Host is answered here before any
 * path route runs: the apex gets the landing page, a site gets a file from
 * the release it is serving, and everything else falls through untouched.
 * The `/kthx/*` API (`sites.ts`) stays a set of path routes and is reached
 * only on the apex.
 *
 * A site's files come from the same depot an uploaded artifact is staged to,
 * read back through `readBundle` exactly as the static deploy backends read
 * one. Nothing is minted per site — no route, no record, no certificate: the
 * wildcard for the zone reaches this process, and a name is live the moment
 * its row says which release to serve.
 */
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { readBundle } from '../adapters/deploy/static/bundle.ts';
import { loadDeploymentFederation } from '../config/federation-credential.ts';
import type { Database } from '../db/client.ts';
import { kthxReleases, kthxSites } from '../db/schema.ts';
import { readStagedArchive, type SourceDepot } from '../storage/archives.ts';
import { fetchableBundleUrl } from '../storage/signed-url.ts';
import { sdkResponse, underscoreResponse } from './data.ts';
import { FAVICON, FAVICON_DIGEST, FAVICON_PATH } from './favicon.ts';

/** The zone kthx sites live in. `kthx.localhost` resolves to loopback for a local run. */
export const KTHX_ZONE_VAR = 'KTHX_ZONE';

export function kthxZone(env: Record<string, string | undefined>): string {
  return env[KTHX_ZONE_VAR]?.trim().toLowerCase() || 'kthx.dev';
}

/** The bucket kthx stages releases into, where the deployment names one. */
export const KTHX_BUCKET_VAR = 'KTHX_BUCKET';

/**
 * The depot this deployment gives kthx, or `null` when it gives it none.
 *
 * kthx's one hard dependency on Spindrift was the depot: it came from
 * `sourceDepotFor(manifest)`, so no site served a byte until the installation
 * manifest loaded — a document kthx reads nothing else out of. The bucket
 * name is all it ever wanted from it, and federation was never the manifest's
 * either: `cloud.federation` is itself the mounted credential, read by
 * `loadDeploymentFederation`. Naming the bucket here leaves kthx wanting a
 * variable and a mounted credential, and nothing else.
 *
 * `null` when the variable is unset, which is what lets a caller keep the
 * manifest lookup as its fallback rather than this deciding for it.
 */
export async function kthxDepot(
  env: Record<string, string | undefined>,
): Promise<SourceDepot | null> {
  const bucket = env[KTHX_BUCKET_VAR]?.trim();
  if (!bucket) return null;
  const federation = await loadDeploymentFederation(env);
  return federation === null ? null : { bucket, federation };
}

/** Where the API lives on the apex; the host wrapper lets these paths through. */
export const KTHX_API_PREFIX = '/kthx/';

export interface KthxDeps {
  readonly db: Database;
  readonly zone: string;
  /** The depot releases are staged to, or `null` for the local-disk fallback. */
  depot(): Promise<SourceDepot | null>;
}

/**
 * The kthx name a request is for: `''` for the apex, `null` for a host that is
 * not kthx's. Anything under the zone is kthx's, so `a.b.<zone>` is a site
 * name that no row can match and answers 404 here — never the console.
 */
export function siteOf(request: Request, zone: string): string | null {
  const host = (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  if (host === zone) return '';
  if (!host.endsWith(`.${zone}`)) return null;
  return host.slice(0, -zone.length - 1);
}

/**
 * `https://<label>.<zone>` — or plain http on the port a local run listens on,
 * because nothing terminates TLS in front of `kthx.localhost`.
 */
export function kthxUrl(
  request: Request,
  zone: string,
  label?: string,
): string {
  const host = label === undefined ? zone : `${label}.${zone}`;
  if (!zone.endsWith('.localhost')) return `https://${host}`;
  const port = (request.headers.get('host') ?? '').split(':')[1];
  return `http://${host}${port ? `:${port}` : ''}`;
}

type Handler = (
  request: Request,
  server: Bun.Server<unknown>,
) => Response | undefined | Promise<Response | undefined>;

/**
 * The same table, with every entry answering kthx hosts here first.
 *
 * A static `Response` becomes a handler that clones it, because the request
 * for `/` on a site host has to be told apart from the request for `/` on the
 * console. A development HTML import cannot be wrapped — Bun compiles it in
 * place — so it is left as it is.
 */
// ponytail: `bun run dev` serves the console at `/` on every host; the kthx
// apex and site roots need `bun run build && bun run start`. The upgrade path
// is a dev entry that builds the client first.
export function withKthxHost<T extends Record<string, unknown>>(
  routes: T,
  deps: KthxDeps,
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(routes)) {
    const passThrough: Handler | null =
      typeof entry === 'function'
        ? (entry as Handler)
        : entry instanceof Response
          ? () => entry.clone()
          : null;
    if (passThrough === null) {
      wrapped[path] = entry;
      continue;
    }
    wrapped[path] = (request: Request, server: Bun.Server<unknown>) => {
      const site = siteOf(request, deps.zone);
      if (site === null) return passThrough(request, server);
      if (site === '') {
        return path.startsWith(KTHX_API_PREFIX)
          ? passThrough(request, server)
          : apexResponse(request, deps.zone);
      }
      return siteResponse(request, site, deps, server);
    };
  }
  return wrapped as T;
}

const LANDING = join(import.meta.dir, 'landing.html');

/**
 * The apex: the landing page at `/`, the SDK at `/sdk.js`, the generic
 * favicon, nothing else.
 */
function apexResponse(request: Request, zone: string): Response {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/sdk.js') return sdkResponse();
  if (pathname === FAVICON_PATH) return faviconResponse(request);
  if (pathname !== '/') return notHere(request, zone, 404);
  return new Response(Bun.file(LANDING), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

// --- files ------------------------------------------------------------------

interface SiteFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly type: string;
}

/** A read bundle as the paths a site serves, `/index.html` and siblings. */
export type SiteFiles = ReadonlyMap<string, SiteFile>;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
};

function typeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The files a staged bundle serves.
 *
 * A single top-level directory is stripped — a ZIP of a folder is the common
 * case and `notes/index.html` is not a site — the same way the landing page's
 * own reader unwraps one before it counts files.
 */
export function siteFiles(
  bundle: Uint8Array<ArrayBuffer>,
  maxBytes?: number,
): SiteFiles {
  const read = readBundle(bundle, maxBytes);
  const tops = new Set(read.map((file) => file.path.split('/')[1]));
  const wrapped =
    tops.size === 1 && read.every((file) => file.path.split('/').length > 2);
  const files = new Map<string, SiteFile>();
  for (const file of read) {
    const path = wrapped
      ? file.path.slice(file.path.indexOf('/', 1))
      : file.path;
    files.set(path, { bytes: file.bytes, type: typeOf(path) });
  }
  return files;
}

// --- the cache --------------------------------------------------------------

/**
 * Parsed bundles by digest, newest-used last.
 *
 * Promises rather than values so that a burst of requests for a cold site
 * fetches the bundle once. A failed load is dropped so the next request
 * tries again.
 */
// ponytail: per-replica, refilled from the depot on a miss. The upgrade path
// is a shared cache in front of the depot if a second web replica ever makes
// this one look cold.
//
// The size is what the uploads leave: 768 MiB of pod, about 104 MiB of it
// idle, and unpacking bounded by `MAX_UNPACKED_BYTES` peaking around 400 MiB
// above that — measured with this cache full, because filling an entry runs
// the same unpack a release does. `trim` keeps one entry that is over the cap
// on its own, so what stays resident here is this plus at most one bundle.
// Raising `MAX_UNPACKED_BYTES` or the pod's limit is what would let it grow.
const CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { files: Promise<SiteFiles>; bytes: number }>();
let cached = 0;

function sizeOf(files: SiteFiles): number {
  let total = 0;
  for (const file of files.values()) total += file.bytes.byteLength;
  return total;
}

/** Remember a bundle that was just parsed, so its first request is warm. */
export function rememberSiteFiles(digest: string, files: SiteFiles): void {
  drop(digest);
  const bytes = sizeOf(files);
  cache.set(digest, { files: Promise.resolve(files), bytes });
  cached += bytes;
  trim();
}

function drop(digest: string): void {
  const entry = cache.get(digest);
  if (entry === undefined) return;
  cache.delete(digest);
  cached -= entry.bytes;
}

function trim(): void {
  while (cached > CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

async function filesFor(
  release: { digest: string; location: string },
  deps: KthxDeps,
): Promise<SiteFiles> {
  const hit = cache.get(release.digest);
  if (hit !== undefined) {
    cache.delete(release.digest);
    cache.set(release.digest, hit);
    return hit.files;
  }
  const entry = {
    files: loadBundle(release, deps).then((bundle) => siteFiles(bundle)),
    bytes: 0,
  };
  cache.set(release.digest, entry);
  entry.files.then(
    (files) => {
      entry.bytes = sizeOf(files);
      cached += entry.bytes;
      trim();
    },
    () => drop(release.digest),
  );
  return entry.files;
}

async function loadBundle(
  release: { digest: string; location: string },
  deps: KthxDeps,
): Promise<Uint8Array<ArrayBuffer>> {
  if (release.location.startsWith('upload://')) {
    const local = await readStagedArchive(release.digest);
    if (local === null) {
      throw new Error(`${release.location} is not on this disk any more`);
    }
    return new Uint8Array(local);
  }
  const depot = await deps.depot();
  const url = await fetchableBundleUrl(release.location, depot?.federation);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${release.location} answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// --- a site -----------------------------------------------------------------

async function siteResponse(
  request: Request,
  name: string,
  deps: KthxDeps,
  server: Bun.Server<unknown> | undefined,
): Promise<Response | undefined> {
  const [row] = await deps.db
    .select({
      deletedAt: kthxSites.deletedAt,
      digest: kthxReleases.digest,
      location: kthxReleases.location,
    })
    .from(kthxSites)
    .leftJoin(
      kthxReleases,
      and(
        eq(kthxReleases.site, kthxSites.name),
        eq(kthxReleases.n, kthxSites.serving),
      ),
    )
    .where(eq(kthxSites.name, name))
    .limit(1);
  if (row === undefined) return notHere(request, deps.zone, 404);
  if (row.deletedAt !== null) return notHere(request, deps.zone, 410);

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return notHere(request, deps.zone, 404);
  }
  // `/_/` is kthx's on every site — `data.ts` answers it, a bundle file under
  // it is never served, and a claimed name has a `db` before it has a release.
  if (pathname === '/_' || pathname.startsWith('/_/')) {
    const answered = await underscoreResponse(
      request,
      pathname,
      name,
      deps,
      server,
    );
    return answered === null ? notHere(request, deps.zone, 404) : answered;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed\n', { status: 405 });
  }
  if (row.digest === null || row.location === null) {
    return notHere(request, deps.zone, 404);
  }

  let files: SiteFiles;
  try {
    files = await filesFor(
      { digest: row.digest, location: row.location },
      deps,
    );
  } catch {
    return notHere(request, deps.zone, 503);
  }

  const path = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const found =
    files.get(path) ??
    (path.endsWith('/index.html')
      ? undefined
      : files.get(`${path}/index.html`));
  if (found !== undefined) return file(request, row.digest, path, found, 200);

  // Before `404.html`, because a whole HTML error page is not an icon. A
  // bundle that ships its own `/favicon.ico` was found above and never
  // reaches this.
  if (path === FAVICON_PATH) return faviconResponse(request);

  const fallback = files.get('/404.html');
  if (fallback !== undefined) {
    return file(request, row.digest, '/404.html', fallback, 404);
  }
  return notHere(request, deps.zone, 404);
}

function file(
  request: Request,
  digest: string,
  path: string,
  found: SiteFile,
  status: number,
): Response {
  const etag = `"${digest}:${path}"`;
  const headers = {
    etag,
    'content-type': found.type,
    'cache-control': 'public, max-age=60',
    'x-content-type-options': 'nosniff',
  };
  // ponytail: exact match only, so a weak or multi-valued `if-none-match`
  // refetches the body. Parse per RFC 9110 if an intermediary ever sends one.
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : found.bytes, {
    status,
    headers,
  });
}

function faviconResponse(request: Request): Response {
  return file(request, FAVICON_DIGEST, FAVICON_PATH, FAVICON, 200);
}

// --- the page for a name nothing answers ----------------------------------

const SAID: Record<number, string> = {
  404: 'No site here yet.',
  410: 'This site is gone.',
  503: 'This site is not available right now.',
};

/**
 * One line, the palette of the landing page, and a way back to the apex.
 *
 * `no-store`, unlike a site's own `404.html`: this page describes a name's
 * state, and the state changes the moment somebody uploads.
 */
function notHere(
  request: Request,
  zone: string,
  status: 404 | 410 | 503,
): Response {
  const host = request.headers.get('host') ?? '';
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${Bun.escapeHTML(host)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0716; color: #f7f0fc; font: 16px/1.55 "DM Sans", system-ui, sans-serif; }
main { max-width: 34rem; padding: 2rem; text-align: center; }
h1 { font-size: 1.25rem; font-weight: 500; margin: 0 0 .5rem; }
code { font-family: "DM Mono", ui-monospace, monospace; color: #cdb9dd; }
a { color: #ff3fb5; }
</style>
</head>
<body>
<main>
<h1>${SAID[status]}</h1>
<p><code>${Bun.escapeHTML(host)}</code></p>
<p><a href="${kthxUrl(request, zone)}/">${Bun.escapeHTML(zone)}</a></p>
</main>
</body>
</html>
`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
