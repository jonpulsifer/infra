/*
 * kthx: `window.kthx` for a site, one classic script, no build step.
 *
 *   kthx.db.get(key) → value|null     kthx.db.set(key, value)    kthx.db.del(key)
 *   kthx.db.list(prefix) → [{key,value}]
 *   kthx.db.update(key, fn)           read, change, write; retried if another tab wrote first
 *   kthx.db.watch(keyOrPrefix, cb)    cb({key, value|null}); a trailing "/" watches a prefix; returns unsubscribe
 *   kthx.live.join(room) → { send(data), on("message"|"join"|"leave", cb), peers(), leave() }
 *   kthx.me.id                        after kthx.ready
 *   kthx.ready                        resolved once /_/me has answered
 *
 * The socket opens on the first watch or join, reconnects with backoff, and
 * re-subscribes on its own. Everything is scoped to the site by its origin.
 */
(() => {
  // --- me ------------------------------------------------------------------

  const me = { id: null };
  const ready = fetch('/_/me')
    .then((response) => response.json())
    .then(({ id }) => {
      me.id = id;
    });

  // --- db ------------------------------------------------------------------

  const url = (key) => `/_/db/${encodeURIComponent(key)}`;
  const JSON_BODY = { 'content-type': 'application/json' };

  async function failed(response) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || response.statusText);
    error.code = body.code;
    error.status = response.status;
    return error;
  }

  /** The stored value and its etag, or `null` and no etag for a key that is not there. */
  async function read(key) {
    const response = await fetch(url(key));
    if (response.status === 404) return { value: null, etag: null };
    if (!response.ok) throw await failed(response);
    return { value: await response.json(), etag: response.headers.get('etag') };
  }

  async function write(key, value, headers) {
    const response = await fetch(url(key), {
      method: 'PUT',
      headers: { ...JSON_BODY, ...headers },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw await failed(response);
    return value;
  }

  const db = {
    get: async (key) => (await read(key)).value,
    set: (key, value) => write(key, value, {}),
    async del(key) {
      const response = await fetch(url(key), { method: 'DELETE' });
      if (!response.ok) throw await failed(response);
    },
    async list(prefix = '') {
      const response = await fetch(
        `/_/db?prefix=${encodeURIComponent(prefix)}`,
      );
      if (!response.ok) throw await failed(response);
      return (await response.json()).items;
    },
    async update(key, fn) {
      for (;;) {
        const { value, etag } = await read(key);
        const next = await fn(value);
        try {
          return await write(
            key,
            next,
            etag ? { 'if-match': etag } : { 'if-none-match': '*' },
          );
        } catch (error) {
          if (error.status !== 412) throw error;
        }
      }
    },
    watch(keyOrPrefix, cb) {
      const watcher = { on: keyOrPrefix, cb };
      watchers.add(watcher);
      send({ t: 'watch', prefix: '' });
      return () => watchers.delete(watcher);
    },
  };

  // --- the socket ----------------------------------------------------------

  const watchers = new Set();
  const rooms = new Map();
  let socket = null;
  let backoff = 500;
  /** Frames sent before the socket is open, in order, behind the replayed watch and joins. */
  const pending = [];

  function connect() {
    if (socket !== null) return;
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_/ws`,
    );
    socket.onopen = () => {
      backoff = 500;
      if (watchers.size > 0)
        socket.send(JSON.stringify({ t: 'watch', prefix: '' }));
      for (const room of rooms.keys())
        socket.send(JSON.stringify({ t: 'join', room }));
      for (const frame of pending.splice(0)) socket.send(frame);
    };
    socket.onmessage = (event) => dispatch(JSON.parse(event.data));
    socket.onclose = () => {
      socket = null;
      if (watchers.size === 0 && rooms.size === 0) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  }

  /** Queue a frame behind `ready` — the cookie the socket is identified by has to exist first. */
  function send(frame) {
    ready.then(() => {
      connect();
      // `onopen` replays watches and joins from their own state; only what
      // is not derivable from it waits.
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(frame));
      else if (frame.t === 'send' || frame.t === 'leave')
        pending.push(JSON.stringify(frame));
    });
  }

  function dispatch(frame) {
    if (frame.t === 'put' || frame.t === 'del') {
      const value = frame.t === 'put' ? frame.value : null;
      for (const { on, cb } of watchers) {
        if (
          frame.key === on ||
          (on.endsWith('/') && frame.key.startsWith(on))
        ) {
          cb({ key: frame.key, value });
        }
      }
      return;
    }
    const room = rooms.get(frame.room);
    if (room === undefined) return;
    if (frame.t === 'peers') room.members = frame.peers;
    if (frame.t === 'join' && !room.members.includes(frame.peer))
      room.members.push(frame.peer);
    if (frame.t === 'leave')
      room.members = room.members.filter((peer) => peer !== frame.peer);
    const event = frame.t === 'msg' ? 'message' : frame.t;
    const payload =
      frame.t === 'msg' ? { from: frame.from, data: frame.data } : frame.peer;
    for (const cb of room.handlers[event] ?? []) cb(payload);
  }

  const live = {
    join(name) {
      const existing = rooms.get(name);
      if (existing !== undefined) return existing.handle;
      const room = { members: [], handlers: {} };
      room.handle = {
        send: (data) => send({ t: 'send', room: name, data }),
        on(event, cb) {
          room.handlers[event] = [...(room.handlers[event] ?? []), cb];
          return room.handle;
        },
        peers: () => [...room.members],
        leave() {
          rooms.delete(name);
          send({ t: 'leave', room: name });
        },
      };
      rooms.set(name, room);
      send({ t: 'join', room: name });
      return room.handle;
    },
  };

  window.kthx = { db, live, me, ready };
})();
