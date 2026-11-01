/**
 * `kthx dev`: serves a directory on :4321 as the site would be served, and
 * proxies `/api/*` and `/files/*` to the live site and its real database.
 */
import { readdirSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { ME_COOKIE } from '../server/me.ts';
import { contentType } from '../server/mime.ts';
import { decodePath, notHere } from '../server/pages.ts';
import { included } from './files.ts';

export const PORT = 4321;

/** A browser refuses a `__Host-` cookie over `http://localhost`. */
const DEV_COOKIE = 'kthx_me';

/** Paths a site never serves from its bundle; the site host answers them. */
const RESERVED = ['api', 'files', '_'];

export interface Site {
  readonly name: string;
  /**
   * The owner's ID token, sent on owner-scoped calls only. Absent, or
   * answering `null`, the loop is a visitor everywhere.
   */
  readonly authorization?: (() => Promise<string | null>) | undefined;
  /** `https://<name>.kthx.dev` */
  readonly site: string;
}

/**
 * Either end can talk first: the site can answer before Bun hands over the
 * tab's socket, and the tab can send before the upstream socket opens.
 */
interface SocketData {
  readonly upstream: WebSocket;
  /** Frames the tab sent before the upstream socket finished opening. */
  readonly pending: (string | Uint8Array)[];
  /** Frames the site sent before the tab's socket was handed over. */
  readonly inbound: string[];
  tab: Bun.ServerWebSocket<SocketData> | null;
  closed: boolean;
}

export function dev(
  dir: string,
  site: Site,
  port = PORT,
): Bun.Server<SocketData> {
  const root = unwrap(resolve(dir));

  const server = Bun.serve<SocketData>({
    port,
    // Loopback only: the loop sends the owner bearer to the live site.
    hostname: '127.0.0.1',
    // Seconds. A proxied upload or model call takes as long as the site takes.
    idleTimeout: 120,
    async fetch(request, server) {
      const path = decodePath(request.url);
      if (path === null) return notHere('localhost', 'kthx.dev', 404, 'dev');
      if (reserved(path)) {
        return path === '/api/ws'
          ? upgrade(request, server, site)
          : proxy(request, path, site);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json(
          {
            code: 'METHOD_NOT_ALLOWED',
            message: 'that is not something this path does',
          },
          { status: 405, headers: { 'cache-control': 'no-store' } },
        );
      }
      // Files a deploy excludes, such as `.env`, are hidden here too.
      if (!included(path.slice(1))) {
        return notHere('localhost', 'kthx.dev', 404, 'dev');
      }
      return (
        (await staticResponse(request, root, path)) ??
        notHere('localhost', 'kthx.dev', 404, 'dev')
      );
    },
    websocket: {
      open: pipe,
      message: (socket, raw) => {
        const { upstream, pending } = socket.data;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
        else pending.push(raw);
      },
      close: (socket) => socket.data.upstream.close(),
    },
  });

  console.log(
    `  serves ${dir === '.' ? './' : dir} on http://localhost:${server.port}`,
  );
  console.log(
    `  /api and /files go to ${site.site} — this is ${site.name}'s live database, not a copy`,
  );
  if (site.authorization === undefined) {
    console.log(
      '  no ID token here — /api/mcp and DELETE /api/db/:c answer 401',
    );
  }
  return server;
}

const reserved = (path: string): boolean =>
  RESERVED.some((head) => path === `/${head}` || path.startsWith(`/${head}/`));

/** Hop-by-hop headers, and the content encoding `fetch` has already decoded. */
const HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'content-encoding',
];

// Only these two carry the owner's ID token; elsewhere the loop is a visitor,
// so its rate limits match production.
function ownerScoped(method: string, path: string): boolean {
  return (
    path === '/api/mcp' ||
    (method === 'DELETE' && /^\/api\/db\/[^/]+$/.test(path))
  );
}

async function proxy(
  request: Request,
  path: string,
  site: Site,
): Promise<Response> {
  const target = new URL(request.url);
  const upstream = new URL(site.site);
  target.protocol = upstream.protocol;
  target.host = upstream.host;

  const headers = new Headers(request.headers);
  for (const header of HOP) headers.delete(header);
  // The server checks `Origin` against its own host.
  if (headers.has('origin')) headers.set('origin', site.site);
  const cookie = visitorCookie(headers.get('cookie'));
  if (cookie === null) headers.delete('cookie');
  else headers.set('cookie', cookie);
  const token =
    site.authorization !== undefined && ownerScoped(request.method, path)
      ? await site.authorization()
      : null;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);

  const answer = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    // fetch requires `duplex: 'half'` for a streamed request body.
    duplex: 'half',
  } as RequestInit).catch((cause: Error) =>
    Response.json(
      { code: 'UNREACHABLE', message: `${site.site}: ${cause.message}` },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    ),
  );

  const out = new Headers(answer.headers);
  for (const header of HOP) out.delete(header);
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) {
    out.delete('set-cookie');
    for (const value of cookies) out.append('set-cookie', toLoop(value));
  }
  return new Response(answer.body, { status: answer.status, headers: out });
}

