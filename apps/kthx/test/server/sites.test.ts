/**
 * The control API over the sites bucket: names, owner auth by Google ID token,
 * the report, deletes and the public directory. Real Postgres, fake bucket.
 */
import { describe, expect, test } from 'bun:test';
import { DIRECTORY_BUCKET } from '../../server/limits.ts';
import { nameProblem, RESERVED_NAMES } from '../../server/sites.ts';
import { GCLOUD_AUDIENCE, idToken } from '../harness/identity.ts';
import { ask, OWNER, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

/** A new address per call, so one test's burst is not another's 429. */
let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.51.100.${nextAddress % 250}`;
}

async function inspect(name: string, token?: string) {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}`, token === undefined ? {} : { token }),
  );
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
    // A name is also a Postgres database and role.
    expect(nameProblem('postgres')).toBe('RESERVED');
    expect(nameProblem('template0')).toBe('RESERVED');
  });

  test('a name is free until a marker or the engine holds it', async () => {
    const standing = async (name: string, token?: string) =>
      (
        await kthx().fetch(
          ask(`/api/names/${name}`, token === undefined ? {} : { token }),
        )
      ).json();
    const free = kthx().name('free');
    expect(await standing(free)).toEqual({
      name: free,
      available: true,
      why: null,
      yours: null,
    });

    const site = await kthx().site('held');
    expect(await standing(site.name)).toMatchObject({
      available: false,
      why: 'TAKEN',
      yours: null,
    });
    expect(await standing(site.name, site.token)).toMatchObject({
      available: false,
      why: 'TAKEN',
      yours: 'live',
    });

    const app = kthx().name('app');
    await kthx().sql`
      insert into reservations (name, holder) values (${app}, 'an-app')
    `;
    expect(await standing(app)).toMatchObject({
      available: false,
      why: 'TAKEN',
    });
    expect(await standing('www')).toMatchObject({ why: 'RESERVED' });
    expect(await standing('a_b')).toMatchObject({ why: 'INVALID_NAME' });
  });

  test('a claim is no longer a server route', async () => {
    const refused = await kthx().fetch(
      ask('/api/sites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: kthx().name('claimed') }),
        address: address(),
      }),
    );
    expect(refused.status).toBe(405);
    for (const tail of ['releases', 'serve', 'hold']) {
      const gone = await kthx().fetch(
        ask(`/api/sites/${kthx().name('x')}/${tail}`, { method: 'POST' }),
      );
      expect([tail, gone.status]).toEqual([tail, 404]);
    }
  });
});

describe("the owner's ID token", () => {
  test("opens a site whose marker names the token's email", async () => {
    const site = await kthx().site('opened');
    const found = await inspect(site.name, site.token);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      name: site.name,
      url: `https://${site.name}.${ZONE}`,
      owner: OWNER,
      deployed: expect.any(String),
      usage: { db_bytes: 0, files_bytes: 0 },
    });
  });

  test("gcloud's own audience opens it too, and email case does not matter", async () => {
    const site = await kthx().site('gcloud');
    const token = await idToken(OWNER.toUpperCase(), {
      claims: { aud: GCLOUD_AUDIENCE },
    });
    expect((await inspect(site.name, token)).status).toBe(200);
  });

  test('a token for another email is 403, and none at all is 401', async () => {
    const site = await kthx().site('closed');
    const stranger = await idToken('stranger@example.com');
    expect(await inspect(site.name, stranger)).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect(await inspect(site.name)).toMatchObject({
      status: 401,
      body: { code: 'UNAUTHENTICATED' },
    });
  });

  test('a token that fails any check opens nothing', async () => {
    const site = await kthx().site('checked');
    const now = Math.floor(Date.now() / 1000);
    const refused = {
      'wrong audience': await idToken(OWNER, {
        claims: { aud: 'https://someone-else.example' },
      }),
      expired: await idToken(OWNER, {
        claims: { iat: now - 7200, exp: now - 3600 },
      }),
      'wrong issuer': await idToken(OWNER, {
        claims: { iss: 'https://evil.example' },
      }),
      'unverified email': await idToken(OWNER, {
        claims: { email_verified: false },
      }),
      'unpublished key': await idToken(OWNER, { unpublished: true }),
      'no email': await idToken(OWNER, { claims: { email: undefined } }),
      'not a token': 'a.b.c',
    };
    for (const [why, token] of Object.entries(refused)) {
      const answer = await inspect(site.name, token);
      expect([why, answer.status]).toEqual([why, 403]);
    }
  });

  test("a service account's token without email_verified still opens", async () => {
    const site = await kthx().site(
      'robot',
      'deployer@p.iam.gserviceaccount.com',
    );
    const token = await idToken('deployer@p.iam.gserviceaccount.com', {
      claims: { email_verified: undefined },
    });
    expect((await inspect(site.name, token)).status).toBe(200);
  });

  test('no audience configured accepts no token', async () => {
    const site = await kthx().site('closed-zone');
    const config = kthx().config as { idAudiences: readonly string[] };
    const audiences = config.idAudiences;
    (config as { idAudiences: readonly string[] }).idAudiences = [];
    try {
      expect((await inspect(site.name, site.token)).status).toBe(403);
    } finally {
      (config as { idAudiences: readonly string[] }).idAudiences = audiences;
    }
  });
});

