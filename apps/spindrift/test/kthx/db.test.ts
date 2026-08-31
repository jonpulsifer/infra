/**
 * kthx `db`: JSON by key on a site host, with the CAS the SDK's `update`
 * loops over — reached through the same Host dispatch a site's files are.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_KEYS, MAX_VALUE_BYTES } from '@repo/kthx';
import { kthxKv } from '../../src/db/schema.ts';
import { type KthxDeps, withKthxHost } from '../../src/kthx/serve.ts';
import { KTHX_PATHS, kthxRoutes } from '../../src/kthx/sites.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const ZONE = 'kthx.test';
const HOST = `notes.${ZONE}`;

function deps(): KthxDeps {
  return { db: database().db, zone: ZONE, depot: async () => null };
}

/** A claimed name; `db` works before anything is uploaded. */
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

function call(
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const { host = HOST, ...rest } = init;
  const routes = withKthxHost(
    { '/*': () => new Response('the status page', { status: 503 }) },
    deps(),
  );
  // Called as `Bun.serve` would, minus the server: nothing here publishes.
  const wildcard = routes['/*'] as unknown as (
    request: Request,
    server?: Bun.Server<unknown>,
  ) => Promise<Response>;
  return wildcard(
    new Request(`http://${host}${path}`, {
      ...rest,
      headers: { host, ...(rest.headers as Record<string, string>) },
    }),
  );
}

const json = (value: unknown, headers: Record<string, string> = {}) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

