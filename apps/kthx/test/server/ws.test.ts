/**
 * `/api/ws`: the collection frames a write fans out, and the rooms that never
 * touch the database.
 *
 * A real `Bun.serve` rather than the handler on its own, because an upgrade is
 * the one thing a bare `fetch` cannot do — and because the caps this exercises
 * are counted in the socket's `open` and `close`, not in the handler.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_SOCKETS_PER_VISITOR } from '../../server/realtime.ts';
import { ask, idToken, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.18.0.${nextAddress % 250}`;
}

interface Site {
  readonly name: string;
  readonly host: string;
  readonly origin: string;
}

async function claimed(label: string): Promise<Site> {
  const name = kthx().name(label);
  const token = await idToken(`${name}@example.com`);
  const response = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
    }),
  );
  expect(response.status).toBe(201);
  await response.json();
  const server = kthx().listen();
  return {
    name,
    host: `${name}.${ZONE}`,
    origin: `${server.url.origin}`,
  };
}

/** A socket on this site, with every frame it was sent. */
async function open(site: Site, cookie?: string) {
  const server = kthx().listen();
  const socket = new WebSocket(
    `ws://${server.url.host}/api/ws`,
    // Bun's client sends these as request headers, which is how the server
    // sees the `Host` a Gateway would have set.
    {
      headers: {
        host: site.host,
        ...(cookie === undefined ? {} : { cookie }),
      },
    } as unknown as string[],
  );
  const frames: Record<string, unknown>[] = [];
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return { socket, frames };
}

/** Fan-out is asynchronous; wait for it rather than guess at it. */
async function delivered(frames: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (frames.length < count && Date.now() < deadline) await Bun.sleep(5);
}

function write(site: Site, method: string, path: string, body: unknown) {
  return kthx().fetch(
    ask(path, {
      host: site.host,
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('collection frames', () => {
  test('a subscriber is told about every write, and only its collection', async () => {
    const site = await claimed('feed');
    const tab = await open(site);
    tab.socket.send(JSON.stringify({ t: 'sub', collection: 'notes' }));
    // The subscription is handled on the server before the write arrives only
    // if it got there first; the write is a separate connection, so wait.
    await Bun.sleep(50);

    const created = (await (
      await write(site, 'POST', '/api/db/notes', { id: 'x', n: 1 })
    ).json()) as { etag: string };
    await write(site, 'PATCH', '/api/db/notes/x', { n: 2 });
    await write(site, 'POST', '/api/db/other', { n: 1 });
    await kthx().fetch(
      ask('/api/db/notes/x', { host: site.host, method: 'DELETE' }),
    );

    await delivered(tab.frames, 3);
    expect(tab.frames.map((frame) => frame.t)).toEqual([
      'create',
      'update',
      'delete',
    ]);
    expect(tab.frames[0]).toMatchObject({
      collection: 'notes',
      id: 'x',
      etag: created.etag,
    });
    // The document rides along while it is small.
    expect((tab.frames[0] as { doc: { n: number } }).doc.n).toBe(1);
    expect((tab.frames[1] as { doc: { n: number } }).doc.n).toBe(2);
    expect(tab.frames[2]).toEqual({
      t: 'delete',
      collection: 'notes',
      id: 'x',
    });

    // `unsub` stops it.
    tab.socket.send(JSON.stringify({ t: 'unsub', collection: 'notes' }));
    await Bun.sleep(50);
    await write(site, 'POST', '/api/db/notes', { n: 3 });
    await Bun.sleep(100);
    expect(tab.frames).toHaveLength(3);
    tab.socket.close();
  });

  test('a ping is answered, so the socket is never idle', async () => {
    const site = await claimed('ping');
    const tab = await open(site);
    tab.socket.send(JSON.stringify({ t: 'ping' }));
    await delivered(tab.frames, 1);
    expect(tab.frames[0]).toEqual({ t: 'pong' });
    tab.socket.close();
  });

  test('one visitor gets eight sockets and no more', async () => {
    const site = await claimed('sockets');
    // Every socket is the same visitor only if they carry the same cookie;
    // without one each upgrade mints a new id, which is its own allowance.
    const first = await kthx().fetch(ask('/api/me', { host: site.host }));
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const open_ = [];
    for (let i = 0; i < MAX_SOCKETS_PER_VISITOR; i += 1) {
      open_.push(await open(site, cookie));
    }
    const refused = await kthx().fetch(
      ask('/api/ws', { host: site.host, headers: { cookie } }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');

    open_[0]?.socket.close();
    await Bun.sleep(100);
    const room = await open(site, cookie);
    expect(room.socket.readyState).toBe(WebSocket.OPEN);
    for (const tab of open_.slice(1)) tab.socket.close();
    room.socket.close();
  });
});

describe('rooms', () => {
  test('messages reach the others, presence says who is there', async () => {
    const site = await claimed('lobby');
    const a = await open(site);
    const b = await open(site);

    a.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    await delivered(a.frames, 1);
    b.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    await delivered(a.frames, 2);
    b.socket.send(JSON.stringify({ t: 'send', room: 'lobby', data: 'hi' }));
    await delivered(a.frames, 3);
    b.socket.close();
    await delivered(a.frames, 4);

    // Neither socket sent a cookie, so each was given an id on upgrade.
    const [A] = (a.frames[0] as { peers: string[] }).peers;
    const B = (a.frames[1] as { peer: string }).peer;
    expect(A).toMatch(/^[0-9a-f-]{36}$/);
    expect(B).not.toBe(A);
    expect(a.frames).toEqual([
      { t: 'peers', room: 'lobby', peers: [A] },
      { t: 'join', room: 'lobby', peer: B },
      { t: 'msg', room: 'lobby', from: B, data: 'hi' },
      { t: 'leave', room: 'lobby', peer: B },
    ]);
    expect(b.frames).toEqual([{ t: 'peers', room: 'lobby', peers: [A, B] }]);
    a.socket.close();
  });

  test('a room on one site is not a room on another', async () => {
    const one = await claimed('one');
    const two = await claimed('two');
    const a = await open(one);
    const b = await open(two);
    a.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    b.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    await delivered(a.frames, 1);
    await delivered(b.frames, 1);
    a.socket.send(JSON.stringify({ t: 'send', room: 'lobby', data: 'hi' }));
    await Bun.sleep(150);

    expect(a.frames).toEqual([
      { t: 'peers', room: 'lobby', peers: [expect.any(String)] },
    ]);
    expect(b.frames).toEqual([
      { t: 'peers', room: 'lobby', peers: [expect.any(String)] },
    ]);
    a.socket.close();
    b.socket.close();
  });

  test('a frame that is not one is dropped, not answered', async () => {
    const site = await claimed('junk');
    const tab = await open(site);
    tab.socket.send('not json');
    tab.socket.send(JSON.stringify({ t: 'nonsense' }));
    tab.socket.send(JSON.stringify({ t: 'join' }));
    tab.socket.send(JSON.stringify({ t: 'ping' }));
    await delivered(tab.frames, 1);
    expect(tab.frames).toEqual([{ t: 'pong' }]);
    tab.socket.close();
  });
});