describe('a site host', () => {
  test('answers the API for a site whose marker exists', async () => {
    const site = await kthx().site('api');
    const answer = await kthx().fetch(ask('/api', { host: site.host }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ name: site.name });
  });

  test('a name with no marker is 404 to the API', async () => {
    const answer = await kthx().fetch(
      ask('/api/me', { host: `${kthx().name('nobody')}.${ZONE}` }),
    );
    expect(answer.status).toBe(404);
    expect((await answer.json()).code).toBe('NOT_FOUND');
  });

  test('a site path nginx should have answered is the kthx 404 page', async () => {
    const site = await kthx().site('static');
    for (const path of ['/', '/index.html', '/about']) {
      const answer = await kthx().fetch(ask(path, { host: site.host }));
      expect([path, answer.status]).toEqual([path, 404]);
      expect(answer.headers.get('content-type')).toContain('text/html');
    }
  });

  test('a bucket that cannot be read is 503, not a 500', async () => {
    const site = await kthx().site('unreadable');
    kthx().gcs.failures.push({
      match: (call) => call.name === `${site.name}/.kthx`,
      status: 500,
    });
    const answer = await kthx().fetch(ask('/api/me', { host: site.host }));
    expect(answer.status).toBe(503);
    expect((await answer.json()).code).toBe('BUSY');
  });
});

describe('deleting', () => {
  test('the owner deletes the folder, marker last, and the name is free', async () => {
    const site = await kthx().site('deleted');
    kthx().gcs.put(kthx().bucket, `${site.name}/app.js`, '1');
    const before = kthx().gcs.calls.length;
    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    expect(removed.status).toBe(204);
    expect(kthx().gcs.names(kthx().bucket, `${site.name}/`)).toEqual([]);
    const deletes = kthx()
      .gcs.calls.slice(before)
      .filter((call) => call.kind === 'delete')
      .map((call) => call.name);
    expect(deletes.at(-1)).toBe(`${site.name}/.kthx`);
    expect(
      await (await kthx().fetch(ask(`/api/names/${site.name}`))).json(),
    ).toMatchObject({ available: true });
  });

  test('a stranger may not delete, and the folder stays', async () => {
    const site = await kthx().site('kept');
    const refused = await kthx().fetch(
      ask(`/api/sites/${site.name}`, {
        method: 'DELETE',
        token: await idToken('stranger@example.com'),
      }),
    );
    expect(refused.status).toBe(403);
    expect(kthx().gcs.names(kthx().bucket, `${site.name}/`)).toHaveLength(2);
  });

  test('a browser on another host cannot delete through this one', async () => {
    const site = await kthx().site('foreign');
    const refused = await kthx().fetch(
      ask(`/api/sites/${site.name}`, {
        method: 'DELETE',
        token: site.token,
        headers: { origin: `https://evil.${ZONE}` },
      }),
    );
    expect(refused.status).toBe(403);
  });

  test('a name with no site is 404', async () => {
    const refused = await kthx().fetch(
      ask(`/api/sites/${kthx().name('ghost')}`, { method: 'DELETE' }),
    );
    expect(refused.status).toBe(404);
  });
});

