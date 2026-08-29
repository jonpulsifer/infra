/**
 * `kthx dev`: the directory on :4321, resolved the way a site is in
 * production, with a `/_/` that keeps every key, cookie, and room in this
 * process. The SDK is the real one; nothing leaves the machine.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import sdk from '../../spindrift/src/kthx/sdk.js' with { type: 'text' };
import { included } from './tar.ts';

export const PORT = 4321;
const MAX_KEY_CHARS = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_LIST = 500;
const MAX_ROOM_CHARS = 128;
const ME_COOKIE = 'kthx_me';
const UUID = /^[0-9a-f-]{36}$/;

interface SocketData {
  readonly me: string;
  readonly rooms: Set<string>;
}

type Socket = Bun.ServerWebSocket<SocketData>;

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

export function dev(dir = '.', port = PORT): Bun.Server<SocketData> {
  const root = resolve(dir);
  const store = new Map<string, { text: string; etag: string }>();
  /** Room topic → peer id → how many of that peer's sockets are in the room. */
  const presence = new Map<string, Map<string, number>>();

  const server = Bun.serve<SocketData>({
    port,
    async fetch(request, server) {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return refuse(404, 'NOT_FOUND', 'that is not a path');
      }
      if (pathname.startsWith('/_/')) {
        return (
          underscore(request, pathname, server) ??
          refuse(404, 'NOT_FOUND', `nothing of kthx's is at ${pathname}`)
        );
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed\n', { status: 405 });
      }
      return file(root, pathname, request.method);
    },
    websocket: {
      message(socket, raw) {
        let frame: unknown;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof frame !== 'object' || frame === null) return;
        const { t, room, data } = frame as Record<string, unknown>;
        if (t === 'watch') {
          socket.subscribe('db');
          return;
        }
        if (
          typeof room !== 'string' ||
          room.length === 0 ||
          room.length > MAX_ROOM_CHARS
        ) {
          return;
        }
        if (t === 'join') joinRoom(socket, room);
        else if (t === 'leave') leaveRoom(socket, room);
        else if (t === 'send' && socket.data.rooms.has(room)) {
          socket.publish(
            `room:${room}`,
            JSON.stringify({ t: 'msg', room, from: socket.data.me, data }),
          );
        }
      },
      close(socket) {
        for (const room of socket.data.rooms) leaveRoom(socket, room);
      },
    },
  });

  function underscore(
    request: Request,
    pathname: string,
    server: Bun.Server<SocketData>,
  ): Response | Promise<Response> | undefined | null {
    if (pathname === '/_/sdk.js') {
      return new Response(sdk, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (pathname === '/_/me') {
      const me = meOf(request);
      return Response.json(
        { id: me.id },
        { headers: { ...me.headers, 'cache-control': 'no-store' } },
      );
    }
    if (pathname === '/_/ws') {
      const me = meOf(request);
      const data: SocketData = { me: me.id, rooms: new Set() };
      return server.upgrade(request, {
        data,
        headers: new Headers(me.headers),
      })
        ? undefined
        : refuse(400, 'MALFORMED_REQUEST', 'WebSocket upgrade failed');
    }
    if (pathname === '/_/db') return list(request);
    if (pathname.startsWith('/_/db/')) {
      return kv(request, pathname.slice('/_/db/'.length), server);
    }
    return null;
  }

  function list(request: Request): Response {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refuse(405, 'METHOD_NOT_ALLOWED', '/_/db is read with GET');
    }
    const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
    const items = [...store]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_LIST)
      .map(([key, { text }]) => ({ key, value: JSON.parse(text) as unknown }));
    return Response.json(
      { items },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  async function kv(
    request: Request,
    key: string,
    server: Bun.Server<SocketData>,
  ): Promise<Response> {
    if (key.length === 0 || key.length > MAX_KEY_CHARS) {
      return refuse(
        400,
        'INVALID_KEY',
        `a key is 1 to ${MAX_KEY_CHARS} characters`,
      );
    }
    const row = store.get(key);
    switch (request.method) {
      case 'GET':
      case 'HEAD': {
        if (row === undefined) {
          return refuse(404, 'NOT_FOUND', `no ${key} here`);
        }
        return new Response(request.method === 'HEAD' ? null : row.text, {
          headers: {
            etag: row.etag,
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        });
      }
      case 'PUT': {
        let value: unknown;
        try {
          value = JSON.parse(await request.text());
        } catch {
          return refuse(400, 'INVALID_VALUE', 'the body is not JSON');
        }
        if (value === null) {
          return refuse(
            400,
            'INVALID_VALUE',
            'a value is not null; DELETE removes a key',
          );
        }
        const text = canonical(value);
        if (Buffer.byteLength(text) > MAX_VALUE_BYTES) {
          return refuse(
            413,
            'TOO_LARGE',
            `a value is at most ${MAX_VALUE_BYTES / 1024} KiB`,
          );
        }
        const expected = request.headers.get('if-match');
        const stale =
          expected !== null
            ? row?.etag !== expected
            : request.headers.get('if-none-match') === '*' && row !== undefined;
        if (stale) {
          return refuse(
            412,
            'PRECONDITION_FAILED',
            `${key} changed since it was read`,
          );
        }
        const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
        store.set(key, { text, etag });
        server.publish('db', JSON.stringify({ t: 'put', key, value }));
        return Response.json({ key, value }, { headers: { etag } });
      }
      case 'DELETE': {
        store.delete(key);
        server.publish('db', JSON.stringify({ t: 'del', key }));
        return new Response(null, { status: 204 });
      }
      default:
        return refuse(
          405,
          'METHOD_NOT_ALLOWED',
          'a key is read with GET, written with PUT, removed with DELETE',
        );
    }
  }

  function joinRoom(socket: Socket, room: string): void {
    const topic = `room:${room}`;
    const peers = presence.get(topic) ?? new Map<string, number>();
    presence.set(topic, peers);
    const { me, rooms } = socket.data;
    if (!rooms.has(room)) {
      rooms.add(room);
      socket.subscribe(topic);
      const count = (peers.get(me) ?? 0) + 1;
      peers.set(me, count);
      if (count === 1) {
        socket.publish(topic, JSON.stringify({ t: 'join', room, peer: me }));
      }
    }
    socket.send(JSON.stringify({ t: 'peers', room, peers: [...peers.keys()] }));
  }

  function leaveRoom(socket: Socket, room: string): void {
    const { me, rooms } = socket.data;
    if (!rooms.delete(room)) return;
    const topic = `room:${room}`;
    socket.unsubscribe(topic);
    const peers = presence.get(topic);
    if (peers === undefined) return;
    const count = (peers.get(me) ?? 1) - 1;
    if (count > 0) {
      peers.set(me, count);
      return;
    }
    peers.delete(me);
    if (peers.size === 0) presence.delete(topic);
    socket.publish(topic, JSON.stringify({ t: 'leave', room, peer: me }));
  }

  console.log(
    `  serves ${dir} on http://localhost:${server.port} — sdk in local mode, data stays on this machine`,
  );
  return server;
}

// --- files ------------------------------------------------------------------

/** The bytes at `pathname`: `/dir` is `dir/index.html`, missing is `404.html`. */
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

// --- me ---------------------------------------------------------------------

/** Who this browser is, and the header that makes it so if it was not yet. */
function meOf(request: Request): {
  readonly id: string;
  readonly headers: Record<string, string>;
} {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name === ME_COOKIE && UUID.test(value))
      return { id: value, headers: {} };
  }
  const id = crypto.randomUUID();
  // No `Secure`: this is plain http on localhost.
  return {
    id,
    headers: {
      'set-cookie': `${ME_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    },
  };
}

/** JSON with object keys sorted, so equal values hash equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}
