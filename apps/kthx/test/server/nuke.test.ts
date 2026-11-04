/**
 * `DELETE /api/sites`: every site gone and every name free, for a login the
 * identity proxy vouched for. The no-operator 404 is in `sites.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readConfig } from '../../server/env.ts';
import { ask, withServer } from '../harness/server.ts';

const IDENTITY = 'ops.kthx-tailnet.test';
/** The proxy pod, the only peer allowed to speak for a person. */
const PROXY = '10.42.0.7';
const OPERATOR = 'operator@example.test';
const SOMEBODY = 'somebody@example.test';

const kthx = withServer({
  identityHost: IDENTITY,
  tailnetProxies: ['10.42.0.0/16'],
  adminLogins: [OPERATOR],
});

/** Every test needs a peer: without one the handler believes every header. */
function peer(address: string): Bun.Server<unknown> {
  return {
    requestIP: () => ({ address, port: 1, family: 'IPv4' }),
    timeout: () => undefined,
  } as unknown as Bun.Server<unknown>;
}

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
  return kthx().site(label);
}

/**
 * `null` is a caller the proxy vouched for as nobody; `from` is the peer, so a
 * test can send the header from somewhere this deployment does not believe.
 */
function nuke(login: string | null = OPERATOR, from = PROXY) {
  // No `address`: a private host answers 404 to any `cf-connecting-ip`.
  return kthx().fetch(
    ask('/api/sites', {
      method: 'DELETE',
      host: IDENTITY,
      headers: login === null ? {} : { 'tailscale-user-login': login },
    }),
    peer(from),
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

const inBucket = (name: string) =>
  kthx().gcs.names(kthx().bucket, `${name}/`).length > 0;

async function free(name: string): Promise<boolean> {
  const answer = await kthx().fetch(
    ask(`/api/names/${name}`, { address: address() }),
  );
  return ((await answer.json()) as { available: boolean }).available;
}

/** So the site database is written to, not merely provisioned. */
async function write(site: Site): Promise<void> {
  const wrote = await kthx().fetch(
    ask('/api/db/notes', {
      host: site.host,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `https://${site.host}`,
      },
      body: JSON.stringify({ title: 'hi' }),
      address: address(),
    }),
  );
  expect(wrote.status).toBe(201);
}

describe('the nuke', () => {
  test('takes every site, its folder, its database, and frees its name', async () => {
    const first = await claimed('one');
    const second = await claimed('two');
    await write(first);
    expect(await inPostgres(first.name)).toBe(true);

    const answer = await nuke();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ deleted: 2, failed: 0 });

    for (const site of [first, second]) {
      expect(inBucket(site.name)).toBe(false);
      expect(await inPostgres(site.name)).toBe(false);
      expect(await free(site.name)).toBe(true);
    }
  });

  test('takes a database whose marker is already gone', async () => {
    const site = await claimed('orphan');
    await write(site);
    kthx().gcs.buckets.get(kthx().bucket)?.delete(`${site.name}/.kthx`);
    expect(await (await nuke()).json()).toEqual({ deleted: 1, failed: 0 });
    expect(await inPostgres(site.name)).toBe(false);
  });

  test('is not opened by another person, or by nobody at all', async () => {
    const site = await claimed('kept');

    // Vouched for, and not the operator.
    const other = await nuke(SOMEBODY);
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe('FORBIDDEN');

    // Nobody was vouched for: 401, since nothing was offered.
    const anonymous = await nuke(null);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).code).toBe('UNAUTHENTICATED');

    expect(inBucket(site.name)).toBe(true);
  });

  test("is not opened by a site owner's ID token, on any door", async () => {
    const site = await claimed('owner');
    // A token opens its owner's sites; none opens the zone.
    const refused = await kthx().fetch(
      ask('/api/sites', {
        method: 'DELETE',
        token: site.token,
        address: address(),
      }),
    );
    expect(refused.status).toBe(401);
    expect(inBucket(site.name)).toBe(true);
  });

  test('is not opened by a peer this deployment does not believe', async () => {
    const site = await claimed('forged');
    // From any peer but the proxy the header is the client's, and the caller
    // is nobody.
    const refused = await nuke(OPERATOR, '198.51.100.9');
    expect(refused.status).toBe(401);
    expect(inBucket(site.name)).toBe(true);
  });

  test('refuses a browser that is not on this host', async () => {
    const site = await claimed('origin');
    const refused = await kthx().fetch(
      ask('/api/sites', {
        method: 'DELETE',
        host: IDENTITY,
        headers: {
          'tailscale-user-login': OPERATOR,
          origin: `https://${site.host}`,
        },
      }),
      peer(PROXY),
    );
    expect(refused.status).toBe(403);
    expect(inBucket(site.name)).toBe(true);
  });

  test('an admin login deletes any one site, as its owner can', async () => {
    const site = await claimed('one-site');
    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, {
        method: 'DELETE',
        host: IDENTITY,
        headers: { 'tailscale-user-login': OPERATOR },
      }),
      peer(PROXY),
    );
    expect(removed.status).toBe(204);
    expect(inBucket(site.name)).toBe(false);
  });
});

describe('who the environment names', () => {
  const env = (admins: string) => ({
    DATABASE_URL: 'postgres://x/y',
    KTHX_ME_KEY: 'm'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
    KTHX_SITES_BUCKET: 'sites',
    KTHX_ADMIN_LOGINS: admins,
  });

  test('is a list of addresses, folded and trimmed, and empty means nobody', () => {
    // Folded, since a login's case is not the caller's to decide; empty entries
    // are dropped, so a trailing comma names no operator.
    expect(readConfig(env(' Operator@Example.test , ')).adminLogins).toEqual([
      'operator@example.test',
    ]);
    expect(readConfig(env('a@b.test,c@d.test')).adminLogins).toEqual([
      'a@b.test',
      'c@d.test',
    ]);
    expect(readConfig(env('')).adminLogins).toEqual([]);
    expect(readConfig(env(' , ')).adminLogins).toEqual([]);
  });
});