describe('the directory', () => {
  interface Item {
    readonly name: string;
    readonly url: string;
    readonly owner: string | null;
    readonly deployed: string | null;
  }

  async function directory(query = '', token?: string) {
    const response = await kthx().fetch(
      ask(`/api/sites${query}`, {
        address: address(),
        ...(token === undefined ? {} : { token }),
      }),
    );
    return {
      status: response.status,
      cache: response.headers.get('cache-control'),
      body: (await response.json()) as { items: Item[]; next: string | null },
    };
  }

  /** This test's names only. */
  const names = (items: readonly Item[], mine: readonly string[]) =>
    items.map((item) => item.name).filter((name) => mine.includes(name));

  test('lists every site newest deploy first, and owners only to themselves', async () => {
    const first = await kthx().site('first', OWNER, '2026-08-01T00:00:00.000Z');
    const second = await kthx().site(
      'second',
      'other@example.com',
      '2026-08-02T00:00:00.000Z',
    );

    const listed = await directory();
    expect(listed.status).toBe(200);
    expect(listed.cache).toBe('no-store');
    expect(names(listed.body.items, [first.name, second.name])).toEqual([
      second.name,
      first.name,
    ]);
    expect(listed.body.items).toContainEqual({
      name: first.name,
      url: `https://${first.name}.${ZONE}`,
      owner: null,
      deployed: '2026-08-01T00:00:00.000Z',
    });

    const asOwner = await directory('', first.token);
    const own = asOwner.body.items.find((item) => item.name === first.name);
    const theirs = asOwner.body.items.find((item) => item.name === second.name);
    expect(own?.owner).toBe(OWNER);
    expect(theirs?.owner).toBeNull();

    const mine = await directory('?owner=me', first.token);
    expect(mine.body.items.map((item) => item.name)).toEqual([first.name]);
    expect((await directory('?owner=me')).status).toBe(401);
    expect((await directory('?owner=someone')).status).toBe(400);
  });

  test('walks the whole list with the cursor, one page at a time', async () => {
    const owned = [
      await kthx().site('walk-a', OWNER, '2026-07-01T00:00:00.000Z'),
      await kthx().site('walk-b', OWNER, '2026-07-02T00:00:00.000Z'),
      await kthx().site('walk-c', OWNER, '2026-07-03T00:00:00.000Z'),
    ].map((site) => site.name);

    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const listed: Awaited<ReturnType<typeof directory>> = await directory(
        after === null ? '?limit=1' : `?limit=1&after=${after}`,
      );
      expect(listed.body.items).toHaveLength(1);
      seen.push(...names(listed.body.items, owned));
      after = listed.body.next;
      if (after === null) break;
    }
    expect(seen).toEqual([...owned].reverse());
  });

  test('clamps the page size and refuses a cursor that is not a name', async () => {
    const first = await kthx().site('clamp');
    const second = await kthx().site('clamp-two');
    expect((await directory('?limit=99999')).status).toBe(200);
    expect((await directory('?limit=nonsense')).status).toBe(200);
    expect(
      names((await directory('?limit=')).body.items, [first.name, second.name]),
    ).toHaveLength(2);
    expect(await directory('?after=Not%20A%20Name')).toMatchObject({
      status: 400,
      body: { code: 'INVALID_QUERY' },
    });
    expect(await directory('?after=nobody-here-at-all')).toMatchObject({
      status: 200,
      body: { items: [], next: null },
    });
  });

  test('bounds how fast one address asks for a page', async () => {
    const from = address();
    for (let asked = 0; asked < DIRECTORY_BUCKET.capacity; asked += 1) {
      const paged = await kthx().fetch(ask('/api/sites', { address: from }));
      expect(paged.status).toBe(200);
      await paged.json();
    }
    const refused = await kthx().fetch(ask('/api/sites', { address: from }));
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('RATE_LIMITED');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('has no nuke when the deployment has no admin login', async () => {
    const owned = await kthx().site('survivor');
    const refused = await kthx().fetch(
      ask('/api/sites', { method: 'DELETE', token: owned.token }),
    );
    expect(refused.status).toBe(404);
    expect(names((await directory()).body.items, [owned.name])).toEqual([
      owned.name,
    ]);
  });

  test('reads the bucket: a marker written behind the API is listed', async () => {
    const smuggled = kthx().name('smuggled');
    kthx().gcs.put(kthx().bucket, `${smuggled}/.kthx`, '{}', {
      metadata: { 'kthx-owner': 'x@example.com' },
    });
    expect(names((await directory()).body.items, [smuggled])).toEqual([
      smuggled,
    ]);
  });
});
