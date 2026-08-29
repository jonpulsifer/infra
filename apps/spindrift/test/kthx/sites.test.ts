/**
 * The kthx API: claim, upload, roll back, hold, delete — over real rows and
 * the local staging fallback, with the handlers `routes.ts` mounts.
 */
import { describe, expect, test } from 'bun:test';
import type { KthxDeps } from '../../src/kthx/serve.ts';
import {
  KTHX_PATHS,
  kthxRoutes,
  limited,
  MAX_UNPACKED_BYTES,
  MAX_UPLOADS,
  nameProblem,
  RESERVED_NAMES,
} from '../../src/kthx/sites.ts';
import { zipOf } from '../fixtures/zip.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const ZONE = 'kthx.test';

function deps(): KthxDeps {
  return { db: database().db, zone: ZONE, depot: async () => null };
}

const [SITES, SITE, RELEASES, SERVE, HOLD] = KTHX_PATHS;

function call(
  route: (typeof KTHX_PATHS)[number],
  path: string,
  init: RequestInit & { token?: string; host?: string } = {},
): Promise<Response> {
  const { token, host = ZONE, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('host', host);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  return kthxRoutes(deps())[route]!(
    new Request(`http://${host}${path}`, { ...rest, headers }),
  );
}

async function claim(name: string, host?: string) {
  const response = await call(SITES, '/kthx/sites', {
    method: 'POST',
    body: JSON.stringify({ name }),
    ...(host === undefined ? {} : { host }),
  });
  return { status: response.status, body: await response.json() };
}

/** A site of ours: claimed, with its token in hand. */
async function mine(name = 'notes') {
  const claimed = await claim(name);
  expect(claimed.status).toBe(201);
  return { name, token: claimed.body.token as string };
}

const SITE_ZIP = zipOf([
  { path: 'index.html', text: '<h1>v1</h1>' },
  { path: 'style.css', text: 'h1{}' },
]);

async function upload(
  name: string,
  token: string,
  bytes: Uint8Array<ArrayBuffer> = SITE_ZIP,
  filename = 'site.zip',
  address?: string,
) {
  const response = await call(RELEASES, `/kthx/sites/${name}/releases`, {
    method: 'POST',
    token,
    headers: {
      'x-filename': filename,
      ...(address === undefined ? {} : { 'cf-connecting-ip': address }),
    },
    body: bytes,
  });
  return { status: response.status, body: await response.json() };
}

/** How many more requests an address may make before the bucket refuses it. */
function budgetOf(address: string): number {
  const from = () =>
    new Request(`http://${ZONE}/kthx/sites`, {
      headers: { 'cf-connecting-ip': address },
    });
  let left = 0;
  while (!limited(from(), undefined)) left += 1;
  return left;
}

async function inspect(name: string, token?: string) {
  const response = await call(SITE, `/kthx/sites/${name}`, {
    ...(token === undefined ? {} : { token }),
  });
  return { status: response.status, body: await response.json() };
}

async function serve(name: string, token: string, n: unknown) {
  const response = await call(SERVE, `/kthx/sites/${name}/serve`, {
    method: 'POST',
    token,
    body: JSON.stringify({ n }),
  });
  return { status: response.status, body: await response.json() };
}

async function unhold(name: string, token: string) {
  const response = await call(HOLD, `/kthx/sites/${name}/hold`, {
    method: 'DELETE',
    token,
  });
  return { status: response.status, body: await response.json() };
}

describe('names', () => {
  test('follow the label rule, the length rule, and the reserved list', () => {
    expect(nameProblem('notes')).toBeNull();
    expect(nameProblem('plum-otter-41')).toBeNull();
    expect(nameProblem('ab')).toBe('INVALID_NAME');
    expect(nameProblem('a'.repeat(41))).toBe('INVALID_NAME');
    expect(nameProblem('-notes')).toBe('INVALID_NAME');
    expect(nameProblem('notes-')).toBe('INVALID_NAME');
    expect(nameProblem('Notes')).toBe('INVALID_NAME');
    expect(nameProblem('a.b')).toBe('INVALID_NAME');
    for (const reserved of RESERVED_NAMES) {
      expect(nameProblem(reserved)).not.toBeNull();
    }
    expect(nameProblem('www')).toBe('RESERVED');
  });
});

describe('claiming', () => {
  test('a free name answers 201 with the token, shown once', async () => {
    const claimed = await claim('notes');
    expect(claimed.status).toBe(201);
    expect(claimed.body.name).toBe('notes');
    expect(claimed.body.url).toBe('https://notes.kthx.test');
    expect(claimed.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The token is not stored: nothing but its hash is on the row.
    const [row] = await database().client.unsafe(
      "select token_hash from kthx_sites where name = 'notes'",
    );
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(claimed.body.token);
  });

  test('a reserved, invalid, or taken name is refused by code', async () => {
    expect(await claim('www')).toMatchObject({
      status: 400,
      body: { code: 'RESERVED' },
    });
    expect(await claim('ab')).toMatchObject({
      status: 400,
      body: { code: 'INVALID_NAME' },
    });
    expect((await claim('notes')).status).toBe(201);
    expect(await claim('notes')).toMatchObject({
      status: 409,
      body: { code: 'TAKEN' },
    });
  });

  test('the API answers on the apex only', async () => {
    const elsewhere = await claim('notes', 'spindrift.example.test');
    expect(elsewhere.status).toBe(404);
    const onASite = await claim('notes', 'other.kthx.test');
    expect(onASite.status).toBe(404);
  });

  test('a burst from one address is capped', async () => {
    const server = {
      requestIP: () => ({ address: '203.0.113.7', port: 1, family: 'IPv4' }),
    } as unknown as Bun.Server<unknown>;
    const route = kthxRoutes(deps())[SITES]!;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await route(
        new Request(`http://${ZONE}/kthx/sites`, {
          method: 'POST',
          headers: { host: ZONE },
          body: JSON.stringify({ name: `burst-${i}` }),
        }),
        server,
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  test('a flood of fresh addresses does not reset one being held', () => {
    const from = (address: string) =>
      new Request(`http://${ZONE}/kthx/sites`, {
        headers: { 'cf-connecting-ip': address },
      });
    while (!limited(from('198.51.100.9'), undefined)) {
      // drain it
    }
    for (let i = 0; i < 10_001; i += 1)
      limited(from(`10.0.${i >> 8}.${i & 255}`), undefined);
    expect(limited(from('198.51.100.9'), undefined)).toBe(true);
  });
});

describe('ownership', () => {
  test('no bearer is 401, the wrong bearer is 403, no site is 404', async () => {
    const site = await mine();
    expect((await inspect(site.name)).body.code).toBe('UNAUTHENTICATED');
    expect((await inspect(site.name)).status).toBe(401);
    const wrong = await inspect(site.name, `${site.token.slice(1)}x`);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('FORBIDDEN');
    expect((await inspect('nobody', site.token)).status).toBe(404);
    const garbled = await inspect('%E0', site.token);
    expect(garbled).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });
});

describe('releases', () => {
  test('an upload is served at once and listed newest first', async () => {
    const site = await mine();
    const first = await upload(site.name, site.token);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      n: 1,
      serving: 1,
      url: 'https://notes.kthx.test',
    });
    expect(first.body.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const second = await upload(
      site.name,
      site.token,
      zipOf([{ path: 'index.html', text: '<h1>v2</h1>' }]),
    );
    expect(second.body).toMatchObject({ n: 2, serving: 2 });

    const shown = await inspect(site.name, site.token);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      name: 'notes',
      serving: 2,
      held: false,
    });
    expect(shown.body.releases.map((r: { n: number }) => r.n)).toEqual([2, 1]);
    expect(shown.body.releases[0].digest).toBe(second.body.digest);
    expect(shown.body.releases[0].size).toBeGreaterThan(0);
    expect(Date.parse(shown.body.releases[0].at)).toBeGreaterThan(0);
  });

  test('a gzipped tar is taken as it is, and anything else is refused', async () => {
    const site = await mine();
    // The same bytes the ZIP path stages, handed over as a tar.gz directly.
    const staged = await upload(site.name, site.token);
    const tarball = Bun.file(
      `${process.env.SPINDRIFT_STORAGE_DIR ?? `${require('node:os').tmpdir()}/spindrift-archives`}/${staged.body.digest.slice(7)}.gz`,
    );
    const again = await upload(
      site.name,
      site.token,
      new Uint8Array(await tarball.arrayBuffer()),
      'site.tar.gz',
    );
    expect(again.status).toBe(201);
    expect(again.body.digest).toBe(staged.body.digest);

    const text = await upload(
      site.name,
      site.token,
      new TextEncoder().encode('<h1>not an archive</h1>'),
      'index.html',
    );
    expect(text.status).toBe(400);
    expect(text.body.code).toBe('UNKNOWN_FORMAT');
  });

  test('a bundle with no index.html at its root is refused before it is stored', async () => {
    const site = await mine();
    const refused = await upload(
      site.name,
      site.token,
      zipOf([{ path: 'about.html', text: 'hi' }]),
    );
    expect(refused).toMatchObject({ status: 400, body: { code: 'NO_INDEX' } });
    // A wrapper directory is not the root; the file inside it is.
    const wrapped = await upload(
      site.name,
      site.token,
      zipOf([{ path: 'site/index.html', text: 'hi' }]),
    );
    expect(wrapped.status).toBe(201);
    expect((await inspect(site.name, site.token)).body.releases).toHaveLength(
      1,
    );
  });

  test('an archive over the limit is 413', async () => {
    const site = await mine();
    const huge = await upload(
      site.name,
      site.token,
      new Uint8Array(25 * 1024 * 1024 + 1),
    );
    expect(huge).toMatchObject({ status: 413, body: { code: 'TOO_LARGE' } });
  });

  test('an archive that unpacks over the limit is 413, as gzip and as zip', async () => {
    const site = await mine();
    const zeros = new Uint8Array(MAX_UNPACKED_BYTES + 1);
    const gzipped = await upload(
      site.name,
      site.token,
      Bun.gzipSync(zeros),
      'site.tar.gz',
    );
    expect(gzipped).toMatchObject({
      status: 413,
      body: { code: 'TOO_LARGE' },
    });
    // A ZIP is refused on what its central directory declares, before any
    // entry inflates: a small archive claiming a huge entry is enough.
    const lying = zipOf([{ path: 'index.html', text: '<h1>v1</h1>' }]);
    const view = new DataView(lying.buffer);
    let central = 0;
    while (view.getUint32(central, true) !== 0x02014b50) central += 1;
    view.setUint32(central + 24, MAX_UNPACKED_BYTES + 1, true);
    const zipped = await upload(site.name, site.token, lying);
    expect(zipped).toMatchObject({ status: 413, body: { code: 'TOO_LARGE' } });
  });

  test('only MAX_UPLOADS unpack at once; the rest are told the process is full', async () => {
    const site = await mine();
    // Fresh addresses: '203.0.113.7' is drained by the burst test above.
    const address = '198.51.100.20';
    // Fired together so every one of them is past ownership and inside the
    // handler before the first finishes staging.
    const statuses = await Promise.all(
      Array.from({ length: MAX_UPLOADS + 1 }, (_, i) =>
        upload(
          site.name,
          site.token,
          zipOf([{ path: 'index.html', text: `<h1>v${i}</h1>` }]),
          'site.zip',
          address,
        ),
      ),
    );
    const taken = statuses.filter((r) => r.status === 201);
    const refused = statuses.filter((r) => r.status !== 201);
    expect(taken).toHaveLength(MAX_UPLOADS);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 503, body: { code: 'BUSY' } });

    // Only the uploads that actually unpacked spent a token: a client told to
    // come back in a moment must not walk into 429 for a neighbour's fault.
    expect(budgetOf('198.51.100.21') - budgetOf(address)).toBe(MAX_UPLOADS);

    // The slot is given back, so the site takes uploads again afterwards.
    expect((await upload(site.name, site.token)).status).toBe(201);
  });
});

