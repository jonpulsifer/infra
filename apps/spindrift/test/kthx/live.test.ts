/**
 * kthx `ws`: a real `Bun.serve` with the shared socket handler, two tabs
 * on one site, a store write reaching a watcher, and a room's presence.
 */
import { describe, expect, test } from 'bun:test';
import { type KthxDeps, withKthxHost } from '../../src/kthx/serve.ts';
import { KTHX_PATHS, kthxRoutes } from '../../src/kthx/sites.ts';
import {
  type StreamSocketData,
  streamWebSocket,
} from '../../src/web/streams.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const ZONE = 'kthx.test';
const HOST = `notes.${ZONE}`;

function deps(): KthxDeps {
  return { db: database().db, zone: ZONE, depot: async () => null };
}

async function claim(name = 'notes'): Promise<void> {
  const response = await kthxRoutes(deps())[KTHX_PATHS[0]]!(
    new Request(`http://${ZONE}/kthx/sites`, {
      method: 'POST',
      headers: { host: ZONE },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(201);
}

/** A tab: one socket with its own `kthx_me`, and its frames in arrival order. */
class Tab {
  readonly frames: Record<string, unknown>[] = [];
  private waiting: (() => void)[] = [];
  readonly socket: WebSocket;

  constructor(
    port: number,
    readonly me: string,
    host = HOST,
  ) {
    this.socket = new WebSocket(`ws://localhost:${port}/_/ws`, {
      headers: { host, cookie: `kthx_me=${me}` },
    } as never);
    this.socket.onmessage = (event) => {
      this.frames.push(JSON.parse(String(event.data)));
      for (const wake of this.waiting.splice(0)) wake();
    };
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error('socket failed'));
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The next frame satisfying `where`, within a second. */
  async next(
    where: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 1000;
    for (;;) {
      const index = this.frames.findIndex(where);
      if (index !== -1) return this.frames.splice(index, 1)[0]!;
      if (Date.now() > deadline)
        throw new Error(`no such frame; saw ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
}

async function serving() {
  await claim();
  const routes = withKthxHost(
    { '/*': () => new Response('the status page', { status: 503 }) },
    deps(),
  );
  const server = Bun.serve<StreamSocketData>({
    port: 0,
    routes,
    websocket: streamWebSocket,
  });
  const port = server.port!;
  const put = (key: string, value: unknown) =>
    fetch(`http://localhost:${port}/_/db/${key}`, {
      method: 'PUT',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  return { server, port, put };
}

describe('/_/ws', () => {
  test('a watcher sees each store write and delete on its site, and no other', async () => {
    const { server, port, put } = await serving();
    try {
      const tab = new Tab(port, 'aaaaaaaa-0000-4000-8000-000000000001');
      await tab.open();
      tab.send({ t: 'watch', prefix: '' });
      // A subscription lands before the next frame on the same socket is read.
      tab.send({ t: 'join', room: 'sync' });
      await tab.next((frame) => frame.t === 'peers');

      expect((await put('votes', { n: 1 })).status).toBe(200);
      expect(await tab.next((frame) => frame.t === 'put')).toEqual({
        t: 'put',
        key: 'votes',
        value: { n: 1 },
      });
      await fetch(`http://localhost:${port}/_/db/votes`, {
        method: 'DELETE',
        headers: { host: HOST },
      });
      expect(await tab.next((frame) => frame.t === 'del')).toEqual({
        t: 'del',
        key: 'votes',
      });

      await claim('other');
      await fetch(`http://localhost:${port}/_/db/votes`, {
        method: 'PUT',
        headers: { host: `other.${ZONE}`, 'content-type': 'application/json' },
        body: '1',
      });
      await expect(tab.next((frame) => frame.t === 'put')).rejects.toThrow();
      tab.socket.close();
    } finally {
      server.stop(true);
    }
  });

  test('a room shows who is here, carries messages to the others, and says who left', async () => {
    const { server, port } = await serving();
    try {
      const alice = new Tab(port, 'aaaaaaaa-0000-4000-8000-00000000000a');
      const bob = new Tab(port, 'bbbbbbbb-0000-4000-8000-00000000000b');
      await Promise.all([alice.open(), bob.open()]);

      alice.send({ t: 'join', room: 'cursors' });
      expect(await alice.next((frame) => frame.t === 'peers')).toEqual({
        t: 'peers',
        room: 'cursors',
        peers: [alice.me],
      });

      bob.send({ t: 'join', room: 'cursors' });
      expect((await bob.next((frame) => frame.t === 'peers')).peers).toEqual([
        alice.me,
        bob.me,
      ]);
      expect(await alice.next((frame) => frame.t === 'join')).toEqual({
        t: 'join',
        room: 'cursors',
        peer: bob.me,
      });

      bob.send({ t: 'send', room: 'cursors', data: { x: 1, y: 2 } });
      expect(await alice.next((frame) => frame.t === 'msg')).toEqual({
        t: 'msg',
        room: 'cursors',
        from: bob.me,
        data: { x: 1, y: 2 },
      });
      // The sender does not hear itself.
      await expect(bob.next((frame) => frame.t === 'msg')).rejects.toThrow();

      // A send to a room the socket is not in goes nowhere.
      bob.send({ t: 'send', room: 'elsewhere', data: 1 });
      await expect(alice.next((frame) => frame.t === 'msg')).rejects.toThrow();

      bob.socket.close();
      expect(await alice.next((frame) => frame.t === 'leave')).toEqual({
        t: 'leave',
        room: 'cursors',
        peer: bob.me,
      });
      alice.socket.close();
    } finally {
      server.stop(true);
    }
  });

  test('a socket is refused where there is no site, and mints a me cookie where there is', async () => {
    const { server, port } = await serving();
    try {
      const nobody = new WebSocket(`ws://localhost:${port}/_/ws`, {
        headers: { host: `nobody.${ZONE}` },
      } as never);
      await new Promise<void>((resolve) => {
        nobody.onerror = () => resolve();
        nobody.onclose = () => resolve();
      });
      expect(nobody.readyState).toBe(WebSocket.CLOSED);

      const upgrade = await fetch(`http://localhost:${port}/_/ws`, {
        headers: {
          host: HOST,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      expect(upgrade.status).toBe(101);
      expect(upgrade.headers.get('set-cookie')).toContain('kthx_me=');
    } finally {
      server.stop(true);
    }
  });
});
