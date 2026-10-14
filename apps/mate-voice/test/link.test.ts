import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { MateLink } from '../src/link.ts';
import { silentLog } from '../src/log.ts';
import type { FromMate } from '../src/protocol.ts';
import { CHANNEL, GUILD, OWNER } from './fakes.ts';

function mate() {
  const sockets: ServerWebSocket<unknown>[] = [];
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(_ws, message) {
        received.push(String(message));
      },
    },
  });
  return {
    server,
    sockets,
    received,
    url: `ws://127.0.0.1:${server.port}/voice`,
  };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
}

const links: MateLink[] = [];
const servers: ReturnType<typeof mate>[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.stop();
  for (const { server } of servers.splice(0)) server.stop(true);
});

describe('mate link', () => {
  test('dials, sends, hears mate, and swallows heartbeats', async () => {
    const m = mate();
    servers.push(m);
    const opened: number[] = [];
    const messages: FromMate[] = [];
    const link = new MateLink({
      url: m.url,
      log: silentLog,
      heartbeatMs: 50,
      connectTimeoutMs: 1_000,
      onOpen: () => opened.push(Date.now()),
      onMessage: (message) => messages.push(message),
      onClose: () => {},
    });
    links.push(link);
    expect(link.send({ type: 'heartbeat' })).toBe(false);
    expect(link.dropped).toBe(1);
    link.start();
    await until(() => opened.length === 1);
    expect(link.connected).toBe(true);
    expect(link.send({ type: 'ready', protocol: 1, version: 't' })).toBe(true);
    await until(() => m.received.length >= 1);
    expect(JSON.parse(m.received[0] ?? '')).toEqual({
      type: 'ready',
      protocol: 1,
      version: 't',
    });
    m.sockets[0]?.send(JSON.stringify({ type: 'heartbeat' }));
    m.sockets[0]?.send(
      JSON.stringify({
        type: 'join',
        guildId: GUILD,
        channelId: CHANNEL,
        ownerId: OWNER,
      }),
    );
    await until(() => messages.length === 1);
    expect(messages[0]?.type).toBe('join');
    // Its own heartbeats keep flowing while mate answers.
    const keepAlive = setInterval(
      () => m.sockets[0]?.send(JSON.stringify({ type: 'heartbeat' })),
      20,
    );
    await until(
      () => m.received.filter((r) => r.includes('heartbeat')).length >= 2,
    );
    clearInterval(keepAlive);
  });

  test('closes a quiet link and redials', async () => {
    const m = mate();
    servers.push(m);
    const opened: number[] = [];
    const closed: number[] = [];
    const link = new MateLink({
      url: m.url,
      log: silentLog,
      heartbeatMs: 30,
      connectTimeoutMs: 1_000,
      onOpen: () => opened.push(Date.now()),
      onMessage: () => {},
      onClose: () => closed.push(Date.now()),
    });
    links.push(link);
    link.start();
    await until(() => opened.length === 1);
    // mate never answers, so after three quiet beats the bridge hangs up.
    await until(() => closed.length === 1, 1_000);
    expect(link.connected).toBe(false);
    await until(() => opened.length === 2, 3_000);
    expect(link.connected).toBe(true);
  });

  test('redials when mate drops it, and stops when told', async () => {
    const m = mate();
    servers.push(m);
    const opened: number[] = [];
    const closed: number[] = [];
    const link = new MateLink({
      url: m.url,
      log: silentLog,
      heartbeatMs: 1_000,
      connectTimeoutMs: 1_000,
      onOpen: () => opened.push(Date.now()),
      onMessage: () => {},
      onClose: () => closed.push(Date.now()),
    });
    links.push(link);
    link.start();
    await until(() => opened.length === 1);
    m.sockets[0]?.close(1012, 'rolling');
    await until(() => closed.length === 1);
    await until(() => opened.length === 2, 3_000);
    link.stop();
    await Bun.sleep(20);
    expect(link.connected).toBe(false);
    expect(closed.length).toBe(1);
  });
});
