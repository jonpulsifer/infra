import { afterEach, describe, expect, test } from 'bun:test';
import { ARI_LISTS, AriClient, METRICS_PATH } from '../src/board/ari.ts';
import type { AriChannel } from '../src/board/ari-types.ts';
import { BoardModel } from '../src/board/model.ts';
import type { Fields, Log } from '../src/log.ts';
import { channel, PLAN } from './board-fixtures.ts';

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
  const requests: {
    url: string;
    method: string;
    authorization: string | null;
  }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const payload = body(path);
    return new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { status: status(path) },
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
    fetch: fetchImpl,
    timings: { pollMs: 5, metricsMs: 60_000, backoffMs: [5], ...timings },
  });
  client.start();
  return { model, lines };
}

describe('the ARI client', () => {
  test('reads only the paths pbx-ari admits, with the credential in a header', async () => {
    const { impl, requests } = fakeFetch(
      () => 200,
      (path) => (path === METRICS_PATH ? '' : []),
    );
    const { model } = start(impl);
    await until(() => model.snapshot().asterisk.ari === 'connected');
    await until(() => requests.length > 2 * ARI_LISTS.length);
    const allowed: string[] = [...ARI_LISTS, METRICS_PATH];
    for (const r of requests) {
      const url = new URL(r.url);
      expect(allowed).toContain(url.pathname);
      expect(url.search).toBe('');
      expect(r.method).toBe('GET');
      expect(r.url).not.toContain(PASSWORD);
      if (url.pathname === METRICS_PATH) expect(r.authorization).toBeNull();
      else
        expect(r.authorization).toBe(
          `Basic ${btoa(`switchboard:${PASSWORD}`)}`,
        );
    }
  });

  test('follows the PBX from one poll to the next', async () => {
    let channels: AriChannel[] = [
      channel('1.1', 'PJSIP/vms-1994-00000001', {
        context: 'from-voipms',
        exten: 's',
        vars: { HANDSET: 'line4', SCREEN: 'yes' },
      }),
    ];
    const { impl } = fakeFetch(
      () => 200,
      (path) => (path === '/ari/channels' ? channels : []),
    );
    const { model, lines } = start(impl);
    await until(() => model.snapshot().calls.length === 1);
    channels = [
      channel('1.1', 'PJSIP/vms-1994-00000001', {
        context: 'spam',
        exten: 'queue',
        vars: { HANDSET: 'line4', SCREEN: 'yes' },
      }),
    ];
    await until(
      () => model.snapshot().calls[0]?.stage.label === 'held: Endless Queue',
    );
    channels = [];
    await until(() => model.snapshot().recent.length === 1);
    expect(lines.filter((l) => l.includes('ari connected'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  test('says when the credential is refused, and recovers', async () => {
    let status = 401;
    const { impl } = fakeFetch(
      (path) => (path.startsWith('/ari/') ? status : 200),
      () => [],
    );
    const { model, lines } = start(impl);
    await until(() => model.snapshot().asterisk.reason === 'unauthorized');
    expect(model.snapshot().asterisk.ari).toBe('disconnected');
    status = 200;
    await until(() => model.snapshot().asterisk.ari === 'connected');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  test('names a path the network policy refuses', async () => {
    const { impl } = fakeFetch(
      (path) => (path === '/ari/bridges' ? 403 : 200),
      () => [],
    );
    const { model } = start(impl);
    await until(() => model.snapshot().asterisk.reason === 'forbidden');
  });

  test('treats a reply that is not a list as an error', async () => {
    const { impl } = fakeFetch(
      () => 200,
      (path) => (path === '/ari/channels' ? '<html>' : []),
    );
    const { model } = start(impl);
    await until(() => model.snapshot().asterisk.reason === 'http-error');
  });

  test('stops polling when stopped', async () => {
    const { impl, requests } = fakeFetch(
      () => 200,
      () => [],
    );
    const { model } = start(impl);
    await until(() => model.snapshot().asterisk.ari === 'connected');
    client?.stop();
    await new Promise((r) => setTimeout(r, 20));
    const seen = requests.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(requests.length).toBe(seen);
  });

  test('reads registrations from /metrics and says when it cannot', async () => {
    let up = true;
    const { impl } = fakeFetch(
      (path) => (path === METRICS_PATH && !up ? 503 : 200),
      (path) =>
        path === METRICS_PATH
          ? 'asterisk_pjsip_outbound_registration_status{username="sip:168847_1994@pop"} 1\n'
          : [],
    );
    const { model } = start(impl, { metricsMs: 10 });
    await until(() => model.snapshot().lines[3]?.registration === 'registered');
    up = false;
    await until(() => model.snapshot().asterisk.metrics === 'failing');
  });
});