describe('rolling back and holding', () => {
  test('serving an older release sets the hold; a held site keeps serving it', async () => {
    const site = await mine();
    await upload(site.name, site.token);
    await upload(
      site.name,
      site.token,
      zipOf([{ path: 'index.html', text: '<h1>v2</h1>' }]),
    );

    expect(await serve(site.name, site.token, 1)).toMatchObject({
      status: 200,
      body: { serving: 1, held: true },
    });

    const third = await upload(
      site.name,
      site.token,
      zipOf([{ path: 'index.html', text: '<h1>v3</h1>' }]),
    );
    expect(third.body).toMatchObject({ n: 3, serving: 1 });
    expect((await inspect(site.name, site.token)).body).toMatchObject({
      serving: 1,
      held: true,
    });

    // Forward is the same act, and also holds.
    expect((await serve(site.name, site.token, 3)).body).toEqual({
      serving: 3,
      held: true,
    });

    expect(await unhold(site.name, site.token)).toMatchObject({
      status: 200,
      body: { held: false, serving: 3 },
    });
    expect((await serve(site.name, site.token, 9)).status).toBe(404);
    expect((await serve(site.name, site.token, 'one')).status).toBe(404);
  });
});

describe('deleting', () => {
  test('answers 204, and the name stays taken', async () => {
    const site = await mine();
    const gone = await call(SITE, `/kthx/sites/${site.name}`, {
      method: 'DELETE',
      token: site.token,
    });
    expect(gone.status).toBe(204);
    expect((await inspect(site.name, site.token)).status).toBe(404);
    expect((await claim(site.name)).status).toBe(409);
  });
});
