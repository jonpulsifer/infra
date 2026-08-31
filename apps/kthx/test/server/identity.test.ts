/**
 * Ownership: the token the server verifies, the row it compares, and the two
 * ways a site changes hands.
 *
 * The verifier is checked against a JWKS this file mints, because the claim
 * worth testing is not "a real Google token works" — it is that every token
 * that should not work does not. Each test moves one claim.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Config } from '../../server/env.ts';
import { forgetKeys, verifyIdToken } from '../../server/identity.ts';
import {
  AUDIENCE,
  ask,
  idToken,
  jwksUrl,
  rotatedJwks,
  subOf,
  withServer,
  ZONE,
} from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `203.0.113.${nextAddress % 250}`;
}

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** A claimed, provisioned site, and the identity that owns it. */
async function mine(label: string, email = `${label}@example.com`) {
  const name = kthx().name(label);
  const token = await idToken(email);
  const claimed = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
    }),
  );
  expect(claimed.status).toBe(201);
  return { name, token, email };
}

/**
 * The same site as a machine claimed it before identities existed: a bearer
 * hash on the row, and no owner.
 */
async function legacy(label: string, bearer: string) {
  const site = await mine(label);
  await kthx().sql`
    update sites
    set owner_sub = null, owner_email = null, token_hash = ${hash(bearer)}
    where name = ${site.name}
  `;
  return site;
}

const inspect = (name: string, token?: string) =>
  kthx().fetch(ask(`/api/sites/${name}`, { token }));

// --- the token --------------------------------------------------------------

describe('a google id token', () => {
  /** The verifier alone, against the JWKS this file publishes. */
  const verify = (token: string, over: Partial<Config> = {}) =>
    verifyIdToken(token, { ...kthx().config, ...over } as Config);

  test('a well-formed token is the account it names', async () => {
    expect(await verify(await idToken('someone@example.com'))).toEqual({
      sub: subOf('someone@example.com'),
      email: 'someone@example.com',
    });
  });

  test.each([
    ['expired', { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }],
    [
      'issued in the future',
      { claims: { iat: Math.floor(Date.now() / 1000) + 3600 } },
    ],
    ['for another audience', { claims: { aud: 'someone-elses-client-id' } }],
    ['from another issuer', { claims: { iss: 'https://accounts.evil.test' } }],
    ['with an unverified address', { claims: { email_verified: false } }],
    [
      'with no email_verified at all',
      { claims: { email_verified: undefined } },
    ],
    ['with no address', { claims: { email: undefined } }],
    ['with no subject', { claims: { sub: undefined } }],
    ['signed by a key nobody published', { unpublished: true }],
    ['claiming an algorithm this does not do', { alg: 'HS256' }],
    ['naming a key that does not exist', { kid: 'not-a-key' }],
  ] as const)('a token %s opens nothing', async (_what, options) => {
    expect(await verify(await idToken('someone@example.com', options))).toBe(
      null,
    );
  });

  test.each([
    ['not a jwt at all', 'kthx'],
    ['two parts', 'aGVhZGVy.aGVhZGVy'],
    ['four parts', 'a.b.c.d'],
    ['parts that are not base64url', 'héader.påyload.sïg'],
    ['parts that are not JSON', 'bm90LWpzb24.bm90LWpzb24.c2ln'],
    ['nothing', ''],
  ] as const)('garbage — %s — opens nothing', async (_what, token) => {
    expect(await verify(token)).toBe(null);
  });

  test('a token longer than any real one is refused before it is parsed', async () => {
    const long = `${await idToken()}${'a'.repeat(9000)}`;
    expect(await verify(long)).toBe(null);
  });

  test('an audience this deployment names is accepted, one it does not is not', async () => {
    const token = await idToken('someone@example.com', {
      claims: { aud: 'a-second-client-id' },
    });
    expect(await verify(token)).toBe(null);
    expect(
      await verify(token, { oidcAudiences: [AUDIENCE, 'a-second-client-id'] }),
    ).not.toBe(null);
  });

  test('a key the cache has never seen is fetched once more', async () => {
    // What a rotation looks like from here: the keys in hand carry neither the
    // `kid` on the token nor a key that verifies it, and the JWKS has moved on.
    forgetKeys();
    const rotated = jwksUrl(await rotatedJwks());
    expect(
      await verify(await idToken('someone@example.com'), {
        jwksUrl: rotated,
      }),
    ).toBe(null);
    // And the published key still works, from a cache that just missed.
    forgetKeys();
    expect(await verify(await idToken('someone@example.com'))).not.toBe(null);
  });
});

