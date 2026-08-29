/**
 * kthx: the `/_/` surface every site has, without the database. `db` is JSON
 * by key over a `KthxStore` the caller supplies — Postgres in production,
 * a Map under `kthx dev` — `me` is a cookie that says which browser this is,
 * and `ws` is the one socket a tab opens for store watches and rooms.
 *
 * There is no login. Anyone on a site's origin reads and writes its keys,
 * artifacts-style; `me` is an anonymous id a poll can remember a vote by.
 * A write is one statement the store decides — `if-match` on the stored
 * etag, `if-none-match: *` on there being no row — so two tabs racing on a
 * key cannot both win, and the SDK's `update` is a loop over that.
 *
 * Fan-out is Bun's own pub/sub. Every store write on a site is published to
 * the site's one `db` topic and the SDK keeps the key-or-prefix filter, which
 * is the smallest thing that is right for both kinds of watch at once; a room
 * is a topic of its own that `send` publishes to, sender excluded.
 */
import { createHash } from 'node:crypto';

export const MAX_KEY_CHARS = 256;
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_LIST = 500;
/**
 * Keys one site may hold. Nobody signs in to write, so this is what stands
 * between a visitor's `for` loop and the control plane's disk: at most
 * `MAX_KEYS * MAX_VALUE_BYTES` — 64 MiB — per claimed name. Only a write that
 * adds a row is refused; overwriting and deleting keep working at the ceiling.
 *
 * ponytail: rows, not bytes, and per site rather than over the whole store.
 * A running byte total per site is the upgrade path when a legitimate site
 * gets near it, or when the count of sites is what needs bounding.
 */
export const MAX_KEYS = 1000;
const MAX_ROOM_CHARS = 128;
// ponytail: flat per-socket ceilings; per-site quotas when a site outgrows them.
const MAX_ROOMS = 32;
const MAX_FRAME_BYTES = 16 * 1024;

/** What a site's `db` keeps: JSON text by key, each with the etag of that text. */
export interface KthxStore {
  list(prefix: string): Promise<readonly { key: string; text: string }[]>;
  get(key: string): Promise<{ text: string; etag: string } | undefined>;
  /**
   * Writes when the precondition holds — `ifMatch` against the stored etag
   * (`*` against there being any row), `ifNoneMatch` against there being no
   * row — and says what happened: `stale` is a precondition the store
   * refused, `full` is a new key the site has no room for. The two are
   * different answers, so they cannot share one `false`.
   */
  put(
    key: string,
    value: unknown,
    text: string,
    etag: string,
    precondition: { ifMatch: string | null; ifNoneMatch: boolean },
  ): Promise<'written' | 'stale' | 'full'>;
  del(key: string): Promise<void>;
}

export interface KthxSurface {
  readonly store: KthxStore;
  /** Off under `kthx dev`, which is plain http on localhost. */
  readonly secure?: boolean;
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

/**
 * What a site answers under `/_/` (`/_/sdk.js` aside), given the decoded
 * path: `undefined` once the socket is Bun's, `null` for a path that is
 * nothing of kthx's.
 */
export function underscoreResponse(
  request: Request,
  pathname: string,
  site: string,
  server: Bun.Server<unknown> | undefined,
  surface: KthxSurface,
): Response | null | undefined | Promise<Response | undefined> {
  const secure = surface.secure ?? true;
  if (pathname === '/_/me') {
    const me = meOf(request, secure);
    return Response.json(
      { id: me.id },
      { headers: { ...me.headers, 'cache-control': 'no-store' } },
    );
  }
  if (pathname === '/_/ws') return upgrade(request, site, server, secure);
  if (pathname === '/_/db') return list(request, surface.store);
  if (pathname.startsWith('/_/db/')) {
    const key = pathname.slice('/_/db/'.length);
    return kv(request, key, site, surface.store, server);
  }
  return null;
}

// --- me ---------------------------------------------------------------------

const ME_COOKIE = 'kthx_me';
const ME_LIFETIME_S = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f-]{36}$/;

/** Who this browser is on this site, and the header that makes it so if it was not yet. */
function meOf(
  request: Request,
  secure: boolean,
): {
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
  return {
    id,
    headers: {
      'set-cookie': `${ME_COOKIE}=${id}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${ME_LIFETIME_S}`,
    },
  };
}

// --- db ---------------------------------------------------------------------

/** JSON with object keys sorted, so equal values hash equal. */
export function canonical(value: unknown): string {
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

const dbTopic = (site: string) => `kthx:${site}:db`;

async function list(request: Request, store: KthxStore): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse(405, 'METHOD_NOT_ALLOWED', '/_/db is read with GET');
  }
  const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
  if (prefix.includes('\0')) {
    return refuse(400, 'INVALID_KEY', 'a prefix has no NUL');
  }
  const items = (await store.list(prefix)).map((row) => ({
    key: row.key,
    value: JSON.parse(row.text) as unknown,
  }));
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}

