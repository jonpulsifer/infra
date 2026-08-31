/*
 * kthx: `window.kthx` for a site. One classic script, no build step.
 *
 *   const c = kthx.db.collection('votes')
 *   await c.create({ host: 'optiplex' })          // → the document, with an id
 *   await c.get(id) / c.findById(id)              // → the document, or null
 *   await c.update(id, patch, { overwrite, ifMatch })   // SHALLOW MERGE
 *   await c.put(id, doc, { ifMatch, ifNoneMatch })      // upsert
 *   await c.delete(id)
 *   await c.find({ where, orderBy, limit, offset })     // → [documents]
 *   await c.where({ host: 'optiplex' }).orderBy('created_at', 'desc').limit(20).find()
 *   await c.count({ host: 'optiplex' })           // → a number
 *   c.subscribe({ onCreate, onUpdate, onDelete }) // → unsubscribe
 *   await kthx.db.collections()                   // → [{ name, count }]
 *   const room = kthx.live.join('cursors')        // → { send, on, peers, leave }
 *   await kthx.ai.chat('summarise this')          // → a string
 *   for await (const d of await kthx.ai.chat(msgs, { stream: true })) {}
 *   kthx.ai.baseURL                               // absolute; for the OpenAI SDK
 *   await kthx.ready; kthx.me.id; kthx.site.name
 *
 * The socket opens on the first subscribe or join, pings every 30 s, and
 * reconnects with backoff, re-sending its subscriptions and rooms. Everything
 * is scoped to the site by its origin. Every rejection is an Error carrying
 * `.code`, `.status`, `.message` and, on a 429, `.retryAfter` in seconds.
 */
