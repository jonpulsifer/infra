/**
 * A database per site: that a claim makes one, that one site's role cannot
 * reach another's, and what `/api/db` does on top.
 *
 * Real Postgres throughout, because every claim worth testing here is a claim
 * about Postgres: that `REVOKE CONNECT` is the boundary, that `data || $1` is
 * one statement, that `pg_database_size` is the meter, that jsonb containment
 * does not match a scalar stored inside an array.
 */
import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MAX_BULK } from '../../server/documents.ts';
import { sitePassword } from '../../server/pg.ts';
import { ask, idToken, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `192.0.2.${nextAddress % 250}`;
}

interface Site {
  readonly name: string;
  readonly host: string;
  readonly token: string;
}

async function claimed(label: string): Promise<Site> {
  const name = kthx().name(label);
  const token = await idToken(`${name}@example.com`);
  const response = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
    }),
  );
  expect(response.status).toBe(201);
  return { name, host: `${name}.${ZONE}`, token };
}

function at(site: Site, path: string, init: Parameters<typeof ask>[1] = {}) {
  return kthx().fetch(ask(path, { host: site.host, ...init }));
}

function write(
  site: Site,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return at(site, path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The documents a query answered with. */
async function found(
  site: Site,
  collection: string,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await write(
    site,
    'POST',
    `/api/db/${collection}/query`,
    query,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Record<string, unknown>[] })
    .items;
}

async function seed(
  site: Site,
  collection: string,
  documents: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const response = await write(
    site,
    'POST',
    `/api/db/${collection}`,
    documents,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { items: Record<string, unknown>[] })
    .items;
}

describe('provisioning', () => {
  test('a claim leaves a database and a role, and only that role opens it', async () => {
    const a = await claimed('a');
    const b = await claimed('b');

    const [row] = (await kthx().sql`
      select provisioned_at from sites where name = ${a.name}
    `) as { provisioned_at: Date | null }[];
    expect(row?.provisioned_at).not.toBeNull();

    // The site's own role reaches its own documents…
    expect((await at(a, '/api/db')).status).toBe(200);

    // …and nothing else's. This is the whole boundary: `REVOKE CONNECT, TEMP
    // … FROM PUBLIC` plus one `GRANT CONNECT` is what stands between two
    // strangers' data, and a database ACL is not copied from the template.
    const url = new URL(kthx().config.databaseUrl);
    url.search = '';
    url.pathname = `/${b.name}`;
    url.username = a.name;
    url.password = sitePassword(kthx().config.pgKey, a.name);
    const crossed = new SQL(url.toString(), { max: 1, connectionTimeout: 3 });
    const outcome = await crossed
      .unsafe('select 1')
      .then(() => 'connected')
      .catch((cause: Error) => cause.message);
    expect(outcome).toMatch(/permission denied for database/);
    await crossed.close({ timeout: 1 }).catch(() => {});
  });

  test('a site whose row has no database yet is 503, and is repaired', async () => {
    const site = await claimed('unprovisioned');
    // The state a claim that died between its row and its database leaves.
    await kthx().sql`
      update sites set provisioned_at = null where name = ${site.name}
    `;
    const busy = await at(site, '/api/db');
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { code: string }).code).toBe('BUSY');

    // The refusal kicked off the repair; the next call finds it done.
    for (let i = 0; i < 50; i += 1) {
      if ((await at(site, '/api/db')).status === 200) break;
      await Bun.sleep(20);
    }
    expect((await at(site, '/api/db')).status).toBe(200);
  });

  test('deleting a site drops its database and its role', async () => {
    const site = await claimed('doomed');
    await write(site, 'POST', '/api/db/notes', { a: 1 });

    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    expect(removed.status).toBe(204);

    const [left] = (await kthx().sql`
      select exists (select 1 from pg_database where datname = ${site.name})
          or exists (select 1 from pg_roles where rolname = ${site.name}) as any
    `) as { any: boolean }[];
    expect(left?.any).toBe(false);
    // The name stays taken and every backend on it is 410.
    expect((await at(site, '/api/db')).status).toBe(410);
  });

  test('a handler that arrives after a delete does not rebuild the site', async () => {
    const site = await claimed('late');
    await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );

    // The state a `drop()` that threw between its two statements leaves: the
    // database gone, the role still there. A handler that read a live row just
    // before the delete now connects, gets 3D000, and asks for a repair —
    // `leaving` is already cleared, so only the row keeps this honest.
    const password = sitePassword(kthx().config.pgKey, site.name);
    await kthx().sql.unsafe(
      `create role "${site.name}" login password '${password}'`,
    );
    await expect(
      kthx().pg.site(site.name, (sql) => sql`select 1`),
    ).rejects.toMatchObject({ name: 'SiteGone' });

    const [left] = (await kthx().sql`
      select exists (select 1 from pg_database where datname = ${site.name}) as any
    `) as { any: boolean }[];
    expect(left?.any).toBe(false);
  });

  test('the sweep drops the residue and nothing the cluster needs', async () => {
    const site = await claimed('orphan');
    await kthx().sql`delete from sites where name = ${site.name}`;

    // Confined to this file's names: the production call sweeps the cluster,
    // which is correct there and would take another agent's test databases
    // here.
    const ours = kthx().name('');
    const dropped = await kthx().pg.sweep((name) => name.startsWith(ours));
    expect(dropped).toContain(site.name);

    const [left] = (await kthx().sql`
      select exists (select 1 from pg_database where datname = ${site.name})
          or exists (select 1 from pg_roles where rolname = ${site.name}) as any
    `) as { any: boolean }[];
    expect(left?.any).toBe(false);
    // The control connection is still the control connection.
    expect((await kthx().sql`select 1 as ok`)[0]).toEqual({ ok: 1 });

    // A login that is not a site's, whose name a site could have had. The
    // sweep is the one unconditional destructive path in the process, so what
    // makes a role a site's is membership of the group role, not its shape.
    const bystander = `${ours}keepme`;
    await kthx().sql.unsafe(`create role "${bystander}" login`);
    const second = await kthx().pg.sweep((name) => name.startsWith(ours));
    expect(second).not.toContain(bystander);
    const [alive] = (await kthx().sql`
      select exists (select 1 from pg_roles where rolname = ${bystander}) as any
    `) as { any: boolean }[];
    expect(alive?.any).toBe(true);
  });

  test('a name that is already a database is taken even with no row', async () => {
    const site = await claimed('residue');
    // What a claim that failed after `CREATE DATABASE` leaves behind: the row
    // is gone, the database is not. Handing the name out again would hand over
    // its documents.
    await kthx().sql`delete from sites where name = ${site.name}`;
    const again = await kthx().fetch(
      ask('/api/sites', {
        method: 'POST',
        token: site.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: site.name }),
        address: address(),
      }),
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('TAKEN');
  });
});