async function kv(
  request: Request,
  key: string,
  site: string,
  store: KthxStore,
  server: Bun.Server<unknown> | undefined,
): Promise<Response> {
  if (key.length === 0 || key.length > MAX_KEY_CHARS || key.includes('\0')) {
    return refuse(
      400,
      'INVALID_KEY',
      `a key is 1 to ${MAX_KEY_CHARS} characters, none of them NUL`,
    );
  }
  switch (request.method) {
    case 'GET':
    case 'HEAD': {
      const row = await store.get(key);
      if (row === undefined) return refuse(404, 'NOT_FOUND', `no ${key} here`);
      return new Response(request.method === 'HEAD' ? null : row.text, {
        headers: {
          etag: row.etag,
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
    }
    case 'PUT': {
      const tooLarge = refuse(
        413,
        'TOO_LARGE',
        `a value is at most ${MAX_VALUE_BYTES / 1024} KiB`,
      );
      // Canonical JSON only drops whitespace, so a body over twice the cap
      // cannot fit under it; refusing here keeps a huge body out of the parser.
      if (Number(request.headers.get('content-length')) > 2 * MAX_VALUE_BYTES) {
        return tooLarge;
      }
      const body = await request.text();
      if (Buffer.byteLength(body) > 2 * MAX_VALUE_BYTES) return tooLarge;
      let value: unknown;
      let text: string;
      try {
        value = JSON.parse(body);
        text = canonical(value);
      } catch {
        return refuse(400, 'INVALID_VALUE', 'the body is not JSON');
      }
      if (text === 'null') {
        return refuse(
          400,
          'INVALID_VALUE',
          'a value is not null; DELETE removes a key',
        );
      }
      // jsonb has no NUL; `JSON.stringify` writes one as an unescaped `\u0000`.
      if (/(^|[^\\])(\\\\)*\\u0000/.test(text)) {
        return refuse(400, 'INVALID_VALUE', 'a value has no NUL');
      }
      if (Buffer.byteLength(text) > MAX_VALUE_BYTES) return tooLarge;
      const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
      const written = await store.put(key, value, text, etag, {
        ifMatch: request.headers.get('if-match'),
        ifNoneMatch: request.headers.get('if-none-match') === '*',
      });
      if (written === 'stale') {
        return refuse(
          412,
          'PRECONDITION_FAILED',
          `${key} changed since it was read`,
        );
      }
      if (written === 'full') {
        return refuse(
          507,
          'SITE_FULL',
          `this site holds ${MAX_KEYS} keys; delete one to add another`,
        );
      }
      server?.publish(dbTopic(site), JSON.stringify({ t: 'put', key, value }));
      return Response.json({ key, value }, { headers: { etag } });
    }
    case 'DELETE': {
      await store.del(key);
      server?.publish(dbTopic(site), JSON.stringify({ t: 'del', key }));
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

// --- ws ---------------------------------------------------------------------

export interface KthxSocketData {
  readonly kind: 'kthx';
  readonly site: string;
  /** The `kthx_me` id, which is what a room shows the others. */
  readonly me: string;
  /** The rooms this socket is in, so `close` can leave them. */
  readonly rooms: Set<string>;
}

function upgrade(
  request: Request,
  site: string,
  server: Bun.Server<unknown> | undefined,
  secure: boolean,
): Response | undefined {
  const me = meOf(request, secure);
  const data: KthxSocketData = {
    kind: 'kthx',
    site,
    me: me.id,
    rooms: new Set(),
  };
  const upgraded =
    server?.upgrade(request, { data, headers: new Headers(me.headers) }) ??
    false;
  return upgraded
    ? undefined
    : refuse(400, 'MALFORMED_REQUEST', 'WebSocket upgrade failed');
}

const roomTopic = (site: string, room: string) => `kthx:${site}:room:${room}`;

// ponytail: one web replica, so presence is a Map in this process and fan-out
// is Bun's pub/sub. The upgrade path when `web.replicas > 1` is Postgres
// LISTEN/NOTIFY carrying store writes and room frames between replicas.
/** Room topic → peer id → how many of that peer's sockets are in the room. */
const presence = new Map<string, Map<string, number>>();

type Socket = Bun.ServerWebSocket<unknown>;

/** The socket handlers a `kthx` socket is handed to. */
export const kthxSocket = {
  message(socket: Socket, data: KthxSocketData, raw: string | Buffer): void {
    if (raw.length > MAX_FRAME_BYTES) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const { t, room, data: payload } = frame as Record<string, unknown>;
    if (t === 'watch') {
      socket.subscribe(dbTopic(data.site));
      return;
    }
    if (
      typeof room !== 'string' ||
      room.length === 0 ||
      room.length > MAX_ROOM_CHARS
    ) {
      return;
    }
    if (t === 'join') {
      if (data.rooms.size < MAX_ROOMS || data.rooms.has(room)) {
        join(socket, data, room);
      }
    } else if (t === 'leave') leave(socket, data, room);
    else if (t === 'send' && data.rooms.has(room)) {
      socket.publish(
        roomTopic(data.site, room),
        JSON.stringify({ t: 'msg', room, from: data.me, data: payload }),
      );
    }
  },
  close(socket: Socket, data: KthxSocketData): void {
    for (const room of data.rooms) leave(socket, data, room);
  },
};

function join(socket: Socket, data: KthxSocketData, room: string): void {
  const topic = roomTopic(data.site, room);
  const peers = presence.get(topic) ?? new Map<string, number>();
  presence.set(topic, peers);
  if (!data.rooms.has(room)) {
    data.rooms.add(room);
    socket.subscribe(topic);
    const count = (peers.get(data.me) ?? 0) + 1;
    peers.set(data.me, count);
    if (count === 1) {
      socket.publish(topic, JSON.stringify({ t: 'join', room, peer: data.me }));
    }
  }
  socket.send(JSON.stringify({ t: 'peers', room, peers: [...peers.keys()] }));
}

function leave(socket: Socket, data: KthxSocketData, room: string): void {
  if (!data.rooms.delete(room)) return;
  const topic = roomTopic(data.site, room);
  socket.unsubscribe(topic);
  const peers = presence.get(topic);
  if (peers === undefined) return;
  const count = (peers.get(data.me) ?? 1) - 1;
  if (count > 0) {
    peers.set(data.me, count);
    return;
  }
  peers.delete(data.me);
  if (peers.size === 0) presence.delete(topic);
  socket.publish(topic, JSON.stringify({ t: 'leave', room, peer: data.me }));
}
