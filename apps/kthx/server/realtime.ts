/**
 * `/api/ws`: one socket per tab, carrying two things that look alike and are
 * not.
 *
 * A **subscription** is a collection someone wants told about: every write to
 * `/api/db` fans out to it, the writer's own tab included, so a list on screen
 * and the row behind it never disagree. A **room** is presence and chatter that
 * never lands in the database — cursors, typing, a game tick.
 *
 * Fan-out is Bun's pub/sub in this process. That is correct only because there
 * is one replica by construction, which the sites volume already assumes; the
 * upgrade path is Postgres `LISTEN`/`NOTIFY` the day a second one exists.
 */

export const MAX_FRAME_BYTES = 16 * 1024;
/** How large a document still rides along in its frame. */
export const MAX_FRAME_DOC_BYTES = 16 * 1024;
export const MAX_ROOMS = 32;
export const MAX_SUBSCRIPTIONS = 32;
export const MAX_ROOM_MEMBERS = 256;
export const MAX_SOCKETS_PER_VISITOR = 8;
export const MAX_SOCKETS_PER_ADDRESS = 32;
/** Frames a socket may send in a second before the rest are dropped. */
const FRAMES_PER_SECOND = 20;
const MAX_ROOM_CHARS = 128;

/** What a socket carries: who it is, where it is, and what it is listening to. */
export interface SocketData {
  readonly kind: 'kthx';
  readonly site: string;
  /** The `__Host-kthx_me` id, which is what a room shows the others. */
  readonly me: string;
  readonly address: string | null;
  readonly rooms: Set<string>;
  readonly subscriptions: Set<string>;
  /** The send budget, refilled by time rather than by a timer. */
  budget: { tokens: number; at: number };
}

type Socket = Bun.ServerWebSocket<SocketData>;

const collectionTopic = (site: string, collection: string) =>
  `kthx:${site}:c:${collection}`;
const roomTopic = (site: string, room: string) => `kthx:${site}:r:${room}`;

// ponytail: one replica, so presence and the socket counts are plain maps in
// this process. They go to Postgres with the fan-out when a second one exists.
/** Room topic → peer id → how many of that peer's sockets are in the room. */
const presence = new Map<string, Map<string, number>>();
/** `site:key` → open sockets, for the two upgrade caps. */
const sockets = new Map<string, number>();

function bump(key: string, by: number): number {
  const next = (sockets.get(key) ?? 0) + by;
  if (next <= 0) sockets.delete(key);
  else sockets.set(key, next);
  return next;
}

/** Whether this visitor or address already has as many sockets as it may. */
export function socketsFull(
  site: string,
  me: string,
  address: string | null,
): boolean {
  if ((sockets.get(`${site}:v:${me}`) ?? 0) >= MAX_SOCKETS_PER_VISITOR) {
    return true;
  }
  return (
    address !== null &&
    (sockets.get(`${site}:a:${address}`) ?? 0) >= MAX_SOCKETS_PER_ADDRESS
  );
}

/** Tell every tab subscribed to this collection what just happened to it. */
export function publishDocument(
  server: Bun.Server<unknown> | undefined,
  site: string,
  frame: Record<string, unknown>,
  collection: string,
): void {
  server?.publish(collectionTopic(site, collection), JSON.stringify(frame));
}

/** A document rides along when it is small; otherwise the etag is the signal. */
export function framed(document: Record<string, unknown>): unknown {
  const text = JSON.stringify(document);
  return Buffer.byteLength(text) <= MAX_FRAME_DOC_BYTES ? document : undefined;
}

/** The handlers `Bun.serve` is given for a kthx socket. */
export const websocket = {
  idleTimeout: 120,
  maxPayloadLength: MAX_FRAME_BYTES,

  open(socket: Socket): void {
    const { site, me, address } = socket.data;
    bump(`${site}:v:${me}`, 1);
    if (address !== null) bump(`${site}:a:${address}`, 1);
  },

  message(socket: Socket, raw: string | Buffer): void {
    if (raw.length > MAX_FRAME_BYTES || !affordable(socket.data)) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const { t, room, collection, data } = frame as Record<string, unknown>;
    const state = socket.data;

    if (t === 'ping') {
      socket.send('{"t":"pong"}');
      return;
    }
    if (t === 'sub' || t === 'unsub') {
      if (typeof collection !== 'string' || collection === '') return;
      const topic = collectionTopic(state.site, collection);
      if (t === 'unsub') {
        state.subscriptions.delete(collection);
        socket.unsubscribe(topic);
        return;
      }
      if (
        state.subscriptions.has(collection) ||
        state.subscriptions.size < MAX_SUBSCRIPTIONS
      ) {
        state.subscriptions.add(collection);
        socket.subscribe(topic);
      }
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
      if (state.rooms.size < MAX_ROOMS || state.rooms.has(room)) {
        join(socket, state, room);
      }
    } else if (t === 'leave') {
      leave(socket, state, room);
    } else if (t === 'send' && state.rooms.has(room)) {
      socket.publish(
        roomTopic(state.site, room),
        JSON.stringify({ t: 'msg', room, from: state.me, data }),
      );
    }
  },

  close(socket: Socket): void {
    const { site, me, address, rooms } = socket.data;
    for (const room of [...rooms]) leave(socket, socket.data, room);
    bump(`${site}:v:${me}`, -1);
    if (address !== null) bump(`${site}:a:${address}`, -1);
  },
};

/** Twenty frames a second per socket, refilled by the clock. */
function affordable(state: SocketData, now = Date.now()): boolean {
  const budget = state.budget;
  budget.tokens = Math.min(
    FRAMES_PER_SECOND,
    budget.tokens + ((now - budget.at) / 1000) * FRAMES_PER_SECOND,
  );
  budget.at = now;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}

function join(socket: Socket, state: SocketData, room: string): void {
  const topic = roomTopic(state.site, room);
  const peers = presence.get(topic) ?? new Map<string, number>();
  presence.set(topic, peers);
  if (!state.rooms.has(room)) {
    // A full room takes no new peer; one of its own peers opening a second tab
    // is not a new peer and is let in.
    if (peers.size >= MAX_ROOM_MEMBERS && !peers.has(state.me)) return;
    state.rooms.add(room);
    socket.subscribe(topic);
    const count = (peers.get(state.me) ?? 0) + 1;
    peers.set(state.me, count);
    if (count === 1) {
      socket.publish(
        topic,
        JSON.stringify({ t: 'join', room, peer: state.me }),
      );
    }
  }
  socket.send(JSON.stringify({ t: 'peers', room, peers: [...peers.keys()] }));
}

function leave(socket: Socket, state: SocketData, room: string): void {
  if (!state.rooms.delete(room)) return;
  const topic = roomTopic(state.site, room);
  socket.unsubscribe(topic);
  const peers = presence.get(topic);
  if (peers === undefined) return;
  const count = (peers.get(state.me) ?? 1) - 1;
  if (count > 0) {
    peers.set(state.me, count);
    return;
  }
  peers.delete(state.me);
  if (peers.size === 0) presence.delete(topic);
  socket.publish(topic, JSON.stringify({ t: 'leave', room, peer: state.me }));
}
