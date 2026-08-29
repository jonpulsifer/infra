/**
 * kthx serving: the `Host` dispatch that sits in front of the route table,
 * and what a site answers with from a bundle staged through the API.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { GCP_CREDENTIALS_VAR } from '../../src/config/federation-credential.ts';
import {
  KTHX_BUCKET_VAR,
  type KthxDeps,
  kthxDepot,
  kthxZone,
  siteOf,
  withKthxHost,
} from '../../src/kthx/serve.ts';
import { KTHX_PATHS, kthxRoutes } from '../../src/kthx/sites.ts';
import { zipOf } from '../fixtures/zip.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const ZONE = 'kthx.test';

function deps(): KthxDeps {
  return { db: database().db, zone: ZONE, depot: async () => null };
}

/** A table like the real one: a static document, a probe, an API path, a wildcard. */
function table() {
  return withKthxHost(
    {
      '/': new Response('the console'),
      '/healthz': new Response('ok\n'),
      '/kthx/sites': () => new Response('the api'),
      '/*': () => new Response('the status page', { status: 503 }),
    },
    deps(),
  );
}

/** What `Bun.serve` would pick for this path: the exact entry, else the wildcard. */
function get(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Response> | Response | undefined {
  const routes = table();
  const entry = (routes as Record<string, unknown>)[path] ?? routes['/*'];
  return (entry as (request: Request) => Response)(
    new Request(`http://${host}${path}`, {
      method,
      headers: { host, ...headers },
    }),
  );
}

const SITE_ZIP = zipOf([
  { path: 'index.html', text: '<h1>home</h1>' },
  { path: 'style.css', text: 'h1{}' },
  { path: 'about/index.html', text: '<h1>about</h1>' },
  { path: '404.html', text: '<h1>lost</h1>' },
  { path: '_/secret.txt', text: 'reserved' },
  { path: '_/index.html', text: 'reserved' },
]);

/** A site claimed and uploaded through the API, so serving reads real rows. */
async function live(name: string, zip: Uint8Array<ArrayBuffer> = SITE_ZIP) {
  const routes = kthxRoutes(deps());
  const claimed = await routes[KTHX_PATHS[0]]!(
    new Request(`http://${ZONE}/kthx/sites`, {
      method: 'POST',
      headers: { host: ZONE },
      body: JSON.stringify({ name }),
    }),
  );
  const { token } = (await claimed.json()) as { token: string };
  const upload = (bytes: Uint8Array<ArrayBuffer>) =>
    routes[KTHX_PATHS[2]]!(
      new Request(`http://${ZONE}/kthx/sites/${name}/releases`, {
        method: 'POST',
        headers: { host: ZONE, authorization: `Bearer ${token}` },
        body: bytes,
      }),
    );
  expect((await upload(zip)).status).toBe(201);
  const owned = (route: (typeof KTHX_PATHS)[number], init: RequestInit) =>
    routes[route]!(
      new Request(
        `http://${ZONE}/kthx/sites/${name}${route.slice('/kthx/sites/:name'.length)}`,
        {
          ...init,
          headers: { host: ZONE, authorization: `Bearer ${token}` },
        },
      ),
    );
  return { token, upload, owned };
}

describe('the zone', () => {
  test('comes from the environment, and defaults to kthx.dev', () => {
    expect(kthxZone({})).toBe('kthx.dev');
    expect(kthxZone({ KTHX_ZONE: ' Kthx.Localhost ' })).toBe('kthx.localhost');
  });

  test('tells the apex, a site, and everything else apart by Host', () => {
    const at = (host: string) =>
      siteOf(new Request('http://x/', { headers: { host } }), ZONE);
    expect(at('kthx.test')).toBe('');
    expect(at('KTHX.test:3000')).toBe('');
    expect(at('notes.kthx.test')).toBe('notes');
    expect(at('a.b.kthx.test')).toBe('a.b');
    expect(at('spindrift.example.test')).toBeNull();
    expect(at('kthx.test.example')).toBeNull();
    expect(at('')).toBeNull();
  });
});

describe('the depot', () => {
  const CREDENTIAL = join(import.meta.dir, '../fixtures/gcp-credentials.json');

  test('is the named bucket and the mounted credential, and no manifest', async () => {
    expect(
      await kthxDepot({
        [KTHX_BUCKET_VAR]: ' sites-bundles ',
        [GCP_CREDENTIALS_VAR]: CREDENTIAL,
      }),
    ).toEqual({
      bucket: 'sites-bundles',
      federation: {
        audience:
          '//iam.example.test/projects/1/locations/global/workloadIdentityPools/example/providers/cluster',
        tokenUrl: 'https://sts.example.test/v1/token',
        tokenPath: '/var/run/secrets/cloud/token',
        impersonationUrl:
          'https://iamcredentials.example.test/v1/projects/-/serviceAccounts/spindrift@example-home.example.test:generateAccessToken',
      },
    });
  });

  test('is null where the deployment names none, so the caller keeps its fallback', async () => {
    expect(await kthxDepot({ [GCP_CREDENTIALS_VAR]: CREDENTIAL })).toBeNull();
    expect(await kthxDepot({ [KTHX_BUCKET_VAR]: '  ' })).toBeNull();
    // A bucket with nothing to federate with is not a depot either.
    expect(await kthxDepot({ [KTHX_BUCKET_VAR]: 'sites-bundles' })).toBeNull();
  });
});

describe('Host dispatch', () => {
  test('a host that is not kthx reaches the table untouched', async () => {
    expect(await (await get('spindrift.example.test', '/'))!.text()).toBe(
      'the console',
    );
    expect((await get('spindrift.example.test', '/nope'))!.status).toBe(503);
    // A static entry is cloned per request rather than consumed once.
    expect(
      await (await get('spindrift.example.test', '/healthz'))!.text(),
    ).toBe('ok\n');
    expect(
      await (await get('spindrift.example.test', '/healthz'))!.text(),
    ).toBe('ok\n');
  });

  test('the apex serves the landing page at / and lets the API through', async () => {
    const landing = await get(ZONE, '/');
    expect(landing!.status).toBe(200);
    expect(landing!.headers.get('content-type')).toContain('text/html');
    const html = await landing!.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('/kthx/sites');
    expect(await (await get(ZONE, '/kthx/sites'))!.text()).toBe('the api');
    expect((await get(ZONE, '/healthz'))!.status).toBe(404);
  });

  test('a name nothing answers to is the kthx 404 page', async () => {
    const response = await get('nobody.kthx.test', '/');
    expect(response!.status).toBe(404);
    expect(await response!.text()).toContain('No site here yet.');
    expect(response!.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a site', () => {
  test('serves the release it points at, with the headers the contract names', async () => {
    await live('notes');
    const home = await get('notes.kthx.test', '/');
    expect(home!.status).toBe(200);
    expect(await home!.text()).toBe('<h1>home</h1>');
    expect(home!.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(home!.headers.get('cache-control')).toBe('public, max-age=60');
    expect(home!.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home!.headers.get('etag')).toMatch(
      /^"sha256:[0-9a-f]{64}:\/index\.html"$/,
    );

    const css = await get('notes.kthx.test', '/style.css');
    expect(css!.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const cached = await get('notes.kthx.test', '/', {
      'if-none-match': home!.headers.get('etag')!,
    });
    expect(cached!.status).toBe(304);
  });

  test('a directory is its index.html, with or without the slash', async () => {
    await live('notes');
    expect(await (await get('notes.kthx.test', '/about/'))!.text()).toBe(
      '<h1>about</h1>',
    );
    expect(await (await get('notes.kthx.test', '/about'))!.text()).toBe(
      '<h1>about</h1>',
    );
  });

  test('a missing path is the bundle 404.html, and /_/ is never a bundle file', async () => {
    await live('notes');
    const lost = await get('notes.kthx.test', '/nope');
    expect(lost!.status).toBe(404);
    expect(await lost!.text()).toBe('<h1>lost</h1>');

    for (const path of ['/_/secret.txt', '/_']) {
      const reserved = await get('notes.kthx.test', path);
      expect(reserved!.status).toBe(404);
      expect(await reserved!.text()).toContain('No site here yet.');
    }
  });

  test('a wrapper directory is unwrapped, and an upload without 404.html gets the kthx page', async () => {
    await live(
      'wrapped',
      zipOf([{ path: 'site/index.html', text: '<h1>inside</h1>' }]),
    );
    expect(await (await get('wrapped.kthx.test', '/'))!.text()).toBe(
      '<h1>inside</h1>',
    );
    const lost = await get('wrapped.kthx.test', '/nope');
    expect(lost!.status).toBe(404);
    expect(await lost!.text()).toContain('No site here yet.');
  });

  test('a rollback changes what is served; a delete answers 410', async () => {
    const site = await live('notes');
    await site.upload(zipOf([{ path: 'index.html', text: '<h1>v2</h1>' }]));
    expect(await (await get('notes.kthx.test', '/'))!.text()).toBe(
      '<h1>v2</h1>',
    );

    await site.owned(KTHX_PATHS[3], {
      method: 'POST',
      body: JSON.stringify({ n: 1 }),
    });
    expect(await (await get('notes.kthx.test', '/'))!.text()).toBe(
      '<h1>home</h1>',
    );

    await site.owned(KTHX_PATHS[1], { method: 'DELETE' });
    const gone = await get('notes.kthx.test', '/');
    expect(gone!.status).toBe(410);
    expect(await gone!.text()).toContain('This site is gone.');
  });

  test('a claimed name with nothing uploaded is not here yet', async () => {
    const routes = kthxRoutes(deps());
    await routes[KTHX_PATHS[0]]!(
      new Request(`http://${ZONE}/kthx/sites`, {
        method: 'POST',
        headers: { host: ZONE },
        body: JSON.stringify({ name: 'empty' }),
      }),
    );
    const response = await get('empty.kthx.test', '/');
    expect(response!.status).toBe(404);
    expect(await response!.text()).toContain('No site here yet.');
  });
});

describe('the generic favicon', () => {
  const bytesOf = async (response: Response) =>
    new Uint8Array(await response.arrayBuffer());

  test('a site with no icon of its own gets it, ahead of 404.html', async () => {
    await live('notes'); // SITE_ZIP ships a 404.html and no favicon
    const icon = await get('notes.kthx.test', '/favicon.ico');
    expect(icon!.status).toBe(200);
    expect(icon!.headers.get('content-type')).toBe('image/x-icon');
    expect(icon!.headers.get('cache-control')).toBe('public, max-age=60');
    expect(icon!.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = await bytesOf(icon!);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 1, 0]); // an ICO directory
    expect(bytes.byteLength).toBe(230);

    // The apex has no bundle at all and answers with the same bytes.
    const apex = await get(ZONE, '/favicon.ico');
    expect(apex!.status).toBe(200);
    expect(await bytesOf(apex!)).toEqual(bytes);
  });

  test('a bundle that ships its own keeps serving it', async () => {
    await live(
      'own',
      zipOf([
        { path: 'index.html', text: '<h1>home</h1>' },
        { path: 'favicon.ico', text: 'the bundle icon' },
      ]),
    );
    const icon = await get('own.kthx.test', '/favicon.ico');
    expect(icon!.status).toBe(200);
    expect(await icon!.text()).toBe('the bundle icon');
    expect(icon!.headers.get('cache-control')).toBe('public, max-age=60');
  });

  test('it revalidates and answers HEAD like any other file', async () => {
    await live('notes');
    const icon = await get('notes.kthx.test', '/favicon.ico');
    const etag = icon!.headers.get('etag')!;
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}:\/favicon\.ico"$/);

    const cached = await get('notes.kthx.test', '/favicon.ico', {
      'if-none-match': etag,
    });
    expect(cached!.status).toBe(304);
    expect(await cached!.text()).toBe('');

    const head = await get(ZONE, '/favicon.ico', {}, 'HEAD');
    expect(head!.status).toBe(200);
    expect(head!.headers.get('etag')).toBe(etag);
    expect(await head!.text()).toBe('');
  });
});
