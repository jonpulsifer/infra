/**
 * `/api/engine/*`: the engine's projected token, checked against an issuer
 * served from loopback, and the routes it opens. Each unit test gets its own
 * issuer path, so its fetch counts are its own.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { base64urlEncode } from '@repo/archive/bytes';
import { tarGz } from '../../cli/tar.ts';
import { EngineKeys, KEYS_STALE_MS, KEYS_TTL_MS } from '../../server/engine.ts';
import {
  ConfigError,
  type EngineConfig,
  readConfig,
} from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const CONTROL = 'ops.kthx-engine.test';
const IDENTITY = 'ops.kthx-tailnet.test';
const PROXY = '10.42.0.7';
const OPERATOR = 'operator@example.test';
const AUDIENCE = 'kthx';
const SUBJECT = 'system:serviceaccount:spindrift:spindrift';

type Pair = CryptoKeyPair & { readonly kid: string; readonly jwk: JsonWebKey };

async function pair(kid: string): Promise<Pair> {
  const keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return {
    ...keys,
    kid,
    jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } as JsonWebKey,
  };
}

const SIGNER = await pair('signer');
const OTHER = await pair('other');

/** What one issuer path publishes, and how often each document was read. */
interface Issuer {
  keys: JsonWebKey[];
  /** Replaces the discovery document's `jwks_uri`. */
  jwksUri?: string;
  down?: boolean;
  discovery: number;
  jwks: number;
}

const issuers = new Map<string, Issuer>();