// --- who owns a site --------------------------------------------------------

describe('ownership', () => {
  test('the account that claimed a name is the one that opens it', async () => {
    const site = await mine('owned');
    const found = await inspect(site.name, site.token);
    expect(found.status).toBe(200);
    expect(((await found.json()) as { owner: string }).owner).toBe(site.email);
  });

  test('another account is 403, and no credential at all is 401', async () => {
    const site = await mine('theirs');
    expect(
      (await inspect(site.name, await idToken('other@example.com'))).status,
    ).toBe(403);
    expect((await inspect(site.name)).status).toBe(401);
    // A free name is 404 whether or not a credential came with it: that is the
    // taken-probe, and it must not become an oracle for who owns what.
    expect((await inspect(kthx().name('free'), site.token)).status).toBe(404);
  });

  test('the subject is what is compared, not the address', async () => {
    const site = await mine('renamed');
    // An address can change hands; the account behind it cannot. A token for
    // the same `sub` under a new address still opens the site.
    const moved = await idToken(site.email, {
      claims: { email: 'moved@example.com' },
    });
    expect((await inspect(site.name, moved)).status).toBe(200);
    // And the same address under another subject does not.
    const impostor = await idToken('impostor@example.com', {
      claims: { email: site.email },
    });
    expect((await inspect(site.name, impostor)).status).toBe(403);
  });

  test('a token that does not verify is 403, not a way in', async () => {
    const site = await mine('forged');
    const forged = await idToken(site.email, { unpublished: true });
    expect((await inspect(site.name, forged)).status).toBe(403);
  });

  test('an owner opens the owner-scoped routes on the site host', async () => {
    const site = await mine('host');
    const drop = (token?: string) =>
      kthx().fetch(
        ask('/api/db/notes', {
          host: `${site.name}.${ZONE}`,
          method: 'DELETE',
          token,
          headers: { origin: `https://${site.name}.${ZONE}` },
        }),
      );
    expect((await drop(site.token)).status).toBe(204);
    expect((await drop()).status).toBe(401);
    expect((await drop(await idToken('other@example.com'))).status).toBe(403);
  });
});

// --- adopt ------------------------------------------------------------------