// Only the visitor cookie goes up. Cookies ignore ports, so `localhost` also
// carries every other local server's cookies.
function visitorCookie(header: string | null): string | null {
  const value = header
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${DEV_COOKIE}=`))
    ?.slice(DEV_COOKIE.length + 1);
  return value === undefined || value === '' ? null : `${ME_COOKIE}=${value}`;
}

// A browser drops `__Host-` and `Secure` cookies over `http://localhost`, which
// would mint a new visitor id on every request.
const toLoop = (value: string): string =>
  value.replace(`${ME_COOKIE}=`, `${DEV_COOKIE}=`).replace(/;\s*Secure/gi, '');

// Bun hands over the tab's socket before the site answers, so a refused upgrade
// (a rate limit) reaches the page as an open that closes.
function upgrade(
  request: Request,
  server: Bun.Server<SocketData>,
  site: Site,
): Response | undefined {
  const target = new URL(site.site);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/api/ws';
  target.search = new URL(request.url).search;

  const headers: Record<string, string> = { origin: site.site };
  const cookie = visitorCookie(request.headers.get('cookie'));
  if (cookie !== null) headers.cookie = cookie;

  const upstream = new WebSocket(target, { headers } as never);
  // Handlers attach before the upgrade, because the site can send a frame before
  // Bun hands over the tab's socket.
  const data: SocketData = {
    upstream,
    pending: [],
    inbound: [],
    tab: null,
    closed: false,
  };
  upstream.onopen = () => {
    for (const frame of data.pending.splice(0)) upstream.send(frame);
  };
  upstream.onmessage = (event: MessageEvent) => {
    const frame = String(event.data);
    if (data.tab === null) data.inbound.push(frame);
    else data.tab.send(frame);
  };
  const gone = () => {
    data.closed = true;
    data.tab?.close();
  };
  upstream.onclose = gone;
  upstream.onerror = gone;
  if (server.upgrade(request, { data })) return undefined;

  upstream.close();
  return Response.json(
    {
      code: 'MALFORMED_REQUEST',
      message: 'the request body or content type is not what this path takes',
    },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

/** Flushes frames the site sent while the tab's socket was being handed over. */
function pipe(socket: Bun.ServerWebSocket<SocketData>): void {
  socket.data.tab = socket;
  for (const frame of socket.data.inbound.splice(0)) socket.send(frame);
  if (socket.data.closed) socket.close();
}

/**
 * The nginx contract: the path, then `<path>/index.html`, then the site's own
 * `404.html` with a 404. `null` is the kthx 404 page. Nothing is cached: the
 * working directory changes under the loop.
 */
async function staticResponse(
  request: Request,
  root: string,
  path: string,
): Promise<Response | null> {
  const tries = path.endsWith('/')
    ? [`${path}index.html`]
    : [path, `${path}/index.html`];
  for (const candidate of tries) {
    const file = await fileAt(root, candidate);
    if (file !== null) return served(request, candidate, file, 200);
  }
  const own = await fileAt(root, '/404.html');
  return own === null ? null : served(request, '/404.html', own, 404);
}

function served(
  request: Request,
  path: string,
  file: string,
  status: number,
): Response {
  const bytes = Bun.file(file);
  const headers = {
    'content-type': contentType(path),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (request.method === 'HEAD') {
    return new Response(null, {
      status,
      headers: { ...headers, 'content-length': String(bytes.size) },
    });
  }
  return new Response(bytes, { status, headers });
}

async function fileAt(root: string, path: string): Promise<string | null> {
  const resolved = normalize(join(root, path));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return null;
  try {
    // `lstat`: a symlink is a miss, never a way out of the directory.
    if (!(await lstat(resolved)).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/** A lone top-level directory is the site root, as a deploy reads it. */
function unwrap(root: string): string {
  const entries = readdirSync(root).filter(included);
  const [only] = entries;
  return entries.length === 1 && only !== undefined && isDir(join(root, only))
    ? join(root, only)
    : root;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