const server: Bun.Server<unknown> = Bun.serve({
  port: 0,
  fetch(request): Response {
    const { pathname } = new URL(request.url);
    const [, path = '', ...rest] = pathname.split('/');
    const issuer = issuers.get(path);
    if (issuer === undefined || issuer.down) {
      return new Response('down', { status: 503 });
    }
    const base = new URL(`/${path}`, request.url).href;
    const tail = rest.join('/');
    if (tail === '.well-known/openid-configuration') {
      issuer.discovery += 1;
      return Response.json({
        issuer: base,
        jwks_uri: issuer.jwksUri ?? `${base}/openid/v1/jwks`,
      });
    }
    if (tail === 'openid/v1/jwks') {
      issuer.jwks += 1;
      return Response.json({ keys: issuer.keys });
    }
    return new Response('not here', { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
});

/** A fresh issuer path publishing `keys`. */
function issue(
  keys: readonly Pair[] = [SIGNER],
  extra: Partial<Issuer> = {},
): EngineConfig & { readonly served: Issuer } {
  const path = `i${crypto.randomUUID().replaceAll('-', '')}`;
  const served: Issuer = {
    keys: keys.map((key) => key.jwk),
    discovery: 0,
    jwks: 0,
    ...extra,
  };
  issuers.set(path, served);
  return {
    issuer: `http://127.0.0.1:${server.port}/${path}`,
    audience: AUDIENCE,
    subject: SUBJECT,
    served,
  };
}

const json = (value: unknown): string =>
  base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function mint(
  engine: EngineConfig,
  claims: Record<string, unknown> = {},
  key: Pair = SIGNER,
  now = Date.now(),
): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const head = json({ alg: 'RS256', kid: key.kid, typ: 'JWT' });
  const body = json({
    iss: engine.issuer,
    aud: [engine.audience],
    sub: engine.subject,
    iat: seconds,
    nbf: seconds,
    exp: seconds + 3600,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64urlEncode(signature)}`;
}

const ENGINE = issue();

const kthx = withServer({
  controlHost: CONTROL,
  identityHost: IDENTITY,
  tailnetProxies: ['10.42.0.0/16'],
  adminLogins: [OPERATOR],
  engine: { issuer: ENGINE.issuer, audience: AUDIENCE, subject: SUBJECT },
});

const TOKEN = await mint(ENGINE);

async function engine(
  path: string,
  init: Parameters<typeof ask>[1] = {},
  use: () => ReturnType<typeof kthx> = kthx,
) {
  const response = await use().fetch(
    ask(`/api/engine${path}`, { host: CONTROL, token: TOKEN, ...init }),
  );
  return { status: response.status, body: await response.json() };
}

function reserve(holder: unknown, names: unknown) {
  return engine('/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holder, names }),
  });
}

async function reserved(): Promise<{ name: string; holder: string }[]> {
  return (await kthx().sql`
    select name, holder from reservations order by name
  `) as { name: string; holder: string }[];
}

async function claim(name: string) {
  const response = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      host: CONTROL,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function claimed(
  label: string,
): Promise<{ name: string; token: string }> {
  const name = kthx().name(label);
  const answer = await claim(name);
  expect(answer.status).toBe(201);
  return { name, token: answer.body.token as string };
}

async function upload(name: string, token: string): Promise<void> {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}/releases`, {
      method: 'POST',
      host: CONTROL,
      token,
      body: tarGz([
        { path: 'index.html', bytes: new TextEncoder().encode('<p>hi</p>') },
      ]),
    }),
  );
  expect(response.status).toBe(201);
}

async function remove(name: string, token: string): Promise<void> {
  const response = await kthx().fetch(
    ask(`/api/sites/${name}`, { method: 'DELETE', host: CONTROL, token }),
  );
  expect(response.status).toBe(204);
}

describe('the engine credential', () => {
  test('opens the surface with a token from the named issuer', async () => {
    expect(await engine('/sites')).toEqual({
      status: 200,
      body: { total: 0, items: [], next: null },
    });
  });

  test('refuses every other token as 401, and never logs one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await mint(ENGINE, {}, { ...OTHER, kid: SIGNER.kid });
    const refused: Record<string, string | undefined> = {
      none: undefined,
      signature: forged,
      audience: await mint(ENGINE, { aud: ['https://kubernetes.default.svc'] }),
      issuer: await mint(ENGINE, { iss: 'https://oidc.example.test/folly' }),
      subject: await mint(ENGINE, {
        sub: 'system:serviceaccount:kthx:kthx',
      }),
      expired: await mint(ENGINE, { exp: now - 120 }),
      early: await mint(ENGINE, { nbf: now + 600 }),
      garbage: 'not.a.jwt',
    };
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const [why, token] of Object.entries(refused)) {
        const answer = await engine('/sites', { token });
        expect({ why, ...answer }).toEqual({
          why,
          status: 401,
          body: {
            code: 'NOT_ENGINE',
            message: "this path answers the engine's service token only",
          },
        });
      }
      const logged = errors.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('the engine credential');
      expect(logged).toContain('signature failed');
      for (const token of Object.values(refused)) {
        if (token === undefined) continue;
        expect(logged).not.toContain(token);
        // Not even the signature, which alone is the credential's secret part.
        expect(logged).not.toContain(token.split('.')[2] ?? token);
      }
      expect(logged).not.toContain(TOKEN);
    } finally {
      errors.mockRestore();
    }
  });

  test('refuses a request from a browser, token or not', async () => {
    expect(
      await engine('/sites', { headers: { origin: `https://${CONTROL}` } }),
    ).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  test('answers an unknown path 404 and a known one with the wrong verb 405', async () => {
    expect((await engine('')).status).toBe(404);
    expect((await engine('/nothing')).status).toBe(404);
    expect((await engine('/sites/a/b')).status).toBe(404);
    expect((await engine('/sites', { method: 'POST' })).status).toBe(405);
    expect((await engine('/sites/abc', { method: 'DELETE' })).status).toBe(405);
    expect((await engine('/reservations')).status).toBe(405);
  });

  test('is never on the public or tailnet hosts', async () => {
    for (const host of [ZONE, IDENTITY, `x.${ZONE}`]) {
      const answer = await engine('/sites', { host });
      expect(answer.status).toBe(404);
      expect(answer.body.code).not.toBe('NOT_ENGINE');
    }
  });

  describe('with no control host', () => {
    // The public host has `control` here, which must not open the surface.
    const open = withServer({
      engine: { issuer: ENGINE.issuer, audience: AUDIENCE, subject: SUBJECT },
    });

    test('the public host answers 404', async () => {
      expect(await engine('/sites', { host: ZONE }, open)).toMatchObject({
        status: 404,
        body: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('switched off', () => {
    const off = withServer({ controlHost: CONTROL });

    test('every path answers 404', async () => {
      for (const path of ['/sites', '/sites/abc', '/reservations']) {
        expect(await engine(path, {}, off)).toMatchObject({
          status: 404,
          body: { code: 'NOT_FOUND' },
        });
      }
    });
  });
});

describe('the issuer keys', () => {
  test('a good token verifies, and an issuer that is down with no keys is a 503', async () => {
    const up = issue();
    expect(await new EngineKeys(up).verify(await mint(up))).toEqual({
      ok: true,
    });

    // A port that was just closed refuses at once.
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = closed.port;
    closed.stop(true);
    const unreachable: EngineConfig = {
      issuer: `http://127.0.0.1:${port}/offsite`,
      audience: AUDIENCE,
      subject: SUBJECT,
    };
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await new EngineKeys(unreachable).verify(await mint(unreachable)),
      ).toMatchObject({ ok: false, code: 'ISSUER_UNREACHABLE' });
      const down = issue([SIGNER], { down: true });
      expect(await new EngineKeys(down).verify(await mint(down))).toMatchObject(
        { ok: false, code: 'ISSUER_UNREACHABLE' },
      );
    } finally {
      errors.mockRestore();
    }
  });

  test('an unknown kid reloads the keys once, not once per token', async () => {
    const issuer = issue();
    const keys = new EngineKeys(issuer);
    expect(await keys.verify(await mint(issuer))).toEqual({ ok: true });
    expect(issuer.served.jwks).toBe(1);

    const stranger = await mint(issuer, {}, OTHER);
    expect(await keys.verify(stranger)).toMatchObject({
      ok: false,
      code: 'NOT_ENGINE',
      check: 'kid',
    });
    expect(await keys.verify(stranger)).toMatchObject({ check: 'kid' });
    expect(issuer.served.jwks).toBe(2);
  });

  test('a key published after the load verifies on the reload its kid starts', async () => {
    const issuer = issue([SIGNER]);
    const keys = new EngineKeys(issuer);
    expect(await keys.verify(await mint(issuer))).toEqual({ ok: true });
    issuer.served.keys = [SIGNER.jwk, OTHER.jwk];
    expect(await keys.verify(await mint(issuer, {}, OTHER))).toEqual({
      ok: true,
    });
  });

  test('concurrent first calls share one load', async () => {
    const issuer = issue();
    const keys = new EngineKeys(issuer);
    const token = await mint(issuer);
    const verdicts = await Promise.all(
      Array.from({ length: 8 }, () => keys.verify(token)),
    );
    expect(verdicts).toEqual(Array(8).fill({ ok: true }));
    expect(issuer.served.discovery).toBe(1);
    expect(issuer.served.jwks).toBe(1);
  });

  test('refuses a jwks_uri on another origin and never fetches it', async () => {
    const issuer = issue([SIGNER]);
    // The same server under another name is another origin.
    issuer.served.jwksUri = `http://localhost:${server.port}${new URL(issuer.issuer).pathname}/openid/v1/jwks`;
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await new EngineKeys(issuer).verify(await mint(issuer)),
      ).toMatchObject({ ok: false, code: 'ISSUER_UNREACHABLE' });
    } finally {
      errors.mockRestore();
    }
    expect(issuer.served.discovery).toBe(1);
    expect(issuer.served.jwks).toBe(0);
  });

  test('a key the issuer retires stops verifying once the set is an hour old', async () => {
    const issuer = issue([SIGNER, OTHER]);
    let now = Date.parse('2026-10-01T00:00:00Z');
    const keys = new EngineKeys(issuer, { now: () => now });
    const retiring = await mint(
      issuer,
      { exp: now / 1000 + 4 * 3600 },
      OTHER,
      now,
    );
    expect(await keys.verify(retiring)).toEqual({ ok: true });

    issuer.served.keys = [SIGNER.jwk];
    now += KEYS_TTL_MS - 1000;
    expect(await keys.verify(retiring)).toEqual({ ok: true });
    now += 2000;
    expect(await keys.verify(retiring)).toMatchObject({
      ok: false,
      code: 'NOT_ENGINE',
      check: 'kid',
    });
  });

  test('keeps the last set through failed reloads for a day, then is a 503', async () => {
    const issuer = issue();
    let now = Date.parse('2026-10-01T00:00:00Z');
    const keys = new EngineKeys(issuer, { now: () => now });
    const token = await mint(
      issuer,
      { exp: now / 1000 + 48 * 3600 },
      SIGNER,
      now,
    );
    expect(await keys.verify(token)).toEqual({ ok: true });

    issuer.served.down = true;
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      now += KEYS_TTL_MS + 1000;
      expect(await keys.verify(token)).toEqual({ ok: true });
      now = Date.parse('2026-10-01T00:00:00Z') + KEYS_STALE_MS + 1000;
      expect(await keys.verify(token)).toMatchObject({
        ok: false,
        code: 'ISSUER_UNREACHABLE',
      });
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the admin list', () => {
  interface Item {
    readonly name: string;
    readonly owner: string | null;
    readonly serving: number | null;
    readonly deployed: string | null;
  }

  /** Pins the claim time, so the order under test does not depend on timing. */
  async function claimedAt(name: string, iso: string) {
    await kthx().sql`
      update sites set created_at = ${iso}::timestamptz where name = ${name}
    `;
  }

  test('lists every live site with its owner and serving release', async () => {
    const first = await claimed('first');
    const second = await claimed('second');
    const gone = await claimed('gone');
    await upload(second.name, second.token);
    await remove(gone.name, gone.token);
    await kthx().sql`
      update sites set owner_login = 'someone@example.test'
      where name = ${second.name}
    `;
    await claimedAt(first.name, '2026-08-01T00:00:00Z');
    await claimedAt(second.name, '2026-08-02T00:00:00Z');
    const [release] = (await kthx().sql`
      select at from releases where site = ${second.name} and n = 1
    `) as { at: Date }[];

    const listed = await engine('/sites');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      total: 2,
      items: [
        {
          name: second.name,
          url: `https://${second.name}.${ZONE}`,
          owner: 'someone@example.test',
          serving: 1,
          held: false,
          created: '2026-08-02T00:00:00.000Z',
          deployed: release?.at.toISOString(),
          provisioned: true,
        },
        {
          name: first.name,
          url: `https://${first.name}.${ZONE}`,
          owner: null,
          serving: null,
          held: false,
          created: '2026-08-01T00:00:00.000Z',
          deployed: null,
          provisioned: true,
        },
      ],
      next: null,
    });

    // The public directory keeps its keys and still hides the owner.
    const directory = await kthx().fetch(ask('/api/sites', { host: ZONE }));
    const items = (await directory.json()).items as Record<string, unknown>[];
    expect(items.find((item) => item.name === second.name)?.owner).toBeNull();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'at',
        'changed',
        'name',
        'owner',
        'releases',
        'serving',
        'url',
      ]);
    }
  });

  test('walks every site with the cursor and counts them all', async () => {
    const owned = [
      await claimed('walk-a'),
      await claimed('walk-b'),
      await claimed('walk-c'),
    ].map((site) => site.name);
    for (const [index, name] of owned.entries()) {
      await claimedAt(name, `2026-07-0${index + 1}T00:00:00Z`);
    }
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const listed: Awaited<ReturnType<typeof engine>> = await engine(
        after === null ? '/sites?limit=1' : `/sites?limit=1&after=${after}`,
      );
      expect(listed.body.total).toBe(3);
      expect(listed.body.items).toHaveLength(1);
      seen.push(...(listed.body.items as Item[]).map((item) => item.name));
      after = listed.body.next;
      if (after === null) break;
    }
    expect(seen).toEqual([...owned].reverse());
  });

  test('clamps the page size and refuses a cursor that is not a name', async () => {
    await claimed('clamp');
    expect((await engine('/sites?limit=99999')).body.items).toHaveLength(1);
    expect((await engine('/sites?limit=nonsense')).body.items).toHaveLength(1);
    expect((await engine('/sites?limit=')).body.items).toHaveLength(1);
    expect((await engine('/sites?limit=0')).body.items).toHaveLength(1);
    expect(await engine('/sites?after=Not%20A%20Name')).toMatchObject({
      status: 400,
      body: { code: 'INVALID_QUERY' },
    });
  });
});