(() => {
  const me = { id: null };
  const site = { name: null, url: null };
  const ready = fetch('/api/me')
    .then((response) => {
      if (!response.ok)
        throw new Error(`kthx: /api/me answered ${response.status}`);
      return response.json();
    })
    .then((body) => {
      me.id = body.id;
      site.name = body.site.name;
      site.url = body.site.url;
    });

  const JSON_BODY = { 'content-type': 'application/json' };

  async function failed(response) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || response.statusText);
    error.code = body.code;
    error.status = response.status;
    const wait = response.headers.get('retry-after');
    if (wait !== null) error.retryAfter = Number(wait);
    return error;
  }

  /** A call to this site's API: JSON in, JSON or nothing out. */
  async function call(path, init = {}) {
    const response = await fetch(path, init);
    if (!response.ok) throw await failed(response);
    if (response.status === 204) return undefined;
    return response.json();
  }

  const send = (method, path, body, headers) =>
    call(path, {
      method,
      headers: { ...JSON_BODY, ...headers },
      body: JSON.stringify(body),
    });

  // --- db ------------------------------------------------------------------

  const path = (collection, id) =>
    `/api/db/${encodeURIComponent(collection)}${
      id === undefined ? '' : `/${encodeURIComponent(id)}`
    }`;

  /** The immutable builder: every step is a new query, `find` runs it. */
  function query(collection, spec) {
    return {
      where: (where) => query(collection, { ...spec, where }),
      orderBy: (field, direction) =>
        query(collection, {
          ...spec,
          orderBy: direction === 'desc' ? `${field} desc` : field,
        }),
      limit: (limit) => query(collection, { ...spec, limit }),
      offset: (offset) => query(collection, { ...spec, offset }),
      find: async () =>
        (await send('POST', `${path(collection)}/query`, spec)).items,
      count: async () =>
        (
          await send('POST', `${path(collection)}/query`, {
            ...spec,
            limit: 0,
            count: true,
          })
        ).count,
    };
  }

  function collection(name) {
    const runner = query(name, {});
    /** One document by id. `findById` is the same call under Quick's name. */
    const get = async (id) => {
      const response = await fetch(path(name, id));
      if (response.status === 404) return null;
      if (!response.ok) throw await failed(response);
      return response.json();
    };
    return {
      name,

      /** One document, or an array of up to 100 written all or nothing. */
      async create(document) {
        const answer = await send('POST', path(name), document);
        return Array.isArray(document) ? answer.items : answer;
      },

      get,
      findById: get,

      /**
       * A SHALLOW MERGE of top-level keys.
       *
       * A nested object or array in `patch` replaces the stored one whole; a
       * key set to `null` is stored as `null`, not deleted; a key you leave out
       * is kept. `{overwrite: true}` replaces the whole document, which is the
       * only way to drop a key. Pass `{ifMatch: doc.etag}` and a concurrent
       * write rejects with 412 instead of silently winning.
       */
      update(id, patch, options = {}) {
        const url = options.overwrite
          ? `${path(name, id)}?overwrite=1`
          : path(name, id);
        return send('PATCH', url, patch, ifHeaders(options));
      },

      put(id, document, options = {}) {
        return send('PUT', path(name, id), document, ifHeaders(options));
      },

      delete(id, options = {}) {
        return call(path(name, id), {
          method: 'DELETE',
          headers: ifHeaders(options),
        });
      },

      list: (spec = {}) =>
        send('POST', `${path(name)}/query`, spec).then((b) => b.items),
      find: (spec = {}) =>
        send('POST', `${path(name)}/query`, spec).then((b) => b.items),
      count: (where) =>
        send('POST', `${path(name)}/query`, {
          where,
          limit: 0,
          count: true,
        }).then((b) => b.count),

      where: runner.where,
      orderBy: runner.orderBy,
      limit: runner.limit,
      offset: runner.offset,

      /** Every write to this collection, this tab's own included. */
      subscribe(handlers) {
        const watcher = { collection: name, handlers };
        watchers.add(watcher);
        frame({ t: 'sub', collection: name });
        return () => {
          watchers.delete(watcher);
          if (![...watchers].some((w) => w.collection === name)) {
            frame({ t: 'unsub', collection: name });
          }
        };
      },
    };
  }

  function ifHeaders({ ifMatch, ifNoneMatch }) {
    const headers = {};
    if (ifMatch) headers['if-match'] = ifMatch;
    if (ifNoneMatch)
      headers['if-none-match'] = ifNoneMatch === true ? '*' : ifNoneMatch;
    return headers;
  }

  const db = {
    collection,
    collections: () => call('/api/db').then((body) => body.collections),
    getCollections: () => call('/api/db').then((body) => body.collections),
  };

  // --- the socket ----------------------------------------------------------

  const watchers = new Set();
  const rooms = new Map();
  let socket = null;
  let backoff = 500;
  let heartbeat = null;
  /** Frames sent before the socket was open, behind the replayed state. */
  const pending = [];

  function connect() {
    if (socket !== null) return;
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
    );
    socket.onopen = () => {
      backoff = 500;
      for (const name of new Set([...watchers].map((w) => w.collection))) {
        socket.send(JSON.stringify({ t: 'sub', collection: name }));
      }
      for (const room of rooms.keys()) {
        socket.send(JSON.stringify({ t: 'join', room }));
      }
      for (const queued of pending.splice(0)) socket.send(queued);
      // Cloudflare cuts an idle socket at 100 s; the server closes at 120.
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send('{"t":"ping"}');
        }
      }, 30000);
    };
    socket.onmessage = (event) => dispatch(JSON.parse(event.data));
    socket.onclose = () => {
      socket = null;
      clearInterval(heartbeat);
      if (watchers.size === 0 && rooms.size === 0) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  }

  /** Queue a frame behind `ready`: the cookie identifying it must exist first. */
  function frame(body) {
    // `ready` rejects when /api/me does — a site still provisioning answers 503
    // — and this derived promise is not the one a page can catch, so it says so
    // here rather than surfacing as an unhandled rejection per frame.
    ready.then(
      () => {
        connect();
        // `onopen` replays subscriptions and joins from their own state; only
        // what cannot be derived from it waits here.
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(body));
        } else if (
          body.t === 'send' ||
          body.t === 'leave' ||
          body.t === 'unsub'
        ) {
          pending.push(JSON.stringify(body));
        }
      },
      (cause) => console.error('kthx: the socket cannot open', cause),
    );
  }

  function dispatch(body) {
    if (body.t === 'pong') return;
    if (body.t === 'create' || body.t === 'update' || body.t === 'delete') {
      for (const { collection: name, handlers } of watchers) {
        if (name !== body.collection) continue;
        if (body.t === 'delete') {
          handlers.onDelete?.(body.id);
        } else if (body.doc !== undefined) {
          (body.t === 'create' ? handlers.onCreate : handlers.onUpdate)?.(
            body.doc,
          );
        } else {
          // Too large to ride along: fetch what the frame only named.
          db.collection(name)
            .get(body.id)
            .then((document) => {
              if (document !== null) {
                (body.t === 'create' ? handlers.onCreate : handlers.onUpdate)?.(
                  document,
                );
              }
            })
            .catch(() => {});
        }
      }
      return;
    }
    const room = rooms.get(body.room);
    if (room === undefined) return;
    if (body.t === 'peers') room.members = body.peers;
    if (body.t === 'join' && !room.members.includes(body.peer)) {
      room.members.push(body.peer);
    }
    if (body.t === 'leave') {
      room.members = room.members.filter((peer) => peer !== body.peer);
    }
    const event = body.t === 'msg' ? 'message' : body.t;
    const payload =
      body.t === 'msg' ? { from: body.from, data: body.data } : body.peer;
    for (const handler of room.handlers[event] ?? []) {
      handler(body.t === 'peers' ? body.peers : payload);
    }
  }

  const live = {
    join(name) {
      const existing = rooms.get(name);
      if (existing !== undefined) return existing.handle;
      const room = { members: [], handlers: {} };
      room.handle = {
        send: (data) => frame({ t: 'send', room: name, data }),
        on(event, handler) {
          room.handlers[event] = [...(room.handlers[event] ?? []), handler];
          return room.handle;
        },
        peers: () => [...room.members],
        leave() {
          rooms.delete(name);
          frame({ t: 'leave', room: name });
        },
      };
      rooms.set(name, room);
      frame({ t: 'join', room: name });
      return room.handle;
    },
  };

  // --- files ---------------------------------------------------------------

  const filesPath = (name) =>
    `/api/files/${String(name).split('/').map(encodeURIComponent).join('/')}`;

  const files = {
    /**
     * The bytes at a path, uploaded.
     *
     * A `File` carries its own name and type, so `upload(file)` is the whole
     * call; a string is `text/plain` and anything else is serialised as
     * `application/json` unless a `type` says otherwise. The server takes
     * images, audio, video, PDF, JSON and text — never HTML, SVG or script,
     * which on this origin would be a page rather than a file.
     */
    async upload(path, body, options = {}) {
      if (body === undefined && path && typeof path.name === 'string') {
        body = path;
        path = path.name;
      }
      let type = options.type ?? (body instanceof Blob ? body.type : '');
      if (
        typeof body !== 'string' &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(body)
      ) {
        body = JSON.stringify(body);
        type ||= 'application/json';
      }
      return call(filesPath(path), {
        method: 'PUT',
        headers: { 'content-type': type || 'text/plain' },
        body,
      });
    },
    list: async () => (await call('/api/files')).items,
    delete: (path) => call(filesPath(path), { method: 'DELETE' }),
    url: (name) => `${location.origin}/files/${name}`,
  };

  // --- not yet -------------------------------------------------------------

  /** A named backend this build does not carry, said plainly rather than as a 404. */
  /**
   * A model, on the operator's key, through this site's own origin.
   *
   * `chat` is the whole of the convenience: one prompt in, one string out, and
   * with `{stream: true}` an async iterator of the deltas. Anything the OpenAI
   * API takes that this does not — tools, images, a second choice — is
   * `baseURL` and the real SDK, which this exists beside rather than in front
   * of.
   */
  const ai = {
    // Absolute: the OpenAI SDK rejects a relative baseURL at request time.
    baseURL: `${location.origin}/api/ai/v1`,

    /** Relative, like every other call here; `baseURL` is absolute for the SDK. */
    async chat(input, options = {}) {
      const { model, stream, ...rest } = options;
      const body = {
        ...rest,
        messages:
          typeof input === 'string'
            ? [{ role: 'user', content: input }]
            : input,
      };
      // Left out rather than sent empty: the server fills in its own default,
      // and a `model: undefined` on the wire is a model named `null`.
      if (model) body.model = model;
      if (stream) body.stream = true;
      const response = await fetch('/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: JSON_BODY,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await failed(response);
      if (!stream) {
        const answer = await response.json();
        return answer.choices?.[0]?.message?.content ?? '';
      }
      return deltas(response);
    },
  };

  /**
   * The SSE frames as the strings a page wants: one delta at a time.
   *
   * The `finally` is the stop button: breaking out of the loop must cancel the
   * body, because that is what aborts the request and lets the server stop
   * paying for an answer nobody is reading any more.
   */
  async function* deltas(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // A frame ends on a blank line; whatever follows the last one is half a
        // frame and waits for the next chunk.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '' || payload === '[DONE]') continue;
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  window.kthx = { db, live, ai, files, me, site, ready };
})();
