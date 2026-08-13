import { describe, expect, test } from 'bun:test';
import { isReconnecting } from '../../src/web/connection-status.ts';
import { SESSION_EXPIRED_EVENT } from '../../src/web/session-events.ts';
import {
  type BrowserSocket,
  type SocketFactory,
  subscribeAttempt,
  subscribeRuntime,
} from '../../src/web/stream-client.ts';

class FakeSocket implements BrowserSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  close() {}

  message(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }

  drop() {
    this.onclose?.();
  }
}

describe('resumable browser stream', () => {
  test('reconnects with the last durable cursor and stops after terminal', async () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const createSocket: SocketFactory = (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const messages: unknown[] = [];
    const stop = subscribeAttempt(
      { buildId: 9, deployId: 12 },
      (message) => messages.push(message),
      { createSocket, retryMs: 0 },
    );

    expect(urls[0]).toContain('buildId=9');
    expect(urls[0]).toContain('deployId=12');
    sockets[0]!.message({
      kind: 'attempt',
      entries: [],
      cursor: 41,
      terminal: false,
    });
    sockets[0]!.drop();
    // Not on the first drop: a reconnect that lands inside one backoff is a
    // blip, and a banner that appears and clears within it is noise.
    expect(isReconnecting()).toBe(false);
    await Bun.sleep(1);
    expect(urls[1]).toContain('after=41');

    // The second consecutive drop is what marks the shared "any stream is
    // retrying" flag `shell.tsx` reads through `connection-status.ts` — before
    // the reconnect resolves, not after, since that is the window a banner
    // exists to cover.
    sockets[1]!.drop();
    expect(isReconnecting()).toBe(true);
    await Bun.sleep(1);
    expect(urls[2]).toContain('after=41');

    sockets[2]!.message({
      kind: 'attempt',
      entries: [],
      cursor: 42,
      terminal: true,
    });
    // A message is what clears it — a reconnect that opened but has not yet
    // heard back is not yet "connected" again.
    expect(isReconnecting()).toBe(false);
    sockets[2]!.drop();
    await Bun.sleep(1);
    expect(urls).toHaveLength(3);
    expect(messages).toHaveLength(2);
    stop();
  });

  test('runtime errors are typed and reconnect from the last successful cursor', async () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const messages: unknown[] = [];
    const stop = subscribeRuntime(
      { componentId: 'component', targetId: 'target' },
      (message) => messages.push(message),
      {
        createSocket: (url) => {
          urls.push(url);
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        retryMs: 0,
      },
    );

    sockets[0]!.message({
      kind: 'stream',
      entries: [],
      cursor: 'opaque',
      reach: 60,
    });
    sockets[0]!.message({ kind: 'error', message: 'temporarily unavailable' });
    sockets[0]!.drop();
    await Bun.sleep(1);

    expect(messages.at(-1)).toEqual({
      kind: 'error',
      message: 'temporarily unavailable',
    });
    expect(urls[1]).toContain('after=opaque');
    stop();
  });

  test('a socket the server closed on purpose is not retried as a drop', async () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const messages: unknown[] = [];
    const stop = subscribeRuntime(
      { componentId: 'component', targetId: 'target' },
      (message) => messages.push(message),
      {
        createSocket: (url) => {
          urls.push(url);
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        retryMs: 0,
      },
    );

    // What `pump` does when the adapter has nothing to tail: send the reason,
    // then close. Reconnecting re-asks a question the frame already answered,
    // and the workspace's own re-read is what notices if it changes.
    sockets[0]!.message({
      kind: 'none',
      because: 'Nothing runs on that Target',
    });
    sockets[0]!.drop();
    await Bun.sleep(1);

    expect(urls).toHaveLength(1);
    expect(messages).toEqual([
      { kind: 'none', because: 'Nothing runs on that Target' },
    ]);
    expect(isReconnecting()).toBe(false);
    stop();
  });

  test('an error frame does not reset the backoff it just earned', async () => {
    const sockets: FakeSocket[] = [];
    let opened = 0;
    const stop = subscribeRuntime(
      { componentId: 'component', targetId: 'target' },
      () => {},
      {
        createSocket: () => {
          opened += 1;
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        retryMs: 0,
        checkSession: async () => true,
      },
    );

    // A stream that fails to read, closes, reconnects, and fails again is the
    // shape that used to strobe: every frame reset the count, so the socket
    // reopened at full speed forever and the banner marked and settled with
    // it. Only a `stream` page counts as reaching the server, so this run of
    // three reaches the session check rather than looping under it.
    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.message({ kind: 'error', message: 'read failed' });
      sockets.at(-1)!.drop();
      await Bun.sleep(1);
    }

    expect(opened).toBe(4);
    expect(isReconnecting()).toBe(true);
    stop();
    expect(isReconnecting()).toBe(false);
  });
});

describe('a drop the socket cannot explain', () => {
  // A failed WebSocket upgrade and a network blip fire the identical
  // `onerror`/`onclose` pair — the browser does not hand back the 401 a
  // reconnect got refused with. `checkSession` stands in for the real
  // `readSession()` read `stream-client.ts` falls back to.
  function harness(checkSession: () => Promise<boolean>) {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const createSocket: SocketFactory = (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    let sessionChecks = 0;
    const stop = subscribeAttempt({ buildId: 1 }, () => {}, {
      createSocket,
      retryMs: 0,
      checkSession: () => {
        sessionChecks += 1;
        return checkSession();
      },
    });
    return {
      urls,
      sockets,
      stop,
      checks: () => sessionChecks,
    };
  }

  test('three drops with nothing heard from in between ask before a fourth try', async () => {
    const { urls, sockets, stop, checks } = harness(async () => true);

    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.drop();
      await Bun.sleep(1);
    }

    // A network blip: still signed in, so the loop keeps going rather than
    // giving up on the first run of bad luck.
    expect(checks()).toBe(1);
    expect(urls).toHaveLength(4);
    stop();
  });

  test('a session gone by the third drop stops the loop and re-gates', async () => {
    const events: string[] = [];
    const onExpired = () => events.push('expired');
    addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    const { urls, sockets, checks } = harness(async () => false);

    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.drop();
      await Bun.sleep(1);
    }

    removeEventListener(SESSION_EXPIRED_EVENT, onExpired);

    // No fourth socket: the loop stopped instead of hammering a session that
    // is not coming back, and the shell's gate hears about it exactly once.
    expect(checks()).toBe(1);
    expect(urls).toHaveLength(3);
    expect(events).toEqual(['expired']);
    expect(isReconnecting()).toBe(false);
  });
});
