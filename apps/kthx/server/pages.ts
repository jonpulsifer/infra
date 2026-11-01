/**
 * The pages this process answers itself: the 404, 410 and 503 page any host
 * can get, the icon, and the decoded path every route reads. nginx serves a
 * site's own files.
 */
import { FAVICON, FAVICON_DIGEST, FAVICON_PATH } from '@repo/kthx/favicon';
import { siteUrl } from './http.ts';

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

export function faviconResponse(request: Request): Response {
  const etag = `"${FAVICON_DIGEST}:${FAVICON_PATH}"`;
  const headers: Record<string, string> = {
    etag,
    'content-type': FAVICON.type,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    return new Response(null, {
      headers: {
        ...headers,
        'content-length': String(FAVICON.bytes.byteLength),
      },
    });
  }
  return new Response(FAVICON.bytes as unknown as BodyInit, { headers });
}

const SAID: Record<number, string> = {
  404: 'No site here yet.',
  410: 'This site is gone.',
  503: 'This site is not available right now.',
};

/** `no-store`: a name's state changes the moment somebody deploys. */
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
