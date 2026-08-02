import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAdapterRegistry } from '../../../src/adapters/registry.ts';
import { base64urlEncode } from '../../../src/auth/bytes.ts';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialKeyring,
} from '../../../src/crypto/credential-envelope.ts';
import {
  githubDeviceAuthorizations,
  githubOAuthCredentials,
  users,
} from '../../../src/db/schema.ts';
import { RepositoryAuthorizationRequiredError } from '../../../src/domain/repository.ts';
import { GitHubApp } from '../../../src/integrations/github/app.ts';
import type { Fetcher } from '../../../src/integrations/github/http.ts';
import { GitHubDeviceOAuth } from '../../../src/integrations/github/oauth.ts';
import { withIsolatedDatabase } from '../../harness/db.ts';
import { fixtureManifest } from '../../harness/installation.ts';

const database = withIsolatedDatabase();
const OAUTH = 'https://github.example.test';
const API = 'https://api.github.example.test';
const CLIENT_ID = 'Iv1.test';

function ring(active = 'current', legacy: Record<string, string> = {}) {
  const material = encodedKey(active === 'current' ? 7 : 9);
  return CredentialKeyring.fromEnvironment({
    [CREDENTIAL_KEYRING_VAR]: JSON.stringify({
      active,
      keys: { [active]: material, ...legacy },
    }),
  })!;
}

function encodedKey(fill: number): string {
  return base64urlEncode(new Uint8Array(32).fill(fill));
}

function keyringValue(): string {
  return JSON.stringify({
    active: 'current',
    keys: { current: encodedKey(7) },
  });
}

