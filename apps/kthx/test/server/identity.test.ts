/**
 * Ownership by tailnet login: which door believes a header, which peer may
 * send one, and what a login opens once it is believed.
 *
 * The shape under test is the one measured behind `ingressClassName:
 * tailscale`: the proxy strips whatever the client sent, sets
 * `tailscale-user-login`, preserves `Host`, and puts the caller's own tailnet
 * address at the head of `x-forwarded-for`.
 */
import { describe, expect, test } from 'bun:test';
import { tarGz } from '../../cli/tar.ts';
import { callerOf } from '../../server/caller.ts';
import { type Config, readConfig } from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const CONTROL = 'ops.kthx-private.test';
const IDENTITY = 'kthx.tailnet.test';
/** The proxy pod, which is the only peer allowed to speak for a person. */
const PROXY = '10.42.0.7';

const kthx = withServer({
  controlHost: CONTROL,
  identityHost: IDENTITY,
  tailnetProxies: ['10.42.0.0/16'],
});

const DAD = 'dad@example.test';
const MOM = 'mom@example.test';

const SITE = tarGz([
  { path: 'index.html', bytes: new TextEncoder().encode('<h1>hi</h1>') },
]);

/**
 * A socket peer, the way Bun hands one to the handler.
 *
 * Every test here needs one: a request with no peer at all is a handler called
 * directly, which the resolver reads as a test harness rather than a network,
 * and which would therefore believe every header it was given.
 */
function peer(address: string): Bun.Server<unknown> {
  return {
    requestIP: () => ({ address, port: 1, family: 'IPv4' }),
    timeout: () => undefined,
  } as unknown as Bun.Server<unknown>;
}

