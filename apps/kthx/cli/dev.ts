/**
 * `kthx dev`: the directory on :4321, resolved the way a release is, with
 * `/api/*` and `/files/*` proxied to the site's own host.
 *
 * The backends are not simulated. A local copy of the documents plane would be
 * a second implementation of the contract to keep honest, and it would answer
 * differently from the site the moment either drifted — so this proxies, and
 * what a page sees here is what it sees in production, live database included.
 *
 * Two things have to be rewritten on the way through, both because the loop is
 * `http://localhost` and the site is `https://<name>.kthx.dev`: the `Origin`
 * header, which the server compares against its own host, and the visitor
 * cookie, whose `__Host-` prefix and `Secure` attribute a browser refuses over
 * plain HTTP.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ME_COOKIE } from '../server/me.ts';
import { decodePath, notHere, staticResponse } from '../server/serve.ts';
import { included } from './tar.ts';

export const PORT = 4321;

/** The cookie name a browser will keep over `http://localhost`. */
const DEV_COOKIE = 'kthx_me';

/** Paths a site never serves from its bundle; the site host answers them. */
const RESERVED = ['api', 'files', '_'];

export interface Site {
  /** The claimed name. */
  readonly name: string;
  /** The bearer, attached to owner-scoped calls and to nothing else. */
  readonly token: string;
  /** `https://<name>.kthx.dev` — where `/api` and `/files` really are. */
  readonly site: string;
}

/**
 * Both ends of one proxied socket, and the frames waiting on the slower of
 * them. Neither end is ready when the other might already be talking: the site
 * can answer before Bun hands over the tab's socket, and the tab can send
 * before the site's connection is up.
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
    // A proxied upload or model call takes as long as the site takes.
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
      // What a release carries, not what the working directory holds: `.env`,
      // `kthx.json` and `node_modules` are excluded from an upload, so they are
      // not on the loop either.
      if (!included(path.slice(1))) {
        return notHere('localhost', 'kthx.dev', 404, 'dev');
      }
      const answered = await staticResponse(request, root, 'dev', path);
      if (answered === null)
        return notHere('localhost', 'kthx.dev', 404, 'dev');
      // A release is immutable and a working directory is not, so nothing here
      // may be cached or revalidated against an etag that means yesterday.
      answered.headers.delete('etag');
      answered.headers.set('cache-control', 'no-store');
      return answered;
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
  return server;
}

const reserved = (path: string): boolean =>
  RESERVED.some((head) => path === `/${head}` || path.startsWith(`/${head}/`));

// --- the proxy --------------------------------------------------------------

/** Headers a hop owns, plus the encoding this hop has already undone. */
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

/**
 * The owner bearer opens exactly two things on a site host. Everywhere else a
 * page is a visitor, and sending the token would give the loop a quieter rate
 * limit than production — the one difference `kthx dev` must not have.
 */
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
  if (headers.has('origin')) headers.set('origin', site.site);
  const cookie = headers.get('cookie');
  if (cookie !== null) headers.set('cookie', toSite(cookie));
  if (ownerScoped(request.method, path)) {
    headers.set('authorization', `Bearer ${site.token}`);
  }

  const answer = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    // A streamed body needs the half-duplex opt-out; an upload is one.
    duplex: 'half',
  } as RequestInit).catch((cause: Error) =>
    Response.json(
      { code: 'UNREACHABLE', message: `${site.site}: ${cause.message}` },
      { status: 502 },
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

/** `kthx_me=…` on the way up becomes the cookie the server signs and reads. */
const toSite = (cookie: string): string =>
  cookie.replace(new RegExp(`(^|;\\s*)${DEV_COOKIE}=`), `$1${ME_COOKIE}=`);

/**
 * `__Host-` and `Secure` on the way back: a browser silently drops both over
 * `http://localhost`, and a visitor id that never sticks is a visitor id that
 * changes on every request.
 */
const toLoop = (value: string): string =>
  value.replace(`${ME_COOKIE}=`, `${DEV_COOKIE}=`).replace(/;\s*Secure/gi, '');

// --- the socket -------------------------------------------------------------

function upgrade(
  request: Request,
  server: Bun.Server<SocketData>,
  site: Site,
): Response | undefined {
  const target = new URL(site.site);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/api/ws';

  const headers: Record<string, string> = { origin: site.site };
  const cookie = request.headers.get('cookie');
  if (cookie !== null) headers.cookie = toSite(cookie);

  const upstream = new WebSocket(target, { headers } as never);
  // Attached now rather than in `open`: on the loop the site can answer before
  // Bun hands this process the tab's socket, and a handler set after that has
  // already missed the frame.
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

/** Every frame the site sent while the tab was still being handed over. */
function pipe(socket: Bun.ServerWebSocket<SocketData>): void {
  socket.data.tab = socket;
  for (const frame of socket.data.inbound.splice(0)) socket.send(frame);
  if (socket.data.closed) socket.close();
}

// --- files ------------------------------------------------------------------

/** A lone top-level directory is the site, as a release's unpack reads one. */
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
