/**
 * The control API over real rows and a real volume: claim, upload, roll back,
 * hold, delete — and what the upload leaves on disk.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tarGz } from '../../cli/tar.ts';
import { secondsToMidnight } from '../../server/limits.ts';
import {
  MAX_ARCHIVE_BYTES,
  MAX_UNPACKED_BYTES,
  MAX_UNPACKS,
  pruneSite,
  takeSlot,
} from '../../server/releases.ts';
import {
  MAX_CLAIMS_PER_DAY,
  MAX_UPLOADS_PER_DAY,
  nameProblem,
  RESERVED_NAMES,
} from '../../server/sites.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

/** A fresh address per test, so one test's burst is not another's 429. */
let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.51.100.${nextAddress % 250}`;
}

function site(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  return tarGz(
    Object.entries(files).map(([path, text]) => ({
      path,
      bytes: new TextEncoder().encode(text),
    })),
  );
}

const SITE = site({ 'index.html': '<h1>v1</h1>', 'style.css': 'h1{}' });

async function claim(name: string, init: Parameters<typeof ask>[1] = {}) {
  const response = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
      ...init,
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** A site of ours: claimed, with its token in hand. */
async function mine(name = 'notes') {
  const claimed = await claim(name);
  expect(claimed.status).toBe(201);
  return { name, token: claimed.body.token as string };
}

async function upload(
  name: string,
  token: string,
  bytes: Uint8Array<ArrayBuffer> = SITE,
  init: Parameters<typeof ask>[1] = {},
) {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}/releases`, {
      method: 'POST',
      token,
      body: bytes,
      address: address(),
      ...init,
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function inspect(name: string, token?: string) {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}`, token === undefined ? {} : { token }),
  );
  return { status: response.status, body: await response.json() };
}

async function serveRelease(name: string, token: string, n: unknown) {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}/serve`, {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function unhold(name: string, token: string) {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}/hold`, { method: 'DELETE', token }),
  );
  return { status: response.status, body: await response.json() };
}

async function releaseDirs(name: string): Promise<number[]> {
  const entries = await readdir(join(kthx().sitesDir, name)).catch(() => []);
  return entries
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
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
    // A name is also a Postgres database and role.
    expect(nameProblem('postgres')).toBe('RESERVED');
    expect(nameProblem('template0')).toBe('RESERVED');
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
    const [row] = await kthx()
      .sql`select token_hash from sites where name = 'notes'`;
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
    expect((await claim('notes', { host: 'other.kthx.test' })).status).toBe(
      404,
    );
    const elsewhere = await kthx().fetch(
      ask('/api/sites', { method: 'POST', host: 'example.test' }),
    );
    expect(elsewhere.status).toBe(404);
  });

  test('a browser on another kthx host cannot claim through this one', async () => {
    const foreign = await claim('notes', {
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.kthx.test',
      },
    });
    expect(foreign).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    const own = await claim('notes', {
      headers: {
        'content-type': 'application/json',
        origin: `https://${ZONE}`,
      },
    });
    expect(own.status).toBe(201);
  });

  test('a body that is not declared JSON is refused', async () => {
    const response = await kthx().fetch(
      ask('/api/sites', {
        method: 'POST',
        body: JSON.stringify({ name: 'notes' }),
        address: address(),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('MALFORMED_REQUEST');
  });

  test('one address gets a day of claims and no more', async () => {
    const from = address();
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < MAX_CLAIMS_PER_DAY + 1; i += 1) {
      last = await kthx().fetch(
        ask('/api/sites', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: `burst-${i}` }),
          address: from,
        }),
      );
      statuses.push(last.status);
    }
    expect(statuses.slice(0, MAX_CLAIMS_PER_DAY).every((s) => s === 201)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);
    // The day is what it waits for, not the minute — which at 23:59 UTC is
    // fewer than sixty seconds, so the number itself is what is asserted.
    const wait = Number(last?.headers.get('retry-after'));
    expect(Math.abs(wait - secondsToMidnight())).toBeLessThanOrEqual(2);
  });
});

describe('ownership', () => {
  test('no bearer is 401, the wrong bearer is 403, no site is 404', async () => {
    const owned = await mine();
    expect(await inspect(owned.name)).toMatchObject({
      status: 401,
      body: { code: 'UNAUTHENTICATED' },
    });
    expect(await inspect(owned.name, `${owned.token.slice(1)}x`)).toMatchObject(
      {
        status: 403,
        body: { code: 'FORBIDDEN' },
      },
    );
    // A free name is 404 even unauthenticated: that pair is the landing page's
    // taken-probe.
    expect((await inspect('nobody')).status).toBe(404);
    expect((await inspect('%E0', owned.token)).status).toBe(404);
  });
});

