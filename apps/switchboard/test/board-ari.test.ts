import { afterEach, describe, expect, test } from 'bun:test';
import { AriClient } from '../src/board/ari.ts';
import { BoardModel } from '../src/board/model.ts';
import type { Fields, Log } from '../src/log.ts';
import { channel, PLAN } from './board-fixtures.ts';

class FakeSocket {
  static last: FakeSocket | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pings = 0;
  terminated = false;
  private pong: (() => void) | undefined;
  constructor(
    readonly url: string,
    readonly options: { headers: Record<string, string> },
  ) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'pong') this.pong = listener;
  }
  ping() {
    this.pings++;
  }
  answerPing() {
    this.pong?.();
  }
  send(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.onclose?.();
  }
  terminate() {
    this.terminated = true;
    this.onclose?.();
  }
}

const PASSWORD = 'hunter2hunter2';
const config = {
  ariUrl: 'http://pbx:8088',
  ariUser: 'switchboard',
  ariPassword: PASSWORD,
};

function fakeLog() {
  const lines: string[] = [];
  const capture = (msg: string, fields?: Fields) =>
    lines.push(JSON.stringify({ msg, ...fields }));
  const log: Log = { info: capture, warn: capture, error: capture };
  return { log, lines };
}

function fakeFetch(
  status: (path: string) => number,
  body: (path: string) => unknown,
) {
  const requests: { url: string; authorization: string | null }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const code = status(path);
    const payload = body(path);
    return new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { status: code },
    );
  }) as unknown as typeof fetch;
  return { impl, requests };
}

// Polls, so a slow runner waits longer instead of failing.
async function until(check: () => boolean, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

let client: AriClient | undefined;
afterEach(() => client?.stop());

function start(fetchImpl: typeof fetch, timings = {}) {
  const model = new BoardModel({ plan: PLAN, recentLimit: 5 });
  const { log, lines } = fakeLog();
  client = new AriClient({
    config,
    model,
    log,
    WebSocket: FakeSocket as never,
    fetch: fetchImpl,
    timings: { metricsMs: 60_000, backoffMs: [5], ...timings },
  });
  client.start();
  return { model, lines, socket: FakeSocket.last as FakeSocket };
}

describe('the ARI client', () => {
  test('subscribes to everything with the credential in a header only', async () => {
    const { impl, requests } = fakeFetch(
      () => 200,
      () => [],
    );
    const { model, socket } = start(impl);
    expect(socket.url).toBe(
      'ws://pbx:8088/ari/events?app=switchboard&subscribeAll=true',
    );
    expect(socket.options.headers.authorization).toBe(
      `Basic ${btoa(`switchboard:${PASSWORD}`)}`,
    );
    socket.onopen?.();
    await until(() => model.snapshot().asterisk.ari === 'connected');
    expect(requests.some((r) => r.url.endsWith('/ari/channels'))).toBe(true);
    for (const r of requests) {
      expect(r.url).not.toContain(PASSWORD);
      if (r.url.includes('/ari/'))
        expect(r.authorization).toStartWith('Basic ');
      else expect(r.authorization).toBeNull();
    }
  });

  test('loads the channels, then applies what arrived while they loaded', async () => {
    const trunk = channel('1.1', 'PJSIP/vms-1994-00000001', {
      context: 'from-voipms',
      exten: 's',
      vars: { HANDSET: 'line4', SCREEN: 'yes' },
    });
    const { impl } = fakeFetch(
      () => 200,
      (path) => (path === '/ari/channels' ? [trunk] : []),
    );
    const { model, socket, lines } = start(impl);
    socket.onopen?.();
    socket.send({
      type: 'ChannelDialplan',
      channel: {
        ...trunk,
        dialplan: {
          context: 'spam',
          exten: 'queue',
          app_name: 'Playback',
          app_data: '',
        },
      },
    });
    expect(model.snapshot().calls).toHaveLength(0);
    await until(() => model.snapshot().asterisk.ari === 'connected');
    const view = model.snapshot();
    expect(view.asterisk.ari).toBe('connected');
    expect(view.calls[0]?.stage.label).toBe('held: Endless Queue');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  test('says when the credential is refused, and tries again', async () => {
    const { impl } = fakeFetch(
      (path) => (path.startsWith('/ari/') ? 401 : 200),
      () => '',
    );
    const { model, socket, lines } = start(impl, { backoffMs: [200] });
    socket.close();
    await until(() => model.snapshot().asterisk.ari === 'disconnected');
    expect(model.snapshot().asterisk.reason).toBe('unauthorized');
    await until(() => FakeSocket.last !== socket);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  test('drops a socket that stops answering pings', async () => {
    const { impl } = fakeFetch(
      () => 200,
      () => [],
    );
    const { socket } = start(impl, { pingMs: 5, pongTimeoutMs: 5 });
    socket.onopen?.();
    await until(() => socket.terminated);
    expect(socket.pings).toBeGreaterThan(0);
  });

  test('reads registrations from /metrics and says when it cannot', async () => {
    let up = true;
    const { impl } = fakeFetch(
      (path) => (path === '/metrics' && !up ? 503 : 200),
      (path) =>
        path === '/metrics'
          ? 'asterisk_pjsip_outbound_registration_status{username="sip:168847_1994@pop"} 1\n'
          : [],
    );
    const { model } = start(impl, { metricsMs: 10 });
    await until(() => model.snapshot().lines[3]?.registration === 'registered');
    up = false;
    await until(() => model.snapshot().asterisk.metrics === 'failing');
  });
});