describe('adopt', () => {
  const BEARER = 'a-token-minted-before-identities-existed';

  const adopt = (
    name: string,
    body: unknown,
    init: Parameters<typeof ask>[1] = {},
  ) =>
    kthx().fetch(
      ask(`/api/sites/${name}/adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        address: address(),
        ...init,
      }),
    );

  test('the old bearer opens the site until an identity takes it', async () => {
    const site = await legacy('carry', BEARER);
    // Nothing breaks mid-transition: the bearer still works…
    expect((await inspect(site.name, BEARER)).status).toBe(200);
    // …and the identity that will own it does not yet.
    expect((await inspect(site.name, site.token)).status).toBe(403);

    expect(
      (await adopt(site.name, { token: BEARER }, { token: site.token })).status,
    ).toBe(204);

    const [row] = await kthx().sql`
      select owner_sub, owner_email, token_hash from sites
      where name = ${site.name}
    `;
    expect(row.owner_sub).toBe(subOf(site.email));
    expect(row.owner_email).toBe(site.email);
    // The bearer is spent, not kept beside the identity.
    expect(row.token_hash).toBeNull();
    expect((await inspect(site.name, site.token)).status).toBe(200);
    expect((await inspect(site.name, BEARER)).status).toBe(403);
  });

  test('a wrong bearer adopts nothing, and an anonymous one is 401', async () => {
    const site = await legacy('wrong', BEARER);
    expect(
      (await adopt(site.name, { token: 'not-it' }, { token: site.token }))
        .status,
    ).toBe(403);
    expect((await adopt(site.name, {}, { token: site.token })).status).toBe(
      403,
    );
    expect((await adopt(site.name, { token: BEARER })).status).toBe(401);
    const [row] = await kthx()
      .sql`select owner_sub from sites where name = ${site.name}`;
    expect(row.owner_sub).toBeNull();
  });

  test('a site that already has an owner is 409, whoever asks', async () => {
    const site = await mine('already');
    expect(
      (await adopt(site.name, { token: BEARER }, { token: site.token })).status,
    ).toBe(409);
    const stranger = await idToken('stranger@example.com');
    const refused = await adopt(
      site.name,
      { token: BEARER },
      { token: stranger },
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('OWNED');
  });

  test('adopting twice is 409 the second time', async () => {
    const site = await legacy('twice', BEARER);
    expect(
      (await adopt(site.name, { token: BEARER }, { token: site.token })).status,
    ).toBe(204);
    expect(
      (await adopt(site.name, { token: BEARER }, { token: site.token })).status,
    ).toBe(409);
  });

  test('a name with no row is 404, and a deleted one is 410', async () => {
    const site = await legacy('gone', BEARER);
    expect(
      (
        await adopt(
          kthx().name('never'),
          { token: BEARER },
          { token: site.token },
        )
      ).status,
    ).toBe(404);
    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: BEARER }),
    );
    expect(removed.status).toBe(204);
    expect(
      (await adopt(site.name, { token: BEARER }, { token: site.token })).status,
    ).toBe(410);
  });

  test('the directory says a site is unadopted, and then who has it', async () => {
    const site = await legacy('listed', BEARER);
    const listed = async () => {
      const page = (await (await kthx().fetch(ask('/api/sites'))).json()) as {
        items: { name: string; owner: string | null }[];
      };
      return page.items.find((item) => item.name === site.name);
    };
    expect(await listed()).toMatchObject({ owner: null });
    await adopt(site.name, { token: BEARER }, { token: site.token });
    expect(await listed()).toMatchObject({ owner: site.email });
  });
});

// --- the proxy seam ---------------------------------------------------------

describe('a trusted identity header', () => {
  const HEADER = 'x-goog-authenticated-user-email';

  /** A request that arrived from this address, as far as the server can tell. */
  const from = (peer: string) =>
    ({
      requestIP: () => ({ address: peer, family: 'IPv4', port: 1 }),
    }) as unknown as Bun.Server<unknown>;

  test('is not believed at all until the deployment names one', async () => {
    const name = kthx().name('seamless');
    const refused = await kthx().fetch(
      ask('/api/sites', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADER]: 'iap@example.com',
        },
        body: JSON.stringify({ name }),
        address: address(),
      }),
    );
    expect(refused.status).toBe(401);
  });

  describe('once it is named', () => {
    const seam = withServer({
      trustedIdentityHeader: HEADER,
      trustedProxies: ['192.0.2.7'],
    });

    const claim = (name: string, header: string | null, peer: string) =>
      seam().fetch(
        ask('/api/sites', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(header === null ? {} : { [HEADER]: header }),
          },
          body: JSON.stringify({ name }),
          address: address(),
        }),
        from(peer),
      );

    test('a trusted hop says who the caller is, prefix and all', async () => {
      const name = seam().name('iap');
      // What IAP writes, which is the address with the issuer in front of it.
      expect(
        (await claim(name, 'accounts.google.com:Iap@Example.com', '192.0.2.7'))
          .status,
      ).toBe(201);
      const [row] = await seam()
        .sql`select owner_email, owner_sub from sites where name = ${name}`;
      expect(row.owner_email).toBe('iap@example.com');
      expect(row.owner_sub).toBe('iap@example.com');
    });

    test('the same header from any other peer is worth nothing', async () => {
      const refused = await claim(
        seam().name('spoof'),
        'iap@example.com',
        '198.51.100.9',
      );
      expect(refused.status).toBe(401);
    });

    test('a trusted hop that asserts nothing is still anonymous', async () => {
      expect(
        (await claim(seam().name('quiet'), null, '192.0.2.7')).status,
      ).toBe(401);
      expect(
        (await claim(seam().name('blank'), '   ', '192.0.2.7')).status,
      ).toBe(401);
    });
  });
});
