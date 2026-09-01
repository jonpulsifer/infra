/**
 * `DELETE /api/sites`: every site on the zone, gone, and every name free.
 *
 * The claims worth the most here are the two a demo depends on — a nuked name
 * can be claimed again, which a per-site delete deliberately does not allow —
 * and the one that keeps it from being a way to empty the zone by accident:
 * nothing but the operator's key opens it, and getting it wrong costs the
 * caller nothing it needs later.
 *
 * The 404 a deployment with no key answers is in `sites.test.ts`, whose
 * harness is the one without an admin key.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tarGz } from '../../cli/tar.ts';
import { CLAIM_BUCKET } from '../../server/limits.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const ADMIN = 'n'.repeat(40);
const kthx = withServer({ adminKey: ADMIN });

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

async function claim(name: string, from = address()) {
  return kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: from,
    }),
  );
}

async function claimed(label: string): Promise<Site> {
  const name = kthx().name(label);
  const response = await claim(name);
  expect(response.status).toBe(201);
  return {
    name,
    host: `${name}.${ZONE}`,
    token: (await response.json()).token,
  };
}

/** A release on the volume, so the nuke has bytes to take as well as rows. */
async function publish(site: Site): Promise<void> {
  const uploaded = await kthx().fetch(
    ask(`/api/sites/${site.name}/releases`, {
      method: 'POST',
      token: site.token,
      body: tarGz([
        { path: 'index.html', bytes: new TextEncoder().encode('hi') },
      ]),
      address: address(),
    }),
  );
  expect(uploaded.status).toBe(201);
}

/** `null` sends no `Authorization` at all. */
function nuke(bearer: string | null = ADMIN) {
  return kthx().fetch(
    ask('/api/sites', {
      method: 'DELETE',
      token: bearer ?? undefined,
      address: address(),
    }),
  );
}

/** Whether the cluster still carries this name as a database or a role. */
async function inPostgres(name: string): Promise<boolean> {
  const [row] = (await kthx().sql`
    select
      exists (select 1 from pg_database where datname = ${name})
        or exists (select 1 from pg_roles where rolname = ${name}) as there
  `) as { there: boolean }[];
  return row?.there ?? false;
}

describe('the nuke', () => {
  test('takes every site, its database, its bytes, and frees its name', async () => {
    const first = await claimed('one');
    const second = await claimed('two');
    await publish(first);
    // A document, so the site database is not merely provisioned but written to.
    const wrote = await kthx().fetch(
      ask('/api/db/notes', {
        host: first.host,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `https://${first.host}`,
        },
        body: JSON.stringify({ title: 'hi' }),
        address: address(),
      }),
    );
    expect(wrote.status).toBe(201);
    expect(await inPostgres(first.name)).toBe(true);

    const answer = await nuke();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ deleted: 2, failed: 0 });

    // Nothing in the rows, nothing in the cluster, nothing on the volume.
    const listed = await kthx().fetch(
      ask('/api/sites', { address: address() }),
    );
    const items = ((await listed.json()).items as { name: string }[]).map(
      (item) => item.name,
    );
    expect(items).not.toContain(first.name);
    expect(items).not.toContain(second.name);
    expect(await inPostgres(first.name)).toBe(false);
    expect(await inPostgres(second.name)).toBe(false);
    expect(
      await Bun.file(
        join(kthx().sitesDir, first.name, '1/index.html'),
      ).exists(),
    ).toBe(false);

    // The point of a hard delete: the name is claimable, not 410 forever.
    const again = await claim(first.name);
    expect(again.status).toBe(201);
    expect((await kthx().fetch(ask('/', { host: first.host }))).status).toBe(
      404,
    );
  });

  test('takes a name that was already deleted, so it comes free too', async () => {
    const site = await claimed('gone');
    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    expect(removed.status).toBe(204);
    // A soft delete keeps the name: that is what makes it answer 410.
    expect((await claim(site.name)).status).toBe(409);

    expect(await (await nuke()).json()).toEqual({ deleted: 1, failed: 0 });
    expect((await claim(site.name)).status).toBe(201);
  });

  test('is not opened by a site token, a wrong key, or nothing at all', async () => {
    const site = await claimed('kept');
    for (const bearer of [null, 'nope', site.token, ADMIN.slice(0, -1)]) {
      const refused = await nuke(bearer);
      expect(refused.status).toBe(403);
      expect((await refused.json()).code).toBe('FORBIDDEN');
    }
    // Refused means refused: the site is still there.
    expect(await inPostgres(site.name)).toBe(true);
  });

  test('a wrong key spends no claim allowance', async () => {
    const from = address();
    // More attempts than the claim bucket holds. If the nuke charged them, the
    // claim after it would be a 429 rather than a site.
    for (let tried = 0; tried <= CLAIM_BUCKET.capacity; tried += 1) {
      expect(
        (
          await kthx().fetch(
            ask('/api/sites', {
              method: 'DELETE',
              token: 'nope',
              address: from,
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect((await claim(kthx().name('after'), from)).status).toBe(201);
  });

  test('refuses a browser that is not on the apex', async () => {
    const site = await claimed('origin');
    const refused = await kthx().fetch(
      ask('/api/sites', {
        method: 'DELETE',
        token: ADMIN,
        headers: { origin: `https://${site.host}` },
        address: address(),
      }),
    );
    expect(refused.status).toBe(403);
    expect(await inPostgres(site.name)).toBe(true);
  });
});
