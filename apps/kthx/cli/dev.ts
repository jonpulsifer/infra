/**
 * `kthx dev`: the directory on :4321, resolved the way a site is in
 * production, with a `/_/` that keeps every key, cookie, and room in this
 * process. The contract is production's own (`underscore.ts`) over a Map;
 * the SDK is the real one; nothing leaves the machine.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  type KthxSocketData,
  type KthxStore,
  kthxSocket,
  MAX_LIST,
  underscoreResponse,
} from '@repo/kthx';
import { FAVICON, FAVICON_PATH } from '@repo/kthx/favicon';
import sdk from '@repo/kthx/sdk.js' with { type: 'text' };
import { included } from './tar.ts';

export const PORT = 4321;
const SITE = 'local';

export function dev(dir = '.', port = PORT): Bun.Server<KthxSocketData> {
  const root = unwrap(resolve(dir));
  const surface = { store: memory(), secure: false };

  const server = Bun.serve<KthxSocketData>({
    port,
    async fetch(request, server) {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return Response.json(
          { code: 'NOT_FOUND', message: 'that is not a path' },
          { status: 404 },
        );
      }
      if (pathname === '/_/sdk.js') {
        return new Response(sdk, {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        });
      }
      if (pathname === '/_' || pathname.startsWith('/_/')) {
        return (
          (await underscoreResponse(
            request,
            pathname,
            SITE,
            server,
            surface,
          )) ??
          Response.json(
            {
              code: 'NOT_FOUND',
              message: `nothing of kthx's is at ${pathname}`,
            },
            { status: 404 },
          )
        );
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed\n', { status: 405 });
      }
      return file(root, pathname, request.method);
    },
    websocket: {
      message: (socket, raw) => kthxSocket.message(socket, socket.data, raw),
      close: (socket) => kthxSocket.close(socket, socket.data),
    },
  });

  console.log(
    `  serves ${dir === '.' ? './' : dir} on http://localhost:${server.port} — sdk in local mode, data stays on this machine`,
  );
  return server;
}

/** A site's `db`, in this process, gone when it exits. */
function memory(): KthxStore {
  const rows = new Map<string, { text: string; etag: string }>();
  return {
    async list(prefix) {
      return [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_LIST)
        .map(([key, { text }]) => ({ key, text }));
    },
    async get(key) {
      return rows.get(key);
    },
    async put(key, _value, text, etag, { ifMatch, ifNoneMatch }) {
      const row = rows.get(key);
      const stale =
        ifMatch !== null
          ? ifMatch === '*'
            ? row === undefined
            : row?.etag !== ifMatch
          : ifNoneMatch && row !== undefined;
      if (stale) {
        return false;
      }
      rows.set(key, { text, etag });
      return true;
    },
    async del(key) {
      rows.delete(key);
    },
  };
}

// --- files ------------------------------------------------------------------

/** A lone top-level directory is the site, as `siteFiles` reads an upload. */
function unwrap(root: string): string {
  const entries = readdirSync(root).filter(included);
  const [only] = entries;
  return entries.length === 1 && only !== undefined && isDir(join(root, only))
    ? join(root, only)
    : root;
}

/**
 * The bytes at `pathname`: `/dir` is `dir/index.html`, missing is `404.html`.
 * A directory with no icon answers the generic favicon, as production does.
 */
function file(root: string, pathname: string, method: string): Response {
  const path = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const candidates = path.endsWith('/index.html')
    ? [path]
    : [path, `${path}/index.html`];
  for (const candidate of candidates) {
    const full = resolve(root, `.${candidate}`);
    const relative = full.slice(root.length + 1).replaceAll(sep, '/');
    if (!full.startsWith(root + sep) || !included(relative)) continue;
    if (isFile(full)) return serve(full, 200, method);
  }
  if (path === FAVICON_PATH) {
    return new Response(method === 'HEAD' ? null : FAVICON.bytes, {
      headers: { 'content-type': FAVICON.type, 'cache-control': 'no-store' },
    });
  }
  const fallback = join(root, '404.html');
  if (isFile(fallback)) return serve(fallback, 404, method);
  return new Response('No site here yet.\n', { status: 404 });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function serve(path: string, status: number, method: string): Response {
  const found = Bun.file(path);
  return new Response(method === 'HEAD' ? null : found, {
    status,
    headers: {
      'content-type': found.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