describe('documents', () => {
  test('a create gets a server id, an etag, and the wire shape', async () => {
    const site = await claimed('create');
    const response = await write(site, 'POST', '/api/db/notes', {
      title: 'hello',
      done: false,
    });
    expect(response.status).toBe(201);
    const document = (await response.json()) as Record<string, string>;
    expect(document.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(document.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get('etag')).toBe(`"${document.etag}"`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(document.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(document.title).toBe('hello');

    const read = await at(site, `/api/db/notes/${document.id}`);
    expect(await read.json()).toEqual(document);
    expect((await at(site, '/api/db/notes/nothing')).status).toBe(404);
  });

  test('a client id is honoured once, and the server keys are not stored', async () => {
    const site = await claimed('ids');
    const first = await write(site, 'POST', '/api/db/notes', {
      id: 'mine',
      etag: 'lies',
      created_at: 'lies',
      note: 'kept',
    });
    expect(first.status).toBe(201);
    const document = (await first.json()) as Record<string, string>;
    expect(document.id).toBe('mine');
    expect(document.etag).not.toBe('lies');
    expect(document.created_at).not.toBe('lies');

    const again = await write(site, 'POST', '/api/db/notes', { id: 'mine' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('EXISTS');
    expect(
      (await write(site, 'POST', '/api/db/notes', { id: 'no spaces' })).status,
    ).toBe(400);
  });

  test('a bulk create is one unit and is all or nothing', async () => {
    const site = await claimed('bulk');
    const items = await seed(site, 'rows', [
      { id: 'one', n: 1 },
      { id: 'two', n: 2 },
    ]);
    expect(items.map((item) => item.id)).toEqual(['one', 'two']);

    // One id already taken means none of them land.
    const clash = await write(site, 'POST', '/api/db/rows', [
      { id: 'three', n: 3 },
      { id: 'one', n: 9 },
    ]);
    expect(clash.status).toBe(409);
    expect(await found(site, 'rows', {})).toHaveLength(2);

    const tooMany = await write(
      site,
      'POST',
      '/api/db/rows',
      Array.from({ length: MAX_BULK + 1 }, (_, n) => ({ n })),
    );
    expect(tooMany.status).toBe(413);
  });

  test('PATCH merges the top level, overwrite replaces the document', async () => {
    const site = await claimed('merge');
    const created = (await (
      await write(site, 'POST', '/api/db/notes', {
        id: 'x',
        a: 1,
        nested: { keep: true, drop: 1 },
        gone: 'yes',
      })
    ).json()) as Record<string, unknown>;

    const merged = (await (
      await write(site, 'PATCH', '/api/db/notes/x', {
        a: 2,
        nested: { keep: false },
        nulled: null,
      })
    ).json()) as Record<string, unknown>;
    expect(merged.a).toBe(2);
    // A nested object in the patch replaces the stored one whole…
    expect(merged.nested).toEqual({ keep: false });
    // …a null is stored as a value, not as a delete…
    expect(merged.nulled).toBeNull();
    // …and a key the patch does not mention is kept.
    expect(merged.gone).toBe('yes');
    expect(merged.etag).not.toBe(created.etag);
    expect(merged.created_at).toBe(created.created_at);

    const replaced = (await (
      await write(site, 'PATCH', '/api/db/notes/x?overwrite=1', { only: 1 })
    ).json()) as Record<string, unknown>;
    expect(replaced).toMatchObject({ id: 'x', only: 1 });
    expect(replaced.gone).toBeUndefined();

    expect(
      (await write(site, 'PATCH', '/api/db/notes/nope', { a: 1 })).status,
    ).toBe(404);
  });

  test('If-Match is the CAS loop, If-None-Match reserves an id', async () => {
    const site = await claimed('cas');
    const created = (await (
      await write(site, 'POST', '/api/db/notes', { id: 'x', n: 0 })
    ).json()) as { etag: string };

    // The quoted form the etag header carries and the bare one the body does.
    const stale = await write(
      site,
      'PATCH',
      '/api/db/notes/x',
      { n: 1 },
      {
        'if-match': '"0000"',
      },
    );
    expect(stale.status).toBe(412);
    const fresh = await write(
      site,
      'PATCH',
      '/api/db/notes/x',
      { n: 1 },
      {
        'if-match': `"${created.etag}"`,
      },
    );
    expect(fresh.status).toBe(200);
    const now = (await fresh.json()) as { etag: string };
    // The etag that just won is no longer the current one.
    expect(
      (
        await write(
          site,
          'PATCH',
          '/api/db/notes/x',
          { n: 2 },
          {
            'if-match': created.etag,
          },
        )
      ).status,
    ).toBe(412);

    const taken = await write(
      site,
      'PUT',
      '/api/db/notes/x',
      { n: 3 },
      {
        'if-none-match': '*',
      },
    );
    expect(taken.status).toBe(412);
    const reserved = await write(
      site,
      'PUT',
      '/api/db/notes/free',
      { n: 3 },
      {
        'if-none-match': '*',
      },
    );
    expect(reserved.status).toBe(201);

    // A DELETE that names a version it does not have keeps the document.
    expect(
      (
        await at(site, '/api/db/notes/x', {
          method: 'DELETE',
          headers: { 'if-match': '"0000"' },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await at(site, '/api/db/notes/x', {
          method: 'DELETE',
          headers: { 'if-match': now.etag },
        })
      ).status,
    ).toBe(204);
    // Deleting what is not there, with no precondition, is still 204.
    expect(
      (await at(site, '/api/db/notes/x', { method: 'DELETE' })).status,
    ).toBe(204);
  });

  test('PUT upserts: 201 when it created, 200 when it replaced', async () => {
    const site = await claimed('put');
    const made = await write(site, 'PUT', '/api/db/notes/x', { a: 1 });
    expect(made.status).toBe(201);
    const over = await write(site, 'PUT', '/api/db/notes/x', { b: 2 });
    expect(over.status).toBe(200);
    const document = (await over.json()) as Record<string, unknown>;
    expect(document.a).toBeUndefined();
    expect(document.b).toBe(2);
    // `If-Match` on a document that is not there is 412, not 404.
    expect(
      (
        await write(
          site,
          'PUT',
          '/api/db/notes/y',
          { a: 1 },
          { 'if-match': '"x"' },
        )
      ).status,
    ).toBe(412);
  });

  test('a document that is not one is refused by code', async () => {
    const site = await claimed('shapes');
    for (const body of [42, 'text', null, ['not', 'a', 'doc']]) {
      expect((await write(site, 'POST', '/api/db/notes', body)).status).toBe(
        400,
      );
    }
    expect(
      (await write(site, 'POST', '/api/db/notes', { nul: 'a\u0000b' })).status,
    ).toBe(400);
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) deep = { deep };
    expect((await write(site, 'POST', '/api/db/notes', deep)).status).toBe(400);
    expect(
      (
        await write(
          site,
          'POST',
          '/api/db/notes',
          JSON.parse('{"__proto__":{"x":1}}'),
        )
      ).status,
    ).toBe(400);
    expect((await write(site, 'POST', '/api/db/NOPE', { a: 1 })).status).toBe(
      400,
    );
    // A write that does not declare JSON is not read at all.
    expect(
      (
        await at(site, '/api/db/notes', {
          method: 'POST',
          body: JSON.stringify({ a: 1 }),
        })
      ).status,
    ).toBe(400);
  });

  test('collections are listed with their counts and dropped by the owner', async () => {
    const site = await claimed('collections');
    await seed(site, 'a', [{ n: 1 }, { n: 2 }]);
    await seed(site, 'b', [{ n: 1 }]);
    expect(await (await at(site, '/api/db')).json()).toEqual({
      collections: [
        { name: 'a', count: 2 },
        { name: 'b', count: 1 },
      ],
    });

    // Dropping one is the owner's, and only the owner's.
    expect((await at(site, '/api/db/a', { method: 'DELETE' })).status).toBe(
      401,
    );
    expect(
      (await at(site, '/api/db/a', { method: 'DELETE', token: 'wrong' }))
        .status,
    ).toBe(403);
    expect(
      (await at(site, '/api/db/a', { method: 'DELETE', token: site.token }))
        .status,
    ).toBe(204);
    expect(await (await at(site, '/api/db')).json()).toEqual({
      collections: [{ name: 'b', count: 1 }],
    });
  });
});

describe('queries', () => {
  /** One collection every operator is asked about. */
  async function fixture(): Promise<Site> {
    const site = await claimed('query');
    await seed(site, 'items', [
      { id: 'a', name: 'Alpha', n: 1, tags: ['x', 'y'], meta: { rank: 3 } },
      { id: 'b', name: 'beta', n: 2, tags: ['y'], meta: { rank: 1 } },
      { id: 'c', name: 'Gamma', n: 3, meta: { rank: 2 }, empty: null },
    ]);
    return site;
  }

  const ids = (items: Record<string, unknown>[]) =>
    items.map((item) => String(item.id)).sort();

  test('equality is exact, and is not containment alone', async () => {
    const site = await fixture();
    expect(ids(await found(site, 'items', { where: { n: 2 } }))).toEqual(['b']);
    expect(
      ids(await found(site, 'items', { where: { 'meta.rank': 1 } })),
    ).toEqual(['b']);
    // A scalar stored inside an array is not that scalar: `data @> {tags:"x"}`
    // is true for `["x","y"]`, and the exact half is what refuses it.
    expect(await found(site, 'items', { where: { tags: 'x' } })).toEqual([]);
    expect(
      ids(await found(site, 'items', { where: { tags: ['x', 'y'] } })),
    ).toEqual(['a']);
    expect(ids(await found(site, 'items', { where: { id: 'c' } }))).toEqual([
      'c',
    ]);
  });

  test('every operator the grammar has', async () => {
    const site = await fixture();
    expect(
      ids(await found(site, 'items', { where: { n: { $gt: 1 } } })),
    ).toEqual(['b', 'c']);
    expect(
      ids(await found(site, 'items', { where: { n: { $gte: 2 } } })),
    ).toEqual(['b', 'c']);
    expect(
      ids(await found(site, 'items', { where: { n: { $lt: 2 } } })),
    ).toEqual(['a']);
    expect(
      ids(await found(site, 'items', { where: { n: { $lte: 2 } } })),
    ).toEqual(['a', 'b']);
    // `$ne` is IS DISTINCT FROM, so a document without the path matches.
    expect(
      ids(await found(site, 'items', { where: { 'meta.rank': { $ne: 1 } } })),
    ).toEqual(['a', 'c']);
    expect(
      ids(await found(site, 'items', { where: { tags: { $ne: ['y'] } } })),
    ).toEqual(['a', 'c']);
    expect(
      ids(await found(site, 'items', { where: { n: { $in: [1, 3] } } })),
    ).toEqual(['a', 'c']);
    expect(
      ids(await found(site, 'items', { where: { n: { $nin: [1] } } })),
    ).toEqual(['b', 'c']);
    expect(
      ids(await found(site, 'items', { where: { name: { $like: 'A%' } } })),
    ).toEqual(['a']);
    // Case-insensitive, and an absent field never matches either of them.
    expect(
      ids(await found(site, 'items', { where: { name: { $ilike: 'g%' } } })),
    ).toEqual(['c']);
    expect(
      await found(site, 'items', { where: { nothing: { $like: '%' } } }),
    ).toEqual([]);
    // A JSON null counts as present, which is why `$exists:false` is not a
    // way to find one.
    expect(
      ids(await found(site, 'items', { where: { empty: { $exists: true } } })),
    ).toEqual(['c']);
    expect(
      ids(await found(site, 'items', { where: { tags: { $exists: false } } })),
    ).toEqual(['c']);
    // Two keys AND together.
    expect(
      ids(
        await found(site, 'items', {
          where: { n: { $gte: 2 }, 'meta.rank': 2 },
        }),
      ),
    ).toEqual(['c']);
  });

  test('timestamps compare as timestamps, ordering ties break on id', async () => {
    const site = await fixture();
    const all = await found(site, 'items', {});
    expect(all).toHaveLength(3);
    expect(
      (
        await found(site, 'items', {
          where: { created_at: { $lt: '2000-01-01T00:00:00.000Z' } },
        })
      ).length,
    ).toBe(0);
    expect(
      (
        await found(site, 'items', {
          where: { created_at: { $gt: '2000-01-01T00:00:00.000Z' } },
        })
      ).length,
    ).toBe(3);
    // Written in one statement, so every `created_at` is the same instant and
    // the tiebreak is what makes the order a fact rather than a guess.
    expect(
      (await found(site, 'items', { orderBy: 'created_at desc' })).map(
        (i) => i.id,
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(
      (await found(site, 'items', { orderBy: 'n desc' })).map((i) => i.id),
    ).toEqual(['c', 'b', 'a']);
    expect(
      (await found(site, 'items', { orderBy: 'n', limit: 1, offset: 1 })).map(
        (i) => i.id,
      ),
    ).toEqual(['b']);
  });

  test('count is the matches, not the page', async () => {
    const site = await fixture();
    const response = await write(site, 'POST', '/api/db/items/query', {
      where: { n: { $gte: 1 } },
      limit: 1,
      count: true,
    });
    const body = (await response.json()) as { items: unknown[]; count: number };
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(3);
  });

  test('a GET reads the same grammar off the query string', async () => {
    const site = await fixture();
    const response = await at(
      site,
      `/api/db/items?where=${encodeURIComponent('{"n":{"$gt":1}}')}&orderBy=n&limit=1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
    };
    expect(body.items.map((item) => item.id)).toEqual(['b']);
    expect((await at(site, '/api/db/items?where=notjson')).status).toBe(400);
  });

  test('anything outside the grammar is 400, never a scan', async () => {
    const site = await fixture();
    for (const query of [
      { where: { n: { $regex: 'a' } } },
      { where: { 'a.b.c.d.e.f.g.h.i': 1 } },
      { where: { "n'; drop table documents; --": 1 } },
      { where: { n: { $in: 'not an array' } } },
      { where: { created_at: { $gt: 'yesterday' } } },
      { where: { n: { $exists: 'yes' } } },
      { orderBy: 'n sideways' },
      { offset: 10_001 },
      { limit: -1 },
      {
        where: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`k${i}`, 1]),
        ),
      },
    ]) {
      const response = await write(site, 'POST', '/api/db/items/query', query);
      expect([response.status, JSON.stringify(query)]).toEqual([
        400,
        JSON.stringify(query),
      ]);
    }
    // The table is still there, which is the point of the third one.
    expect(await found(site, 'items', {})).toHaveLength(3);
  });
});

describe('quotas', () => {
  test('a full database refuses growing writes and keeps taking deletes', async () => {
    const site = await claimed('full');
    const made = await write(site, 'POST', '/api/db/notes', { id: 'x', a: 1 });
    expect(made.status).toBe(201);

    // The empty clone is ~8 MiB, so any ceiling under that is "full". The
    // ceiling is config rather than a constant exactly so this can be asked.
    (kthx().config as { maxDbBytes: number }).maxDbBytes = 1;
    for (const attempt of [
      write(site, 'POST', '/api/db/notes', { b: 1 }),
      write(site, 'PATCH', '/api/db/notes/x', { a: 2 }),
      write(site, 'PUT', '/api/db/notes/y', { a: 2 }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(507);
      expect(((await response.json()) as { code: string }).code).toBe(
        'SITE_FULL',
      );
    }
    // Reads and deletes are the way out of it.
    expect((await at(site, '/api/db/notes/x')).status).toBe(200);
    expect(
      (await at(site, '/api/db/notes/x', { method: 'DELETE' })).status,
    ).toBe(204);
  });

  test('the collection ceiling refuses the next one, not the existing ones', async () => {
    const site = await claimed('wide');
    expect((await write(site, 'POST', '/api/db/one', { a: 1 })).status).toBe(
      201,
    );
    (kthx().config as { maxCollections: number }).maxCollections = 1;
    expect((await write(site, 'POST', '/api/db/one', { a: 2 })).status).toBe(
      201,
    );
    const second = await write(site, 'POST', '/api/db/two', { a: 1 });
    expect(second.status).toBe(507);
  });

  test('a document over the ceiling is refused, merged size included', async () => {
    const site = await claimed('large');
    const big = 'x'.repeat(1024 * 1024);
    expect((await write(site, 'POST', '/api/db/notes', { big })).status).toBe(
      413,
    );
    expect(
      (await write(site, 'POST', '/api/db/notes', { id: 'x', a: 1 })).status,
    ).toBe(201);
    // Under the ceiling on its own; over it once merged into what is stored.
    const grown = await write(site, 'PATCH', '/api/db/notes/x', {
      big: 'y'.repeat(1024 * 1000),
      more: 'z'.repeat(60_000),
    });
    expect(grown.status).toBe(413);
  });

  test('a chunked body past the ceiling is cut, not read', async () => {
    const site = await claimed('chunked');
    const chunk = new Uint8Array(256 * 1024);
    chunk.fill(120);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // Far past the ceiling: what must not happen is all of it arriving.
        if (pulls > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request(`http://${site.host}/api/db/notes`, {
      method: 'POST',
      headers: { host: site.host, 'content-type': 'application/json' },
      body,
      // @ts-expect-error the fetch types have no `duplex` yet; Bun wants it.
      duplex: 'half',
    });
    const response = await kthx().fetch(request);
    expect(response.status).toBe(413);
    // 2 MiB is nine of these chunks; the rest of the stream was never taken.
    expect(pulls).toBeLessThan(16);
  });
});

describe('the visitor', () => {
  test('the cookie is signed for this site and re-minted when it is not', async () => {
    const a = await claimed('visitor');
    const b = await claimed('other');

    const first = await at(a, '/api/me');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as { id: string; site: { name: string } };
    expect(body.site.name).toBe(a.name);
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toStartWith(`__Host-kthx_me=${body.id}.`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');

    const value = cookie.split(';')[0] ?? '';
    const again = await at(a, '/api/me', { headers: { cookie: value } });
    expect(((await again.json()) as { id: string }).id).toBe(body.id);
    expect(again.headers.get('set-cookie')).toBeNull();

    // A cookie a sibling host handed out is real, correctly signed, and still
    // not this site's: the site name is inside the signature. That, and a
    // tampered one, are replaced rather than believed — which is what makes a
    // visitor id a bound rather than a suggestion.
    const elsewhere = await at(b, '/api/me');
    const theirs = (await elsewhere.json()) as { id: string };
    const theirCookie = (elsewhere.headers.get('set-cookie') ?? '').split(
      ';',
    )[0];
    for (const forged of [`${value.slice(0, -3)}aaa`, theirCookie ?? '']) {
      const rejected = await at(a, '/api/me', { headers: { cookie: forged } });
      const got = ((await rejected.json()) as { id: string }).id;
      expect(got).not.toBe(body.id);
      expect(got).not.toBe(theirs.id);
      expect(rejected.headers.get('set-cookie')).not.toBeNull();
    }
  });

  test('a write carries the cookie; the SDK asset never does', async () => {
    const site = await claimed('cookies');
    const written = await write(site, 'POST', '/api/db/notes', { a: 1 });
    expect(written.headers.get('set-cookie')).toStartWith('__Host-kthx_me=');

    const sdk = await at(site, '/api/sdk.js');
    expect(sdk.status).toBe(200);
    expect(sdk.headers.get('set-cookie')).toBeNull();
    expect(sdk.headers.get('cache-control')).toBe('public, max-age=300');
  });

  test('a browser on another kthx host cannot write through this one', async () => {
    const site = await claimed('origin');
    const foreign = await write(
      site,
      'POST',
      '/api/db/notes',
      { a: 1 },
      {
        origin: `https://evil.${ZONE}`,
      },
    );
    expect(foreign.status).toBe(403);
    const own = await write(
      site,
      'POST',
      '/api/db/notes',
      { a: 1 },
      {
        origin: `https://${site.host}`,
      },
    );
    expect(own.status).toBe(201);
    // A read is not a write and is not guarded.
    expect(
      (
        await at(site, '/api/db', {
          headers: { origin: `https://evil.${ZONE}` },
        })
      ).status,
    ).toBe(200);
    // The owner's bearer is not a browser and is trusted without an Origin.
    expect(
      (
        await write(
          site,
          'POST',
          '/api/db/notes',
          { a: 1 },
          {
            origin: `https://evil.${ZONE}`,
            authorization: `Bearer ${site.token}`,
          },
        )
      ).status,
    ).toBe(201);
  });
});
