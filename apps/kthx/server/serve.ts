/**
 * The bytes a site answers with, read off the volume.
 *
 * Resolution is the contract's list and nothing more: the exact file, an
 * `index.html` or `200.html` for a directory, the generic favicon, then the
 * SPA fallback at 200 and the site's own `404.html` at 404. Everything is
 * `lstat`ed and everything is checked to still be under the release root — the
 * archive reader has already refused a `..`, and this refuses one that arrives
 * in a URL.
 */
import { lstat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { FAVICON, FAVICON_DIGEST, FAVICON_PATH } from '@repo/kthx/favicon';
import { siteUrl } from './http.ts';

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

export function typeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

/** The decoded pathname, or `null` for one that cannot address a file. */
export function decodePath(url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname.split('/').includes('..')) return null;
  return pathname;
}

/** The one regular file at this path under the root, or `null`. */
export async function fileAt(
  root: string,
  path: string,
): Promise<string | null> {
  const resolved = normalize(join(root, path));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return null;
  try {
    // `lstat`, so a symlink is a miss rather than a way out of the release.
    if (!(await lstat(resolved)).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/**
 * A file from `<sitesDir>/<name>/<serving>/`, or `null` for the kthx 404 page.
 *
 * The contract's order, first hit wins. The generic favicon sits after the
 * release's own files and before the fallbacks: a bundle that ships an icon
 * wins, and a whole HTML error page is not an icon.
 */
export async function staticResponse(
  request: Request,
  root: string,
  digest: string,
  path: string,
): Promise<Response | null> {
  const tries = path.endsWith('/')
    ? [`${path}index.html`, `${path}200.html`]
    : [path, `${path}/index.html`];
  for (const candidate of tries) {
    const file = await fileAt(root, candidate);
    if (file !== null) return served(request, digest, candidate, file, 200);
  }
  if (path === FAVICON_PATH) return faviconResponse(request);

  const spa = await fileAt(root, '/200.html');
  if (spa !== null) return served(request, digest, '/200.html', spa, 200);
  const own = await fileAt(root, '/404.html');
  if (own !== null) return served(request, digest, '/404.html', own, 404);
  return null;
}

function served(
  request: Request,
  digest: string,
  path: string,
  file: string,
  status: number,
): Response {
  const bytes = Bun.file(file);
  return fileResponse(request, digest, path, {
    body: bytes,
    size: bytes.size,
    type: typeOf(path),
    status,
  });
}

interface Body {
  readonly body: Bun.BunFile | Uint8Array;
  readonly size: number;
  readonly type: string;
  readonly status: number;
}

function fileResponse(
  request: Request,
  digest: string,
  path: string,
  found: Body,
): Response {
  // Percent-encoded so the header stays ASCII and carries no quote of its own;
  // `/` is left alone because a path with slashes is still one token.
  const etag = `"${digest}:${encodeURIComponent(path).replaceAll('%2F', '/')}"`;
  const headers: Record<string, string> = {
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
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: found.status,
      headers: { ...headers, 'content-length': String(found.size) },
    });
  }
  return new Response(found.body as BodyInit, {
    status: found.status,
    headers,
  });
}

export function faviconResponse(request: Request): Response {
  return fileResponse(request, FAVICON_DIGEST, FAVICON_PATH, {
    body: FAVICON.bytes,
    size: FAVICON.bytes.byteLength,
    type: FAVICON.type,
    status: 200,
  });
}

// --- the page for a name nothing answers ------------------------------------

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
export function notHere(
  host: string,
  zone: string,
  status: 404 | 410 | 503,
  id: string,
  port = '',
): Response {
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
<p><a href="${siteUrl(zone, undefined, port)}/">${Bun.escapeHTML(zone)}</a></p>
</main>
</body>
</html>
`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': id,
    },
  });
}
