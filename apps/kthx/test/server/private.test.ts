/**
 * A deployment with a private host: the landing page differs by door, the
 * owner routes answer an ID token on every door, and site hosts stay public.
 */
import { describe, expect, test } from 'bun:test';
import { readConfig } from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const PRIVATE = 'ops.kthx-private.test';
const kthx = withServer({ controlHost: PRIVATE });

describe('the public apex', () => {
  test("answers the owner's routes to the owner's ID token", async () => {
    const site = await kthx().site('owned');
    const report = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { host: ZONE, token: site.token }),
    );
    expect(report.status).toBe(200);
  });

  test('still reads the directory', async () => {
    const response = await kthx().fetch(ask('/api/sites', { host: ZONE }));
    expect(response.status).toBe(200);
  });

  test('serves the page read only', async () => {
    const page = await kthx().fetch(ask('/', { host: ZONE }));
    expect(await page.text()).toContain(
      `<html lang="en" data-zone="${ZONE}" data-readonly>`,
    );
  });
});

describe('the private host', () => {
  test("answers the owner's routes, and the site answers on the public zone", async () => {
    const site = await kthx().site('priv');
    const report = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { host: PRIVATE, token: site.token }),
    );
    expect(report.status).toBe(200);
    expect((await report.json()).url).toBe(`https://${site.name}.${ZONE}`);

    const served = await kthx().fetch(ask('/api', { host: site.host }));
    expect(served.status).toBe(200);
  });

  test('serves the page as the zone', async () => {
    const page = await kthx().fetch(ask('/', { host: PRIVATE }));
    expect(await page.text()).toContain(`<html lang="en" data-zone="${ZONE}">`);
  });

  test('is not answered to a request that came through Cloudflare', async () => {
    const response = await kthx().fetch(
      ask('/api/sites', { host: PRIVATE, address: '203.0.113.9' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('the Console link', () => {
  const CONSOLE = `https://${PRIVATE}/`;
  const linked = withServer({ controlHost: PRIVATE, consoleUrl: CONSOLE });

  test('is named on every door when the installation has a console', async () => {
    for (const [host, readonly] of [
      [ZONE, ' data-readonly'],
      [PRIVATE, ''],
    ] as const) {
      const page = await linked().fetch(ask('/', { host }));
      expect(await page.text()).toContain(
        `<html lang="en" data-zone="${ZONE}"${readonly} data-console="${CONSOLE}">`,
      );
    }
  });

  test('stays out of GET /api', async () => {
    const response = await linked().fetch(ask('/api', { host: ZONE }));
    expect(JSON.stringify(await response.json())).not.toContain(PRIVATE);
  });
});

describe('GET /api on the apex', () => {
  test('states the zone on both hosts, which is how the CLI finds a site', async () => {
    for (const host of [ZONE, PRIVATE]) {
      const response = await kthx().fetch(ask('/api', { host }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        zone: ZONE,
        url: `https://${ZONE}`,
        docs: `https://${ZONE}/skill.md`,
      });
    }
  });
});

describe('the config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
    KTHX_SITES_BUCKET: 'sites',
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

  test('takes only an https console address', () => {
    expect(readConfig(env).consoleUrl).toBeNull();
    expect(
      readConfig({ ...env, KTHX_CONSOLE_URL: ' https://ops.lab.test ' })
        .consoleUrl,
    ).toBe('https://ops.lab.test/');
    for (const url of [
      'http://ops.lab.test',
      'javascript:alert(1)',
      'ops.lab.test',
    ]) {
      expect(() => readConfig({ ...env, KTHX_CONSOLE_URL: url })).toThrow(
        'KTHX_CONSOLE_URL',
      );
    }
  });
});