describe('releases', () => {
  test('an upload lands on disk, serves at once, and is listed newest first', async () => {
    const owned = await mine();
    const first = await upload(owned.name, owned.token);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      n: 1,
      serving: 1,
      url: 'https://notes.kthx.test',
    });
    expect(first.body.digest).toMatch(/^[0-9a-f]{64}$/);

    // Unpacked, not held in memory: the files are on the volume.
    const root = join(kthx().sitesDir, owned.name, '1');
    expect(await Bun.file(join(root, 'index.html')).text()).toBe('<h1>v1</h1>');
    expect(await Bun.file(join(root, 'style.css')).exists()).toBe(true);

    const second = await upload(
      owned.name,
      owned.token,
      site({ 'index.html': '<h1>v2</h1>' }),
    );
    expect(second.body).toMatchObject({ n: 2, serving: 2 });

    const shown = await inspect(owned.name, owned.token);
    expect(shown.body).toMatchObject({
      name: 'notes',
      serving: 2,
      held: false,
    });
    expect(shown.body.releases.map((r: { n: number }) => r.n)).toEqual([2, 1]);
    expect(shown.body.releases[0].size).toBeGreaterThan(0);
    expect(shown.body.quotas.db_bytes).toBe(256 * 1024 * 1024);
  });

  test('the same bundle twice is one depot object', async () => {
    const owned = await mine();
    const first = await upload(owned.name, owned.token);
    const again = await upload(owned.name, owned.token);
    expect(again.body.digest).toBe(first.body.digest);
    expect(again.body.n).toBe(2);
    const objects = await readdir(join(kthx().sitesDir, '.depot', 'releases'));
    expect(objects).toEqual([`${first.body.digest}.tar.gz`]);
  });

  test('an archive with no entry page is refused before it is stored', async () => {
    const owned = await mine();
    expect(
      await upload(owned.name, owned.token, site({ 'about.html': 'hi' })),
    ).toMatchObject({ status: 400, body: { code: 'NO_INDEX' } });
    expect(await Bun.file(join(kthx().sitesDir, '.depot')).exists()).toBe(
      false,
    );

    // `200.html` is an entry page too — a single-page app has no index.
    expect(
      (await upload(owned.name, owned.token, site({ '200.html': 'spa' })))
        .status,
    ).toBe(201);
  });

  test('a wrapper directory is stripped; the file inside it is the root', async () => {
    const owned = await mine();
    const wrapped = await upload(
      owned.name,
      owned.token,
      site({ 'dist/index.html': 'hi', 'dist/app.js': '//' }),
    );
    expect(wrapped.status).toBe(201);
    const root = join(kthx().sitesDir, owned.name, '1');
    expect(await Bun.file(join(root, 'index.html')).text()).toBe('hi');
    expect(await Bun.file(join(root, 'dist/index.html')).exists()).toBe(false);
  });

  test('an entry that would write outside the release is refused', async () => {
    const owned = await mine();
    const escaping = await upload(
      owned.name,
      owned.token,
      tarGz([
        { path: 'index.html', bytes: new TextEncoder().encode('hi') },
        { path: '../escape.html', bytes: new TextEncoder().encode('no') },
      ]),
    );
    expect(escaping).toMatchObject({
      status: 400,
      body: { code: 'PATH_ESCAPES_ARCHIVE' },
    });
  });

  test('a name that is both a file and a directory is refused', async () => {
    const owned = await mine();
    const colliding = await upload(
      owned.name,
      owned.token,
      tarGz([
        { path: 'index.html', bytes: new TextEncoder().encode('hi') },
        { path: 'app', bytes: new TextEncoder().encode('file') },
        { path: 'app/main.js', bytes: new TextEncoder().encode('//') },
      ]),
    );
    expect(colliding).toMatchObject({
      status: 400,
      body: { code: 'MALFORMED_ZIP' },
    });
  });

  test('anything that is not an archive is refused by name', async () => {
    const owned = await mine();
    expect(
      await upload(
        owned.name,
        owned.token,
        new TextEncoder().encode('<h1>not an archive</h1>'),
      ),
    ).toMatchObject({ status: 400, body: { code: 'UNKNOWN_FORMAT' } });
  });

  test('an archive over either limit is 413', async () => {
    const owned = await mine();
    expect(
      await upload(
        owned.name,
        owned.token,
        new Uint8Array(MAX_ARCHIVE_BYTES + 1),
      ),
    ).toMatchObject({ status: 413, body: { code: 'TOO_LARGE' } });
    expect(
      await upload(
        owned.name,
        owned.token,
        Bun.gzipSync(new Uint8Array(MAX_UNPACKED_BYTES + 1)),
      ),
    ).toMatchObject({ status: 413, body: { code: 'TOO_LARGE' } });
  });

  test('with every unpack slot held, an upload and a rehydrate both wait', async () => {
    const owned = await mine();
    await upload(owned.name, owned.token);
    await rm(join(kthx().sitesDir, owned.name, '1'), {
      recursive: true,
      force: true,
    });

    const held = Array.from({ length: MAX_UNPACKS }, () => takeSlot());
    expect(held.every((slot) => slot !== null)).toBe(true);
    try {
      expect(await upload(owned.name, owned.token)).toMatchObject({
        status: 503,
        body: { code: 'BUSY' },
      });
      // The same two slots cover a rehydrate, which is the 503 page rather
      // than a code: a browser asked for bytes, not for JSON.
      const page = await kthx().fetch(
        ask('/', { host: `${owned.name}.${ZONE}` }),
      );
      expect(page.status).toBe(503);
    } finally {
      for (const slot of held) slot?.();
    }

    // The slots are given back, so both paths work again.
    expect((await upload(owned.name, owned.token)).status).toBe(201);
    expect(
      (await kthx().fetch(ask('/', { host: `${owned.name}.${ZONE}` }))).status,
    ).toBe(200);
  });

  test('an archive this boundary refuses does not spend a day of uploads', async () => {
    const owned = await mine();
    const empty = site({ 'about.html': 'no entry page' });
    for (let i = 0; i < MAX_UPLOADS_PER_DAY + 1; i += 1) {
      expect(await upload(owned.name, owned.token, empty)).toMatchObject({
        status: 400,
        body: { code: 'NO_INDEX' },
      });
    }
    expect((await upload(owned.name, owned.token)).status).toBe(201);
  });
});

