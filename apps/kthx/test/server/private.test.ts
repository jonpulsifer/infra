/**
 * A deployment with a private host: the public apex reads the directory and
 * refuses the rest, the private host is the whole control API, and a site host
 * is public either way.
 */
import { describe, expect, test } from 'bun:test';
import { tarGz } from '../../cli/tar.ts';
import { readConfig } from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const PRIVATE = 'ops.kthx-private.test';
const kthx = withServer({ controlHost: PRIVATE });

const SITE = tarGz([
  { path: 'index.html', bytes: new TextEncoder().encode('<h1>hi</h1>') },
]);

function claim(
  name: string,
  host: string,
  extra: Parameters<typeof ask>[1] = {},
) {
  return kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      host,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      ...extra,
    }),
  );
}

describe('the public apex', () => {
  test('refuses a claim and says where claiming lives', async () => {
    const response = await claim(kthx().name('pub'), ZONE, {
      address: '198.51.100.1',
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('PRIVATE');
  });

  test('refuses the owner routes, bearer or not', async () => {
    const name = kthx().name('owned');
    const claimed = await claim(name, PRIVATE);
    expect(claimed.status).toBe(201);
    const { token } = (await claimed.json()) as { token: string };
    for (const [path, init] of [
      [`/api/sites/${name}`, { token }],
      [`/api/sites/${name}/releases`, { method: 'POST', token, body: SITE }],
      ['/api/sites', { method: 'DELETE', token }],
    ] as const) {
      const response = await kthx().fetch(ask(path, { host: ZONE, ...init }));
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PRIVATE');
    }
  });

  test('still reads the directory', async () => {
    const response = await kthx().fetch(ask('/api/sites', { host: ZONE }));
    expect(response.status).toBe(200);
  });

  test('serves the page with the claim deck hidden', async () => {
    const page = await kthx().fetch(ask('/', { host: ZONE }));
    expect(await page.text()).toContain(
      `<html lang="en" data-zone="${ZONE}" data-readonly>`,
    );
  });
});

describe('the private host', () => {
  test('claims and uploads, and the site answers on the public zone', async () => {
    const name = kthx().name('priv');
    const claimed = await claim(name, PRIVATE);
    expect(claimed.status).toBe(201);
    const { token, url } = (await claimed.json()) as {
      token: string;
      url: string;
    };
    expect(url).toBe(`https://${name}.${ZONE}`);

    const uploaded = await kthx().fetch(
      ask(`/api/sites/${name}/releases`, {
        method: 'POST',
        host: PRIVATE,
        token,
        headers: { 'content-type': 'application/gzip' },
        body: SITE,
      }),
    );
    expect(uploaded.status).toBe(201);

    const served = await kthx().fetch(ask('/', { host: `${name}.${ZONE}` }));
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('<h1>hi</h1>');
  });

  test('serves the page as the zone, claim deck and all', async () => {
    const page = await kthx().fetch(ask('/', { host: PRIVATE }));
    expect(await page.text()).toContain(`<html lang="en" data-zone="${ZONE}">`);
  });

  test('is not answered to a request that came through Cloudflare', async () => {
    const response = await claim(kthx().name('edge'), PRIVATE, {
      address: '203.0.113.9',
    });
    expect(response.status).toBe(404);
  });
});

describe('the config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
  };

  test('refuses a private host inside the zone, which would shadow a site', () => {
    for (const host of ['kthx.dev', 'ops.kthx.dev', 'OPS.KTHX.DEV']) {
      expect(() => readConfig({ ...env, KTHX_CONTROL_HOST: host })).toThrow(
        'outside kthx.dev',
      );
    }
    expect(
      readConfig({ ...env, KTHX_CONTROL_HOST: ' Ops.Lab.Test ' }).controlHost,
    ).toBe('ops.lab.test');
    expect(readConfig(env).controlHost).toBeNull();
  });
});
