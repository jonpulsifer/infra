import { describe, expect, test } from 'bun:test';
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
    await Bun.sleep(1);
    expect(urls[1]).toContain('after=41');

    sockets[1]!.message({
      kind: 'attempt',
      entries: [],
      cursor: 42,
      terminal: true,
    });
    sockets[1]!.drop();
    await Bun.sleep(1);
    expect(urls).toHaveLength(2);
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
});