describe('the site detail', () => {
  test('is what the owner reads, with the claim and serving times', async () => {
    const site = await claimed('detail');
    await upload(site.name, site.token);
    const owned = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { host: CONTROL, token: site.token }),
    );
    expect(owned.status).toBe(200);
    const own = await owned.json();

    const read = await engine(`/sites/${site.name}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      ...own,
      created: expect.any(String),
      deployed: own.releases[0].at,
      provisioned: true,
    });
  });

  test('answers 404 NO_SITE for a name nobody holds and 410 for a deleted one', async () => {
    expect(await engine(`/sites/${kthx().name('nobody')}`)).toMatchObject({
      status: 404,
      body: { code: 'NO_SITE' },
    });
    const gone = await claimed('gone');
    await remove(gone.name, gone.token);
    expect(await engine(`/sites/${gone.name}`)).toMatchObject({
      status: 410,
      body: { code: 'GONE' },
    });
  });
});

describe('reservations', () => {
  const APP = '0b6c1f9e-3d1a-4f7e-9a2b-5c8d7e6f1a2b';
  const OTHER_APP = '7f3e2d1c-0b9a-4e8f-8d7c-6b5a4e3d2c1b';

  test('reserve names for one holder, sorted, and again is a no-op', async () => {
    const names = ['zeta', 'acme', 'api-web'];
    expect(await reserve(APP, names)).toEqual({
      status: 200,
      body: { holder: APP, names: ['acme', 'api-web', 'zeta'] },
    });
    expect(await reserve(APP, names)).toEqual({
      status: 200,
      body: { holder: APP, names: ['acme', 'api-web', 'zeta'] },
    });
    expect(await reserved()).toEqual([
      { name: 'acme', holder: APP },
      { name: 'api-web', holder: APP },
      { name: 'zeta', holder: APP },
    ]);
  });

  test('take labels kthx could never claim, since an app may still serve them', async () => {
    const labels = ['www', 'a', 'ab', 'x'.repeat(41), 'y'.repeat(63)];
    expect((await reserve(APP, labels)).status).toBe(200);
    expect(await reserved()).toHaveLength(labels.length);
  });

  test('a live or deleted site, or another holder, is 409 and nothing is written', async () => {
    const live = await claimed('live');
    const gone = await claimed('gone');
    await remove(gone.name, gone.token);
    expect((await reserve(OTHER_APP, ['held'])).status).toBe(200);

    const answer = await reserve(APP, [live.name, 'free', gone.name, 'held']);
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({
      code: 'TAKEN',
      message: 'that name is taken',
      taken: [
        { name: gone.name, by: 'site' },
        { name: 'held', by: 'app' },
        { name: live.name, by: 'site' },
      ].sort((a, b) => (a.name < b.name ? -1 : 1)),
    });
    expect(await reserved()).toEqual([{ name: 'held', holder: OTHER_APP }]);
  });

  test('refuse any other body as malformed', async () => {
    const bad: [unknown, unknown][] = [
      ['', ['acme']],
      ['A-UUID', ['acme']],
      ['h'.repeat(65), ['acme']],
      [APP, []],
      [APP, 'acme'],
      [APP, ['acme', 'acme']],
      [APP, ['Acme']],
      [APP, ['a.b']],
      [APP, ['-acme']],
      [APP, ['z'.repeat(64)]],
      [APP, Array.from({ length: 33 }, (_, n) => `n${n}`)],
    ];
    for (const [holder, names] of bad) {
      expect({ holder, ...(await reserve(holder, names)) }).toMatchObject({
        holder,
        status: 400,
        body: { code: 'MALFORMED_REQUEST' },
      });
    }
    const untyped = await engine('/reservations', {
      method: 'POST',
      body: JSON.stringify({ holder: APP, names: ['acme'] }),
    });
    expect(untyped.status).toBe(400);
    expect(await reserved()).toEqual([]);
  });

  test('release by name or all of a holder, never another holder', async () => {
    await reserve(APP, ['one', 'two', 'three']);
    await reserve(OTHER_APP, ['four']);
    const release = (query: string) =>
      engine(`/reservations?${query}`, { method: 'DELETE' });

    expect(await release(`holder=${APP}&name=two&name=four`)).toEqual({
      status: 200,
      body: { holder: APP, released: ['two'] },
    });
    expect(await release(`holder=${APP}`)).toEqual({
      status: 200,
      body: { holder: APP, released: ['one', 'three'] },
    });
    expect(await release('holder=nobody')).toEqual({
      status: 200,
      body: { holder: 'nobody', released: [] },
    });
    expect(await reserved()).toEqual([{ name: 'four', holder: OTHER_APP }]);
  });

  test('a release with no holder, or a bad one, is 400 and deletes nothing', async () => {
    await reserve(APP, ['kept']);
    for (const query of [
      '',
      'name=kept',
      'holder=',
      'holder=A',
      `holder=${APP}&name=Kept`,
    ]) {
      expect(
        await engine(`/reservations?${query}`, { method: 'DELETE' }),
      ).toMatchObject({ status: 400, body: { code: 'INVALID_QUERY' } });
    }
    expect(await reserved()).toEqual([{ name: 'kept', holder: APP }]);
  });

  test('a reserved name cannot be claimed', async () => {
    const name = kthx().name('held');
    expect((await reserve(APP, [name])).status).toBe(200);
    expect(await claim(name)).toMatchObject({
      status: 409,
      body: { code: 'TAKEN' },
    });
    const standing = await kthx().fetch(
      ask(`/api/names/${name}`, { host: CONTROL }),
    );
    expect(await standing.json()).toEqual({
      name,
      available: false,
      why: 'TAKEN',
      yours: null,
    });
  });

  test('a reservation racing a claim for one name has one winner', async () => {
    for (let round = 0; round < 5; round += 1) {
      const name = kthx().name(`race-${round}`);
      const [claiming, holding] = await Promise.all([
        claim(name),
        reserve(APP, [name]),
      ]);
      const winners = [claiming.status === 201, holding.status === 200];
      expect(winners.filter(Boolean)).toHaveLength(1);
      expect([claiming.status, holding.status]).toContain(409);
      const [row] = (await kthx().sql`
        select
          (select count(*)::int from sites where name = ${name}) as sites,
          (select count(*)::int from reservations where name = ${name})
            as reservations
      `) as { sites: number; reservations: number }[];
      expect((row?.sites ?? 0) + (row?.reservations ?? 0)).toBe(1);
    }
  });

  test('outlive the nuke', async () => {
    await claimed('nuked');
    expect((await reserve(APP, ['acme'])).status).toBe(200);
    const nuked = await kthx().fetch(
      ask('/api/sites', {
        method: 'DELETE',
        host: IDENTITY,
        headers: { 'tailscale-user-login': OPERATOR },
      }),
      {
        requestIP: () => ({ address: PROXY, port: 1, family: 'IPv4' }),
        timeout: () => undefined,
      } as unknown as Bun.Server<unknown>,
    );
    expect(await nuked.json()).toEqual({ deleted: 1, failed: 0 });
    expect(await reserved()).toEqual([{ name: 'acme', holder: APP }]);
  });
});

describe('the config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
    KTHX_CONTROL_HOST: 'kthx.lab.test',
    KTHX_ENGINE_ISSUER: 'https://oidc.example.test/offsite',
    KTHX_ENGINE_AUDIENCE: AUDIENCE,
    KTHX_ENGINE_SUBJECT: SUBJECT,
  };

  test('reads the issuer, audience and subject together', () => {
    expect(readConfig(env).engine).toEqual({
      issuer: 'https://oidc.example.test/offsite',
      audience: AUDIENCE,
      subject: SUBJECT,
    });
    expect(readConfig({ ...env, KTHX_ENGINE_ISSUER: '' }).engine).toBeNull();
  });

  test('refuses an issuer without a subject, an audience or a control host', () => {
    for (const unset of [
      'KTHX_ENGINE_SUBJECT',
      'KTHX_ENGINE_AUDIENCE',
      'KTHX_CONTROL_HOST',
    ]) {
      expect(() => readConfig({ ...env, [unset]: undefined })).toThrow(
        ConfigError,
      );
    }
  });

  test('refuses an issuer over plain http anywhere but loopback', () => {
    expect(() =>
      readConfig({ ...env, KTHX_ENGINE_ISSUER: 'http://oidc.example.test/x' }),
    ).toThrow(ConfigError);
    expect(
      readConfig({ ...env, KTHX_ENGINE_ISSUER: 'http://127.0.0.1:9/x' }).engine
        ?.issuer,
    ).toBe('http://127.0.0.1:9/x');
  });
});