describe('rolling back and holding', () => {
  test('serving an older release sets the hold; a held site keeps serving it', async () => {
    const owned = await mine();
    await upload(owned.name, owned.token);
    await upload(owned.name, owned.token, site({ 'index.html': 'v2' }));

    expect(await serveRelease(owned.name, owned.token, 1)).toMatchObject({
      status: 200,
      body: { serving: 1, held: true },
    });

    const third = await upload(
      owned.name,
      owned.token,
      site({ 'index.html': 'v3' }),
    );
    expect(third.body).toMatchObject({ n: 3, serving: 1 });
    expect((await inspect(owned.name, owned.token)).body).toMatchObject({
      serving: 1,
      held: true,
    });

    // Forward is the same act, and also holds.
    expect((await serveRelease(owned.name, owned.token, 3)).body).toEqual({
      serving: 3,
      held: true,
    });
    expect(await unhold(owned.name, owned.token)).toMatchObject({
      status: 200,
      body: { held: false, serving: 3 },
    });
    expect((await serveRelease(owned.name, owned.token, 9)).status).toBe(404);
    expect((await serveRelease(owned.name, owned.token, 'one')).status).toBe(
      404,
    );
  });
});

describe('the volume', () => {
  test('a full volume keeps the serving and previous releases and no more', async () => {
    const owned = await mine();
    for (const version of ['v1', 'v2', 'v3']) {
      expect(
        (await upload(owned.name, owned.token, site({ 'index.html': version })))
          .status,
      ).toBe(201);
    }
    expect(await releaseDirs(owned.name)).toEqual([1, 2, 3]);

    // The reading is the caller's, so the rule can be proven without filling a
    // real disk.
    await pruneSite(
      kthx().sitesDir,
      owned.name,
      new Set([1, 2, 3]),
      new Set([3, 2]),
      true,
    );
    expect(await releaseDirs(owned.name)).toEqual([2, 3]);
  });

  test('a release with no directory is refilled from the depot', async () => {
    const owned = await mine();
    await upload(owned.name, owned.token);
    await rm(join(kthx().sitesDir, owned.name, '1'), {
      recursive: true,
      force: true,
    });
    expect(await releaseDirs(owned.name)).toEqual([]);

    const response = await kthx().fetch(
      ask('/', { host: `${owned.name}.${ZONE}` }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>v1</h1>');
    expect(await releaseDirs(owned.name)).toEqual([1]);
  });

  test('a release whose depot object is gone is the 503 page, not a 500', async () => {
    const owned = await mine();
    await upload(owned.name, owned.token);
    await rm(join(kthx().sitesDir, owned.name, '1'), {
      recursive: true,
      force: true,
    });
    await rm(join(kthx().sitesDir, '.depot'), { recursive: true, force: true });

    const response = await kthx().fetch(
      ask('/', { host: `${owned.name}.${ZONE}` }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('deleting', () => {
  test('answers 204, takes the bytes, and the name stays taken', async () => {
    const owned = await mine();
    await upload(owned.name, owned.token);
    const gone = await kthx().fetch(
      ask(`/api/sites/${owned.name}`, { method: 'DELETE', token: owned.token }),
    );
    expect(gone.status).toBe(204);
    expect(await releaseDirs(owned.name)).toEqual([]);

    // 410 on every control route, authenticated or not, and the name never
    // comes free.
    expect(await inspect(owned.name, owned.token)).toMatchObject({
      status: 410,
      body: { code: 'GONE' },
    });
    expect((await inspect(owned.name)).status).toBe(410);
    expect(await claim(owned.name)).toMatchObject({
      status: 409,
      body: { code: 'TAKEN' },
    });
  });
});
