/**
 * kthx: the `/_/` surface every site has. `db` is JSON by key, `me` is a
 * cookie that says which browser this is, `ws` is the one socket a tab opens
 * for store watches and rooms, and `sdk.js` fronts the three as `window.kthx`.
 *
 * There is no login. Anyone on a site's origin reads and writes its keys,
 * artifacts-style; `me` is an anonymous id a poll can remember a vote by.
 * A write is one statement the row decides — `if-match` on the stored etag,
 * `if-none-match: *` on there being no row — so two tabs racing on a key
 * cannot both win, and the SDK's `update` is a loop over that.
 *
 * Fan-out is Bun's own pub/sub. Every store write on a site is published to
 * the site's one `db` topic and the SDK keeps the key-or-prefix filter, which
 * is the smallest thing that is right for both kinds of watch at once; a room
 * is a topic of its own that `send` publishes to, sender excluded.
 */
import { createHash } from 'node:crypto';
import { join as pathJoin } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { kthxKv } from '../db/schema.ts';
import type { KthxDeps } from './serve.ts';

export const MAX_KEY_CHARS = 256;
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_LIST = 500;
const MAX_ROOM_CHARS = 128;

const SDK = pathJoin(import.meta.dir, 'sdk.js');

/** The SDK, the same bytes at apex `/sdk.js` and every site's `/_/sdk.js`. */
export function sdkResponse(): Response {
  return new Response(Bun.file(SDK), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

/**
 * What a site answers under `/_/`, given the decoded path: `undefined` once
 * the socket is Bun's, `null` for a path that is nothing of kthx's.
 */
export function underscoreResponse(
  request: Request,
  pathname: string,
  site: string,
  deps: KthxDeps,
  server: Bun.Server<unknown> | undefined,
): Response | null | undefined | Promise<Response | undefined> {
  if (pathname === '/_/sdk.js') return sdkResponse();
  if (pathname === '/_/me') {
    const me = meOf(request);
    return Response.json(
      { id: me.id },
      { headers: { ...me.headers, 'cache-control': 'no-store' } },
    );
  }
  if (pathname === '/_/ws') return upgrade(request, site, server);
  if (pathname === '/_/db') return list(request, site, deps);
  if (pathname.startsWith('/_/db/')) {
    return kv(request, pathname.slice('/_/db/'.length), site, deps, server);
  }
  return null;
}

// --- me ---------------------------------------------------------------------

const ME_COOKIE = 'kthx_me';
const ME_LIFETIME_S = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f-]{36}$/;

/** Who this browser is on this site, and the header that makes it so if it was not yet. */
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
  return {
    id,
    headers: {
      'set-cookie': `${ME_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ME_LIFETIME_S}`,
    },
  };
}

// --- db ---------------------------------------------------------------------

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

const dbTopic = (site: string) => `kthx:${site}:db`;

/** The stored value as its JSON text — see `jsonbValue` in the schema. */
const VALUE_TEXT = sql<string>`${kthxKv.value}::text`;

async function list(
  request: Request,
  site: string,
  deps: KthxDeps,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse(405, 'METHOD_NOT_ALLOWED', '/_/db is read with GET');
  }
  const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
  const rows = await deps.db
    .select({ key: kthxKv.key, value: VALUE_TEXT })
    .from(kthxKv)
    .where(
      and(eq(kthxKv.site, site), sql`starts_with(${kthxKv.key}, ${prefix})`),
    )
    .orderBy(asc(kthxKv.key))
    .limit(MAX_LIST);
  const items = rows.map((row) => ({
    key: row.key,
    value: JSON.parse(row.value) as unknown,
  }));
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}

async function kv(
  request: Request,
  key: string,
  site: string,
  deps: KthxDeps,
  server: Bun.Server<unknown> | undefined,
): Promise<Response> {
  if (key.length === 0 || key.length > MAX_KEY_CHARS) {
    return refuse(
      400,
      'INVALID_KEY',
      `a key is 1 to ${MAX_KEY_CHARS} characters`,
    );
  }
  const at = and(eq(kthxKv.site, site), eq(kthxKv.key, key));
  switch (request.method) {
    case 'GET':
    case 'HEAD': {
      const [row] = await deps.db
        .select({ value: VALUE_TEXT, etag: kthxKv.etag })
        .from(kthxKv)
        .where(at)
        .limit(1);
      if (row === undefined) return refuse(404, 'NOT_FOUND', `no ${key} here`);
      return new Response(request.method === 'HEAD' ? null : row.value, {
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
      const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
      const expected = request.headers.get('if-match');
      const written =
        expected !== null
          ? await deps.db
              .update(kthxKv)
              .set({ value, etag, updatedAt: new Date() })
              .where(and(at, eq(kthxKv.etag, expected)))
              .returning({ key: kthxKv.key })
          : request.headers.get('if-none-match') === '*'
            ? await deps.db
                .insert(kthxKv)
                .values({ site, key, value, etag })
                .onConflictDoNothing()
                .returning({ key: kthxKv.key })
            : await deps.db
                .insert(kthxKv)
                .values({ site, key, value, etag })
                .onConflictDoUpdate({
                  target: [kthxKv.site, kthxKv.key],
                  set: { value, etag, updatedAt: new Date() },
                })
                .returning({ key: kthxKv.key });
      if (written.length === 0) {
        return refuse(
          412,
          'PRECONDITION_FAILED',
          `${key} changed since it was read`,
        );
      }
      server?.publish(dbTopic(site), JSON.stringify({ t: 'put', key, value }));
      return Response.json({ key, value }, { headers: { etag } });
    }
    case 'DELETE': {
      await deps.db.delete(kthxKv).where(at);
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
): Response | undefined {
  const me = meOf(request);
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

/** The socket handlers `streamWebSocket` hands a `kthx` socket to. */
export const kthxSocket = {
  message(socket: Socket, data: KthxSocketData, raw: string | Buffer): void {
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
    if (t === 'join') join(socket, data, room);
    else if (t === 'leave') leave(socket, data, room);
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
