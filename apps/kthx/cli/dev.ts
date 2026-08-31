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
 * plain HTTP. Only that one cookie goes up — `localhost` holds whatever every
 * other local server has ever set, and none of it belongs on the internet.
 *
 * One thing the loop cannot reproduce: Bun hands over the tab's socket before
 * the site has answered the upgrade, so a site that refuses one — a rate limit
 * — reaches the page as an open that closes, not as the status it sent.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ME_COOKIE } from '../server/me.ts';
import { decodePath, notHere, staticResponse } from '../server/serve.ts';
import { REACH_MS, reach, SEND_MS, seconds, timedOut } from './reach.ts';
import { included } from './tar.ts';

export const PORT = 4321;

/** The cookie name a browser will keep over `http://localhost`. */
const DEV_COOKIE = 'kthx_me';

/** Paths a site never serves from its bundle; the site host answers them. */
const RESERVED = ['api', 'files', '_'];

export interface Site {
  /** The claimed name. */
  readonly name: string;
  /**
   * The bearer, attached to owner-scoped calls and to nothing else. Absent on a
   * machine that never claimed the name — the loop still serves the files and
   * still proxies everything a visitor may call.
   */
  readonly token?: string | undefined;
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
  /** Why the site's end went, when there is more to say than "it closed". */
  why: string | null;
}

export function dev(
  dir: string,
  site: Site,
  port = PORT,
  /** How long the site gets to answer before the loop stops waiting on it. */
  deadline = REACH_MS,
  /** The same, for a model call, which is answered when it is thought out. */
  send = SEND_MS,
): Bun.Server<SocketData> {
  const root = unwrap(resolve(dir));

  const server = Bun.serve<SocketData>({
    port,
    // The loop carries the site's owner bearer. A wildcard bind would hand
    // `POST /api/mcp` and `DELETE /api/db/:c` against the live site to anything
    // that can reach this port.
    hostname: '127.0.0.1',
    // A proxied upload or model call takes as long as the site takes.
    idleTimeout: 120,
    async fetch(request, server) {
      const path = decodePath(request.url);
      if (path === null) return notHere('localhost', 'kthx.dev', 404, 'dev');
      if (reserved(path)) {
        return path === '/api/ws'
          ? upgrade(request, server, site, deadline)
          : proxy(request, path, site, deadline, send);
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
  if (site.token === undefined) {
    console.log('  no token here — /api/mcp and DELETE /api/db/:c answer 401');
  }
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
  deadline: number,
  send: number,
): Promise<Response> {
  const target = new URL(request.url);
  const upstream = new URL(site.site);
  target.protocol = upstream.protocol;
  target.host = upstream.host;

  const headers = new Headers(request.headers);
  for (const header of HOP) headers.delete(header);
  // A proxy hands the bytes on; it does not negotiate an encoding of its own.
  headers.set('accept-encoding', 'identity');
  if (headers.has('origin')) headers.set('origin', site.site);
  const cookie = visitorCookie(headers.get('cookie'));
  if (cookie === null) headers.delete('cookie');
  else headers.set('cookie', cookie);
  if (site.token !== undefined && ownerScoped(request.method, path)) {
    headers.set('authorization', `Bearer ${site.token}`);
  }

  // A model call is answered when the model has finished thinking, which is
  // minutes on a long completion — the read bound would refuse work that is
  // going fine. Nothing else on the loop earns that patience: a document write
  // to a route that has gone dark should fail as fast as a read does.
  const bound = path.startsWith('/api/ai') ? send : deadline;
  const answer = await reach(
    target,
    {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      // A streamed body needs the half-duplex opt-out; an upload is one.
      duplex: 'half',
    } as RequestInit,
    bound,
    // The answer is handed to the tab as it arrives; how long the site means it
    // to be — a completion streamed token by token — is not this hop's call.
    true,
  ).catch((cause: Error) =>
    // A site that never answers is the loop's worst failure: nothing prints,
    // the tab spins, and the network is the last place anyone looks. Say so.
    timedOut(cause)
      ? Response.json(
          {
            code: 'UNREACHABLE',
            message: `${site.site} did not answer in ${seconds(bound)}`,
          },
          { status: 504, headers: { 'cache-control': 'no-store' } },
        )
      : Response.json(
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

/**
 * The one cookie that goes up: `kthx_me`, under the name the server signs and
 * reads. Cookies ignore ports, so a browser sends this loop every cookie any
 * other `localhost` server has ever set — none of which the site asked for.
 */
function visitorCookie(header: string | null): string | null {
  const value = header
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${DEV_COOKIE}=`))
    ?.slice(DEV_COOKIE.length + 1);
  return value === undefined || value === '' ? null : `${ME_COOKIE}=${value}`;
}

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
  deadline: number,
): Response | undefined {
  const target = new URL(site.site);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/api/ws';
  target.search = new URL(request.url).search;

  const headers: Record<string, string> = { origin: site.site };
  const cookie = visitorCookie(request.headers.get('cookie'));
  if (cookie !== null) headers.cookie = cookie;

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
    why: null,
  };
  // The same silence the proxy guards against, on the socket: an upgrade to a
  // site that has gone dark neither opens nor fails, and a tab left holding a
  // socket that does neither is the loop hanging by another name.
  const timer = setTimeout(() => {
    data.closed = true;
    // Kept on the data as well as sent: the tab's socket may not have been
    // handed over yet, and `pipe` closes it with this rather than with a bare
    // 1000, which would tell the page the site answered and then said goodbye.
    data.why = `${site.site} did not answer in ${seconds(deadline)}`;
    data.tab?.close(1013, data.why);
    upstream.close();
  }, deadline);
  upstream.onopen = () => {
    clearTimeout(timer);
    for (const frame of data.pending.splice(0)) upstream.send(frame);
  };
  upstream.onmessage = (event: MessageEvent) => {
    const frame = String(event.data);
    if (data.tab === null) data.inbound.push(frame);
    else data.tab.send(frame);
  };
  const gone = () => {
    clearTimeout(timer);
    data.closed = true;
    data.tab?.close();
  };
  upstream.onclose = gone;
  upstream.onerror = gone;
  if (server.upgrade(request, { data })) return undefined;

  clearTimeout(timer);
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
  if (!socket.data.closed) return;
  if (socket.data.why === null) socket.close();
  else socket.close(1013, socket.data.why);
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