class FakeDeviceOAuth {
  approved = false;
  denied = false;
  refreshes = 0;
  tokenPolls = 0;
  rejectApi = false;
  readonly deviceCode = 'device-code-that-never-reaches-the-browser';
  readonly accessToken = 'first-access-token';
  readonly refreshToken = 'first-refresh-token';

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    if (url.origin === API && this.rejectApi) {
      return Response.json({ message: 'Bad credentials' }, { status: 401 });
    }
    if (url.origin === OAUTH && url.pathname === '/login/device/code') {
      return Response.json({
        device_code: this.deviceCode,
        user_code: 'ABCD-EFGH',
        verification_uri: `${OAUTH}/login/device`,
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.origin === OAUTH && url.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') === 'refresh_token') {
        this.refreshes += 1;
        return Response.json({
          access_token: `refreshed-access-${this.refreshes}`,
          token_type: 'bearer',
          expires_in: 28_800,
          refresh_token: `refreshed-refresh-${this.refreshes}`,
          refresh_token_expires_in: 15_552_000,
        });
      }
      this.tokenPolls += 1;
      if (this.denied) {
        return Response.json({ error: 'access_denied' });
      }
      if (!this.approved) {
        return Response.json({ error: 'authorization_pending' });
      }
      return Response.json({
        access_token: this.accessToken,
        token_type: 'bearer',
        expires_in: 28_800,
        refresh_token: this.refreshToken,
        refresh_token_expires_in: 15_552_000,
      });
    }
    if (url.origin === API && url.pathname === '/user') {
      return Response.json({ id: 42, login: 'operator' });
    }
    if (url.origin === API && url.pathname === '/user/installations') {
      return Response.json({ installations: [{ id: 37547020 }] });
    }
    if (
      url.origin === API &&
      url.pathname === '/user/installations/37547020/repositories'
    ) {
      return Response.json({
        repositories: [
          { id: 99, full_name: 'example/app', default_branch: 'trunk' },
        ],
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
}

async function setup() {
  let now = new Date('2026-07-30T12:00:00.000Z');
  const fake = new FakeDeviceOAuth();
  const clock = { now: () => now };
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const oauth = new GitHubDeviceOAuth({
    db: database().db,
    clock,
    keyring: ring(),
    clientId: CLIENT_ID,
    oauthBaseUrl: OAUTH,
    apiBaseUrl: API,
    fetch: fake.fetch,
  });
  return {
    fake,
    clock,
    oauth,
    user: user!,
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

describe('GitHub Device OAuth', () => {
  test('is the production repository host without an App private key', async () => {
    const { fake, clock, user } = await setup();
    const fixture = await fixtureManifest();
    const registry = createAdapterRegistry({
      manifest: {
        ...fixture,
        github: {
          ...fixture.github,
          clientId: CLIENT_ID,
          oauthBaseUrl: OAUTH,
          apiBaseUrl: API,
        },
      },
      db: database().db,
      clock,
      env: { [CREDENTIAL_KEYRING_VAR]: keyringValue() },
      fetch: fake.fetch,
    });

    expect(registry.repository()).not.toBeNull();
    const authorization = registry.repositoryAuthorization?.() ?? null;
    expect(authorization).not.toBeNull();
    expect(await authorization!.begin(user.id)).toMatchObject({
      userCode: 'ABCD-EFGH',
    });
  });

  test('keeps device and user credentials encrypted through authorization', async () => {
    const { oauth, fake, user, advance } = await setup();

    expect(await oauth.status()).toEqual({ state: 'unauthorized' });
    const begun = await oauth.begin(user.id);
    expect(begun).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: `${OAUTH}/login/device`,
      intervalSeconds: 5,
    });
    const [attempt] = await database()
      .db.select()
      .from(githubDeviceAuthorizations);
    expect(attempt!.encryptedDeviceCode).not.toContain(fake.deviceCode);

    expect(await oauth.poll(user.id, begun.attemptId)).toMatchObject({
      state: 'pending',
      retryAfterSeconds: 5,
    });
    expect(fake.tokenPolls).toBe(0);

    advance(5);
    expect(await oauth.poll(user.id, begun.attemptId)).toMatchObject({
      state: 'pending',
      retryAfterSeconds: 5,
    });
    expect(fake.tokenPolls).toBe(1);

    fake.approved = true;
    advance(5);
    expect(await oauth.poll(user.id, begun.attemptId)).toEqual({
      state: 'authorized',
      login: 'operator',
    });
    expect(await oauth.status()).toEqual({
      state: 'authorized',
      login: 'operator',
      githubUserId: '42',
    });
    expect(
      await database().db.select().from(githubDeviceAuthorizations),
    ).toEqual([]);
    const [credential] = await database()
      .db.select()
      .from(githubOAuthCredentials);
    expect(credential!.encryptedCredential).not.toContain(fake.accessToken);
    expect(credential!.encryptedCredential).not.toContain(fake.refreshToken);
    expect(await oauth.authorization()).toBe(`bearer ${fake.accessToken}`);
  });

  test('binds an attempt to the Spindrift principal', async () => {
    const { oauth, user, fake, advance } = await setup();
    const [other] = await database()
      .db.insert(users)
      .values({ displayName: 'Other operator' })
      .returning();
    const begun = await oauth.begin(user.id);
    advance(5);
    fake.approved = true;

    expect(await oauth.poll(other!.id, begun.attemptId)).toEqual({
      state: 'expired',
    });
    expect(await oauth.poll(user.id, begun.attemptId)).toEqual({
      state: 'authorized',
      login: 'operator',
    });
  });

  test('serializes refresh-token rotation across concurrent callers', async () => {
    const { oauth, fake, user, advance } = await setup();
    const begun = await oauth.begin(user.id);
    fake.approved = true;
    advance(5);
    await oauth.poll(user.id, begun.attemptId);

    // Five minutes before expiry is the refresh margin.
    advance(28_500);
    expect(
      await Promise.all([oauth.authorization(), oauth.authorization()]),
    ).toEqual(['bearer refreshed-access-1', 'bearer refreshed-access-1']);
    expect(fake.refreshes).toBe(1);

    const [row] = await database()
      .db.select()
      .from(githubOAuthCredentials)
      .where(eq(githubOAuthCredentials.id, 1));
    const opened = await ring().open(
      row!.encryptedCredential,
      'spindrift-github-oauth-credential',
    );
    expect(opened.plaintext).toContain('refreshed-refresh-1');
    expect(opened.plaintext).not.toContain(fake.refreshToken);
  });

  test('discovers repository installation identity through the user token', async () => {
    const { oauth, fake, user, advance } = await setup();
    const begun = await oauth.begin(user.id);
    fake.approved = true;
    advance(5);
    await oauth.poll(user.id, begun.attemptId);

    const host = new GitHubApp({
      baseUrl: API,
      authorization: () => oauth.authorization(),
      fetch: fake.fetch,
    });
    expect(await host.availableRepositories()).toEqual([
      {
        repositoryId: '99',
        fullName: 'example/app',
        defaultBranch: 'trunk',
        installationId: '37547020',
      },
    ]);
    expect(await host.installationFor('example/app')).toEqual({
      installationId: '37547020',
    });
  });

  test('lazily re-encrypts a credential under the active rotation key', async () => {
    const { oauth, fake, user, advance, clock } = await setup();
    const begun = await oauth.begin(user.id);
    fake.approved = true;
    advance(5);
    await oauth.poll(user.id, begun.attemptId);

    const rotated = ring('rotated', { current: encodedKey(7) });
    const afterRotation = new GitHubDeviceOAuth({
      db: database().db,
      clock,
      keyring: rotated,
      clientId: CLIENT_ID,
      oauthBaseUrl: OAUTH,
      apiBaseUrl: API,
      fetch: fake.fetch,
    });
    expect(await afterRotation.authorization()).toBe(
      `bearer ${fake.accessToken}`,
    );

    const [row] = await database().db.select().from(githubOAuthCredentials);
    const envelope = JSON.parse(row!.encryptedCredential) as {
      keyId: string;
    };
    expect(envelope.keyId).toBe('rotated');
    expect(
      await rotated.open(
        row!.encryptedCredential,
        'spindrift-github-oauth-credential',
      ),
    ).toMatchObject({ needsRotation: false });
  });

  test('treats a rejected user token as reauthorization, not repository loss', async () => {
    const { oauth, fake, user, advance } = await setup();
    const begun = await oauth.begin(user.id);
    fake.approved = true;
    advance(5);
    await oauth.poll(user.id, begun.attemptId);

    const host = new GitHubApp({
      baseUrl: API,
      authorization: () => oauth.authorization(),
      onUnauthorized: (authorization) =>
        oauth.rejectedAuthorization(authorization),
      fetch: fake.fetch,
    });
    fake.rejectApi = true;
    await expect(host.availableRepositories()).rejects.toBeInstanceOf(
      RepositoryAuthorizationRequiredError,
    );
    expect(await oauth.status()).toEqual({ state: 'unauthorized' });
  });

  test('a late rejection cannot erase a refreshed credential', async () => {
    const { oauth, fake, user, advance } = await setup();
    const begun = await oauth.begin(user.id);
    fake.approved = true;
    advance(5);
    await oauth.poll(user.id, begun.attemptId);
    advance(28_500);
    await oauth.authorization();

    await oauth.rejectedAuthorization(`bearer ${fake.accessToken}`);
    expect(await oauth.status()).toMatchObject({
      state: 'authorized',
      login: 'operator',
    });
  });
});