function as(login: string | null): Record<string, string> {
  return login === null ? {} : { 'tailscale-user-login': login };
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

/** A request through the proxy, as a person on the tailnet. */
function ontailnet(
  path: string,
  login: string | null,
  init: Parameters<typeof ask>[1] = {},
) {
  const { headers, ...rest } = init;
  return kthx().fetch(
    ask(path, {
      host: IDENTITY,
      headers: { ...as(login), ...headers },
      ...rest,
    }),
    peer(PROXY),
  );
}

async function claimAs(login: string | null, label: string) {
  const name = kthx().name(label);
  const claimed = await json(
    await ontailnet('/api/sites', login, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  expect(claimed.status).toBe(201);
  return { name, token: claimed.body.token as string };
}

describe('the identity header', () => {
  test('is read on the identity host and nowhere else', async () => {
    const believed = await json(
      await ontailnet('/api/whoami', DAD, { method: 'GET' }),
    );
    expect(believed).toEqual({ status: 200, body: { login: DAD } });

    // The public apex and the agent control host both answer to callers who
    // can write any header they please.
    for (const host of [ZONE, CONTROL]) {
      const response = await kthx().fetch(
        ask('/api/whoami', { host, headers: as(DAD) }),
        peer(PROXY),
      );
      expect(response.status).toBe(401);
    }
  });

  test('is ignored from a peer that is not the tailnet proxy', async () => {
    const response = await kthx().fetch(
      ask('/api/whoami', { host: IDENTITY, headers: as(DAD) }),
      peer('10.99.0.3'),
    );
    expect(response.status).toBe(401);
  });

  test('is a 404 through the tunnel, as the control host is', async () => {
    const response = await ontailnet('/api/whoami', DAD, {
      method: 'GET',
      address: '203.0.113.9',
    });
    expect(response.status).toBe(404);
  });
});

describe('a site', () => {
  test('is opened by its bearer, its login, and nothing else', async () => {
    const dads = await claimAs(DAD, 'dads');
    expect(
      (await json(await ontailnet(`/api/sites/${dads.name}`, DAD))).body,
    ).toMatchObject({ name: dads.name, owner: DAD });

    // The bearer keeps working, on the host where reach is the credential and
    // no login is ever asserted: an agent has no other way in.
    const byBearer = await kthx().fetch(
      ask(`/api/sites/${dads.name}`, { host: CONTROL, token: dads.token }),
      peer(PROXY),
    );
    expect(byBearer.status).toBe(200);

    // Somebody else on the same tailnet opens her own sites and not his. A
    // login that is not this site's is not a credential *offered* for it, so
    // the answer stays the 401 an anonymous read gets — which is what keeps
    // "401 means claimed, 404 means free" true on this host too.
    const moms = await claimAs(MOM, 'moms');
    expect((await ontailnet(`/api/sites/${moms.name}`, MOM)).status).toBe(200);
    expect((await ontailnet(`/api/sites/${dads.name}`, MOM)).status).toBe(401);
    // A bearer that is not this site's is a credential offered and refused.
    const wrong = await ontailnet(`/api/sites/${dads.name}`, MOM, {
      token: moms.token,
    });
    expect(wrong.status).toBe(403);
    // Reach alone opens nothing, which is the whole difference between this
    // host and the control host.
    expect((await ontailnet(`/api/sites/${dads.name}`, null)).status).toBe(401);
  });

  test('with a null token_hash is opened by its login alone', async () => {
    const dads = await claimAs(DAD, 'nulled');
    await kthx().sql`
      update sites set token_hash = null where name = ${dads.name}
    `;

    // The hash is gone, so the bearer that was minted with it opens nothing —
    // and the comparison is never reached, which is what the live column being
    // nullable had made a throw.
    const byBearer = await kthx().fetch(
      ask(`/api/sites/${dads.name}`, { host: CONTROL, token: dads.token }),
      peer(PROXY),
    );
    expect(byBearer.status).toBe(403);
    expect((await ontailnet(`/api/sites/${dads.name}`, MOM)).status).toBe(401);
    expect((await ontailnet(`/api/sites/${dads.name}`, DAD)).status).toBe(200);
  });

  test('refuses a release posted from another origin', async () => {
    const dads = await claimAs(DAD, 'crossed');
    const refused = await ontailnet(`/api/sites/${dads.name}/releases`, DAD, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        origin: 'https://evil.test',
      },
      body: SITE,
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('FORBIDDEN');

    const allowed = await ontailnet(`/api/sites/${dads.name}/releases`, DAD, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        origin: `https://${IDENTITY}`,
      },
      body: SITE,
    });
    expect(allowed.status).toBe(201);
  });
});

describe('your websites', () => {
  test('lists the caller’s own sites and names no one else’s owner', async () => {
    const dads = await claimAs(DAD, 'mine-a');
    const moms = await claimAs(MOM, 'mine-b');

    const listed = await json(await ontailnet('/api/sites?owner=me', DAD));
    expect(listed.status).toBe(200);
    const names = listed.body.items.map((item: { name: string }) => item.name);
    expect(names).toContain(dads.name);
    expect(names).not.toContain(moms.name);

    // The public list still holds both, with nobody's address on it but the
    // reader's own.
    const all = await json(await ontailnet('/api/sites', DAD));
    const seen = all.body.items as { name: string; owner: string | null }[];
    expect(seen.find((item) => item.name === dads.name)?.owner).toBe(DAD);
    expect(seen.find((item) => item.name === moms.name)?.owner).toBeNull();
  });

  test('needs a login, and takes no other owner', async () => {
    expect((await ontailnet('/api/sites?owner=me', null)).status).toBe(401);
    const other = await json(
      await ontailnet(`/api/sites?owner=${encodeURIComponent(MOM)}`, DAD),
    );
    expect(other).toMatchObject({
      status: 400,
      body: { code: 'INVALID_QUERY' },
    });
  });
});

describe('GET /api/names/:name', () => {
  const probe = async (name: string) =>
    json(await kthx().fetch(ask(`/api/names/${name}`)));

  test('answers whether a name can be claimed', async () => {
    const free = kthx().name('unclaimed');
    expect((await probe(free)).body).toEqual({
      name: free,
      available: true,
      why: null,
    });

    const taken = await claimAs(DAD, 'probed');
    expect((await probe(taken.name)).body).toEqual({
      name: taken.name,
      available: false,
      why: 'TAKEN',
    });

    // A deleted name is taken forever: its row is what answers 410 on the site
    // host, so there is no `deleted_at` filter here.
    const removed = await ontailnet(`/api/sites/${taken.name}`, DAD, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);
    expect((await probe(taken.name)).body).toMatchObject({
      available: false,
      why: 'TAKEN',
    });
  });

  test('refuses a name the rules refuse, without reading a row', async () => {
    expect((await probe('admin')).body).toMatchObject({ why: 'RESERVED' });
    expect((await probe('no')).body).toMatchObject({ why: 'INVALID_NAME' });
    expect((await probe('Not-A-Name!')).body).toMatchObject({
      why: 'INVALID_NAME',
    });
    expect((await probe('')).status).toBe(404);
  });
});

describe('the caller', () => {
  const config = (over: Partial<Config> = {}): Config => ({
    ...kthx().config,
    ...over,
  });

  function resolve(
    host: string,
    headers: Record<string, string>,
    from: string | undefined,
    over: Partial<Config> = {},
  ) {
    const request = new Request(`http://${host}/`, { headers });
    return callerOf(
      request,
      from === undefined ? undefined : peer(from),
      config(over),
      host,
    );
  }

  test('keys its buckets by the login, then the tailnet address', () => {
    const forwarded = { 'x-forwarded-for': '100.104.133.114' };
    expect(resolve(IDENTITY, { ...as(DAD), ...forwarded }, PROXY).bucket).toBe(
      DAD,
    );
    // No login — a tagged node — still gets its own bucket rather than sharing
    // one with everybody who reaches the host.
    expect(resolve(IDENTITY, forwarded, PROXY).bucket).toBe('100.104.133.114');
    // Off the identity door `x-forwarded-for` is a header the client wrote.
    expect(resolve(ZONE, forwarded, PROXY).bucket).toBe(PROXY);
    expect(resolve(IDENTITY, forwarded, '10.99.0.3').bucket).toBe('10.99.0.3');
    // A proxy appends, so a client that wrote its own entry is at the head of
    // the list and the hop this server trusts is at the tail.
    expect(
      resolve(
        IDENTITY,
        { 'x-forwarded-for': '198.51.100.9, 100.104.133.114' },
        PROXY,
      ).bucket,
    ).toBe('100.104.133.114');
  });

  test('reads nothing at all when no identity host is configured', () => {
    const caller = resolve(
      IDENTITY,
      { ...as(DAD), 'x-forwarded-for': '100.104.133.114' },
      PROXY,
      { identityHost: null },
    );
    expect(caller).toMatchObject({
      door: 'public',
      login: null,
      bucket: PROXY,
    });
  });
});

describe('the config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
  };

  test('refuses an identity host inside the zone or on the control host', () => {
    for (const host of ['kthx.dev', 'ops.kthx.dev']) {
      expect(() => readConfig({ ...env, KTHX_IDENTITY_HOST: host })).toThrow(
        'outside kthx.dev',
      );
    }
    expect(() =>
      readConfig({
        ...env,
        KTHX_CONTROL_HOST: CONTROL,
        KTHX_IDENTITY_HOST: CONTROL.toUpperCase(),
      }),
    ).toThrow('must not be KTHX_CONTROL_HOST');
  });

  test('defaults to the tailscale header and to trusting no peer', () => {
    const read = readConfig({
      ...env,
      KTHX_IDENTITY_HOST: ' KTHX.Tailnet.Test ',
    });
    expect(read.identityHost).toBe(IDENTITY);
    expect(read.identityHeader).toBe('tailscale-user-login');
    expect(read.tailnetProxies).toEqual([]);
    // Separate lists: the pod CIDR one is not the one an identity is read from.
    const both = readConfig({
      ...env,
      KTHX_TRUSTED_PROXIES: '10.42.0.0/16',
      KTHX_TAILNET_PROXIES: '10.42.0.7',
    });
    expect(both.trustedProxies).toEqual(['10.42.0.0/16']);
    expect(both.tailnetProxies).toEqual(['10.42.0.7']);
  });
});