describe('/_/db', () => {
  test('a key is set, read back with its etag, listed by prefix, and removed', async () => {
    await claim();
    expect((await call('/_/db/votes')).status).toBe(404);

    const put = await call('/_/db/votes', json({ optiplex: 3, riptide: 1 }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      key: 'votes',
      value: { optiplex: 3, riptide: 1 },
    });
    expect(put.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);

    const got = await call('/_/db/votes');
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ optiplex: 3, riptide: 1 });
    expect(got.headers.get('etag')).toBe(put.headers.get('etag'));
    expect(got.headers.get('cache-control')).toBe('no-store');

    // A scalar is a value too, and round-trips as itself.
    await call('/_/db/rsvp%2Falice', json('yes'));
    await call('/_/db/rsvp%2Fbob', json(42));
    expect(await (await call('/_/db/rsvp%2Falice')).json()).toBe('yes');
    expect(await (await call('/_/db?prefix=rsvp%2F')).json()).toEqual({
      items: [
        { key: 'rsvp/alice', value: 'yes' },
        { key: 'rsvp/bob', value: 42 },
      ],
    });
    expect((await (await call('/_/db')).json()).items).toHaveLength(3);

    expect((await call('/_/db/votes', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/_/db/votes')).status).toBe(404);
    expect((await call('/_/db/votes', { method: 'DELETE' })).status).toBe(204);
  });

  test('equal values hash equal whatever the key order, and if-match is the CAS', async () => {
    await claim();
    const first = await call('/_/db/votes', json({ a: 1, b: 2 }));
    const etag = first.headers.get('etag')!;
    const same = await call('/_/db/votes', json({ b: 2, a: 1 }));
    expect(same.headers.get('etag')).toBe(etag);

    const stale = await call(
      '/_/db/votes',
      json({ a: 2 }, { 'if-match': '"0000"' }),
    );
    expect(stale.status).toBe(412);
    expect((await stale.json()).code).toBe('PRECONDITION_FAILED');

    const fresh = await call(
      '/_/db/votes',
      json({ a: 2 }, { 'if-match': etag }),
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).not.toBe(etag);

    // The second creator of a key loses, rather than overwriting the first.
    const create = await call(
      '/_/db/new',
      json({ n: 1 }, { 'if-none-match': '*' }),
    );
    expect(create.status).toBe(200);
    const again = await call(
      '/_/db/new',
      json({ n: 2 }, { 'if-none-match': '*' }),
    );
    expect(again.status).toBe(412);
    expect(await (await call('/_/db/new')).json()).toEqual({ n: 1 });
  });

  test('refuses what the contract bounds', async () => {
    await claim();
    expect((await call('/_/db/votes', json(null))).status).toBe(400);
    expect(
      (
        await call('/_/db/votes', {
          method: 'PUT',
          body: 'not json',
        })
      ).status,
    ).toBe(400);
    expect((await call(`/_/db/${'k'.repeat(257)}`, json(1))).status).toBe(400);
    expect(
      (await call('/_/db/big', json('x'.repeat(MAX_VALUE_BYTES)))).status,
    ).toBe(413);
    expect(
      (await call('/_/db/votes', { method: 'PUT', body: '1e400' })).status,
    ).toBe(400);
    expect((await call('/_/db/a%00b', json(1))).status).toBe(400);
    expect((await call('/_/db/votes', json('a\0b'))).status).toBe(400);
    expect((await call('/_/db/votes', json('a\\u0000b'))).status).toBe(200);
    expect((await call('/_/db?prefix=%00')).status).toBe(400);
    expect(
      (
        await call('/_/db/deep', {
          method: 'PUT',
          body: '['.repeat(20000),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/_/db/big', {
          method: 'PUT',
          body: ' '.repeat(3 * MAX_VALUE_BYTES),
        })
      ).status,
    ).toBe(413);
    expect((await call('/_/db/votes', { method: 'POST' })).status).toBe(405);
    const nope = await call('/_/nope');
    expect(nope.status).toBe(404);
    expect(await nope.text()).toContain('No site here yet.');
  });

  test('is scoped to the site, and a name nobody claimed has none', async () => {
    await claim('notes');
    await claim('other');
    await call('/_/db/votes', json(1));
    expect((await call('/_/db/votes', { host: `other.${ZONE}` })).status).toBe(
      404,
    );
    const nobody = await call('/_/db/votes', { host: `nobody.${ZONE}` });
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toContain('No site here yet.');
  });

  test('a full site refuses a new key but still takes a write to an old one', async () => {
    await claim();
    // Fill it underneath the handler: the ceiling is what is being tested,
    // not a thousand round trips through it.
    await database()
      .db.insert(kthxKv)
      .values(
        Array.from({ length: MAX_KEYS }, (_, n) => ({
          site: 'notes',
          key: `k${n}`,
          value: n,
          etag: `"${n}"`,
        })),
      );

    const fresh = await call('/_/db/one-too-many', json({ over: true }));
    expect(fresh.status).toBe(507);
    expect(await fresh.json()).toMatchObject({ code: 'SITE_FULL' });

    // A key that already exists adds no row, so the ceiling does not apply.
    const existing = await call('/_/db/k0', json({ still: 'writable' }));
    expect(existing.status).toBe(200);
    expect(await (await call('/_/db/k0')).json()).toEqual({
      still: 'writable',
    });

    // And deleting one makes room again.
    expect((await call('/_/db/k1', { method: 'DELETE' })).status).toBe(204);
    expect(
      (await call('/_/db/one-too-many', json({ now: 'fits' }))).status,
    ).toBe(200);
  });

  test('writes are held by address; reads and me are not', async () => {
    await claim();
    const from = (address: string, path: string, init: RequestInit = {}) =>
      call(path, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'cf-connecting-ip': address,
        },
      });

    // The bucket is 30 deep, so the 31st write from one address is refused.
    let refused: Response | undefined;
    for (let n = 0; n < 40; n++) {
      const response = await from('203.0.113.9', `/_/db/n${n}`, json({ n }));
      if (response.status === 429) {
        refused = response;
        break;
      }
    }
    expect(refused).toBeDefined();
    expect(await refused!.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // Reading is not spent against it — `db.watch` on a busy site must work.
    expect((await from('203.0.113.9', '/_/db/n0')).status).toBe(200);
    expect((await from('203.0.113.9', '/_/me')).status).toBe(200);

    // And the hold is per address, not per site.
    expect(
      (await from('203.0.113.10', '/_/db/other', json({ ok: true }))).status,
    ).toBe(200);
  });
});

describe('/_/me and the SDK', () => {
  test('me is a cookie minted on first sight and read back after', async () => {
    await claim();
    const first = await call('/_/me');
    const { id } = (await first.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.headers.get('set-cookie')).toContain(`kthx_me=${id}; Path=/;`);
    expect(first.headers.get('set-cookie')).toContain('SameSite=Lax');

    const again = await call('/_/me', { headers: { cookie: `kthx_me=${id}` } });
    expect(await again.json()).toEqual({ id });
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  test('the SDK is the same script on the apex and on a site', async () => {
    await claim();
    const apex = await call('/sdk.js', { host: ZONE });
    const site = await call('/_/sdk.js');
    for (const response of [apex, site]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    }
    const script = await site.text();
    expect(script).toBe(await apex.text());
    // What it exports is the SDK's business and changes with it; what this
    // route promises is that both paths are the same script.
    expect(script).toContain('window.kthx =');
  });
});
