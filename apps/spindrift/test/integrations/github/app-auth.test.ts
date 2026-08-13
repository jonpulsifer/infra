/**
 * The App's own authentication (§15): JWT signing, installation tokens, and
 * the manifest-flow setup that brings the identity into being.
 *
 * Three claims are properties of this file rather than of anybody's
 * discipline:
 *
 * - **The key never leaves.** It arrives once in the conversion response, is
 *   sealed immediately, and nothing this module answers — a JWT, a token, a
 *   status, a setup form — contains it.
 * - **Identity is read per mint, never captured.** The `github_app` row is
 *   written mid-flight by the setup route while the process keeps running, so
 *   an agent constructed before the App existed must start minting the moment
 *   the row does — no restart, no reconstruction.
 * - **A rejected mint is retried once, and nothing durable is spent.** The
 *   Device Flow predecessor deleted its stored credential on a `401`; an
 *   installation token is an hour-lived mint, so the right response is a
 *   fresh mint and, only when that also fails, the ordinary `ACCESS_LOST`.
 */
import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '../../../src/auth/bytes.ts';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialKeyring,
} from '../../../src/crypto/credential-envelope.ts';
import { githubApp } from '../../../src/db/schema.ts';
import { RepositoryAuthorizationRequiredError } from '../../../src/domain/repository.ts';
import { GitHubApp } from '../../../src/integrations/github/app.ts';
import {
  GitHubAppAuth,
  GitHubAppSetupError,
  githubAppWebhookSecret,
} from '../../../src/integrations/github/app-auth.ts';
import type { Fetcher } from '../../../src/integrations/github/http.ts';
import { withIsolatedDatabase } from '../../harness/db.ts';
import { FakeGitHub, testAppKey } from '../../harness/fakes/github-api.ts';

const database = withIsolatedDatabase();

function ring(): CredentialKeyring {
  return CredentialKeyring.fromEnvironment({
    [CREDENTIAL_KEYRING_VAR]: JSON.stringify({
      active: 'current',
      keys: { current: base64urlEncode(new Uint8Array(32).fill(7)) },
    }),
  })!;
}

const APP_ID = '1234567';
const CLIENT_ID = 'Iv23liTestClientId';

async function seedIdentity(
  keyring: CredentialKeyring,
  pem: string,
  webhookSecret: string | null = 'a-webhook-secret',
): Promise<void> {
  await database()
    .db.insert(githubApp)
    .values({
      id: 1,
      appId: APP_ID,
      slug: 'spindrift-test',
      clientId: CLIENT_ID,
      encryptedPrivateKey: await keyring.seal(pem, 'spindrift-github-app-key'),
      encryptedWebhookSecret:
        webhookSecret === null
          ? null
          : await keyring.seal(
              webhookSecret,
              'spindrift-github-webhook-secret',
            ),
    });
}

function agent(
  fake: FakeGitHub,
  keyring: CredentialKeyring,
  now: () => Date,
  webhookUrl:
    | string
    | null = 'https://control.example.test/internal/github/webhook',
): GitHubAppAuth {
  return new GitHubAppAuth({
    db: database().db,
    clock: { now },
    keyring,
    env: {},
    apiBaseUrl: fake.baseUrl,
    webBaseUrl: 'https://git.example.test',
    controlPlaneHostname: 'spindrift.example.test',
    installationName: 'example',
    webhookUrl,
    fetch: fake.fetch,
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(padded));
}

describe('the App’s own JWT', () => {
  test('is signed by the sealed key and claims the client id', async () => {
    const keyring = ring();
    const { pem, publicKey } = await testAppKey();
    await seedIdentity(keyring, pem);
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const auth = agent(new FakeGitHub({ now }), keyring, now);

    const jwt = await auth.appJwt();
    const [header, claims, signature] = jwt.split('.');
    expect(decodeSegment(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = decodeSegment(claims ?? '');
    const issuedAt = Math.floor(now().getTime() / 1000);
    expect(payload.iss).toBe(CLIENT_ID);
    // Backdated by a minute: the documented remedy for a far side whose clock
    // runs behind this one, which it otherwise rejects outright.
    expect(payload.iat).toBe(issuedAt - 60);
    expect(payload.exp).toBeLessThanOrEqual(issuedAt + 600);

    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Uint8Array.from(
        atob((signature ?? '').replaceAll('-', '+').replaceAll('_', '/')),
        (character) => character.charCodeAt(0),
      ),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  test('accepts the PKCS#1 key GitHub actually hands out', async () => {
    // The conversion endpoint and the key generator emit `BEGIN RSA PRIVATE
    // KEY`. The predecessor refused it with an openssl incantation; that
    // ceremony is exactly the onboarding wart this module exists to remove.
    const keyring = ring();
    const { pem, publicKey } = await testAppKey('pkcs1');
    expect(pem).toContain('BEGIN RSA PRIVATE KEY');
    await seedIdentity(keyring, pem);
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const auth = agent(new FakeGitHub({ now }), keyring, now);

    const [header, claims, signature] = (await auth.appJwt()).split('.');
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Uint8Array.from(
        atob((signature ?? '').replaceAll('-', '+').replaceAll('_', '/')),
        (character) => character.charCodeAt(0),
      ),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  test('with no identity, minting refuses rather than guessing', async () => {
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const auth = agent(new FakeGitHub({ now }), ring(), now);
    await expect(auth.appJwt()).rejects.toBeInstanceOf(
      RepositoryAuthorizationRequiredError,
    );
    await expect(auth.status()).resolves.toEqual({ state: 'unauthorized' });
  });

  test('an App created mid-flight is visible with no reconstruction', async () => {
    // The C-3 property: the agent is built while the row is empty — exactly
    // the running pod the setup route writes into — and the very next mint
    // sees the identity.
    const keyring = ring();
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const auth = agent(new FakeGitHub({ now }), keyring, now);
    await expect(auth.status()).resolves.toEqual({ state: 'unauthorized' });

    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    await expect(auth.status()).resolves.toEqual({
      state: 'authorized',
      slug: 'spindrift-test',
      appId: APP_ID,
    });
    await expect(auth.appJwt()).resolves.toContain('.');
  });
});

describe('installation tokens', () => {
  test('are minted once and reused until they are close to expiring', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const fake = new FakeGitHub({ now });
    const auth = agent(fake, keyring, now);
    const ref = { installationId: fake.installationId };

    const first = await auth.authorization(ref);
    const second = await auth.authorization(ref);
    expect(first).toBe(second);
    expect(
      fake.requests.filter((request) =>
        request.path.includes('/access_tokens'),
      ),
    ).toHaveLength(1);
  });

  test('are re-minted once the cached one is inside the refresh margin', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    let clock = new Date('2026-08-13T12:00:00.000Z');
    const now = () => clock;
    const fake = new FakeGitHub({ now });
    const auth = agent(fake, keyring, now);
    const ref = { installationId: fake.installationId };

    await auth.authorization(ref);
    // The fake's tokens live an hour; four minutes short of expiry is inside
    // the five-minute margin. A token that expires mid-request is a `401`
    // that reads exactly like lost access — the one misclassification this
    // integration must not make.
    clock = new Date(clock.getTime() + 56 * 60 * 1000);
    await auth.authorization(ref);

    expect(
      fake.requests.filter((request) =>
        request.path.includes('/access_tokens'),
      ),
    ).toHaveLength(2);
  });

  test('a rejected token is dropped and re-minted once; twice is lost access', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const fake = new FakeGitHub({ now });

    // Stand a refusing layer in front of the fake: mints succeed, reads 401.
    let reads = 0;
    const refusing: Fetcher = async (request) => {
      if (new URL(request.url).pathname.includes('/access_tokens')) {
        return fake.fetch(request);
      }
      reads += 1;
      return new Response('{"message":"Bad credentials"}', { status: 401 });
    };

    const auth = new GitHubAppAuth({
      db: database().db,
      clock: { now },
      keyring,
      env: {},
      apiBaseUrl: fake.baseUrl,
      webBaseUrl: 'https://git.example.test',
      controlPlaneHostname: 'spindrift.example.test',
      installationName: 'example',
      webhookUrl: null,
      fetch: refusing,
    });
    const github = new GitHubApp({
      baseUrl: fake.baseUrl,
      authorization: (ref) => auth.authorization(ref),
      appAuthorization: () => auth.appAuthorization(),
      onUnauthorized: (ref, authorization) =>
        auth.rejectedAuthorization(ref, authorization),
      fetch: refusing,
    });

    const read = github.repository(
      { installationId: fake.installationId },
      fake.fullName,
    );
    await expect(read).rejects.toMatchObject({ code: 'ACCESS_LOST' });
    // One retry, exactly: the request was sent twice, and two tokens were
    // minted — the cached one was dropped rather than any durable credential.
    expect(reads).toBe(2);
    expect(
      fake.requests.filter((request) =>
        request.path.includes('/access_tokens'),
      ),
    ).toHaveLength(2);
  });
});

describe('the manifest-flow setup', () => {
  function conversionHost(options?: {
    webhookSecret?: string | null;
    status?: number;
  }): { fetch: Fetcher; conversions: string[] } {
    const conversions: string[] = [];
    return {
      conversions,
      fetch: async (request) => {
        const match = new URL(request.url).pathname.match(
          /^\/app-manifests\/([^/]+)\/conversions$/,
        );
        if (!match || request.method !== 'POST') {
          return new Response('{"message":"Not Found"}', { status: 404 });
        }
        conversions.push(match[1] ?? '');
        if (options?.status !== undefined) {
          return new Response('{"message":"refused"}', {
            status: options.status,
          });
        }
        const { pem } = await testAppKey('pkcs1');
        return Response.json(
          {
            id: 1234567,
            slug: 'spindrift-test',
            client_id: CLIENT_ID,
            pem,
            webhook_secret:
              options?.webhookSecret === undefined
                ? 'a-webhook-secret'
                : options.webhookSecret,
            client_secret: 'discarded-client-secret',
          },
          { status: 201 },
        );
      },
    };
  }

  function setupAgent(
    keyring: CredentialKeyring,
    fetch: Fetcher,
    now: () => Date = () => new Date('2026-08-13T12:00:00.000Z'),
  ): GitHubAppAuth {
    return new GitHubAppAuth({
      db: database().db,
      clock: { now },
      keyring,
      env: {},
      apiBaseUrl: 'https://api.git.example.test',
      webBaseUrl: 'https://git.example.test',
      controlPlaneHostname: 'spindrift.example.test',
      installationName: 'example',
      webhookUrl: 'https://control.example.test/internal/github/webhook',
      fetch,
    });
  }

  test('the form targets the create page and the manifest declares the design', async () => {
    const auth = setupAgent(ring(), conversionHost().fetch);
    const setup = await auth.setup('user-1');

    expect(setup.action).toStartWith(
      'https://git.example.test/settings/apps/new?state=',
    );
    const manifest = JSON.parse(setup.manifest);
    expect(manifest).toMatchObject({
      name: 'spindrift-example',
      public: true,
      redirect_url: 'https://spindrift.example.test/internal/github/setup',
      setup_url: 'https://spindrift.example.test/internal/github/setup',
      hook_attributes: {
        url: 'https://control.example.test/internal/github/webhook',
        active: true,
      },
      default_events: ['push'],
    });
    // The webhook URL is configuration — the tunnel hostname — never the
    // control plane's own LAN name, which GitHub's servers cannot reach.
    expect(manifest.hook_attributes.url).not.toContain(
      'spindrift.example.test',
    );
    // Administration is bosun's price of sharing the App; Packages is absent
    // because GHCR refuses App tokens and the permission would authorize
    // nothing.
    expect(manifest.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      actions: 'write',
      workflows: 'write',
      administration: 'write',
    });
    expect(setup.manifest).not.toContain('packages');
  });

  test('with no webhook URL configured the App declares no webhook', async () => {
    const keyring = ring();
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const fake = new FakeGitHub({ now });
    const auth = agent(fake, keyring, now, null);
    const manifest = JSON.parse((await auth.setup('user-1')).manifest);
    expect(manifest.hook_attributes).toBeUndefined();
  });

  test('converts the code, seals the key, and never renders it back', async () => {
    const keyring = ring();
    const host = conversionHost();
    const auth = setupAgent(keyring, host.fetch);
    const state = new URL((await auth.setup('user-1')).action).searchParams.get(
      'state',
    );

    const identity = await auth.convertManifestCode({
      code: 'temporary-code',
      state,
      userId: 'user-1',
    });
    expect(host.conversions).toEqual(['temporary-code']);
    expect(identity).toEqual({
      appId: '1234567',
      slug: 'spindrift-test',
      clientId: CLIENT_ID,
    });

    const [row] = await database().db.select().from(githubApp);
    expect(row?.encryptedPrivateKey).not.toContain('PRIVATE KEY');
    // The sealed webhook secret opens for the delivery route, and only there.
    await expect(githubAppWebhookSecret(database().db, keyring)).resolves.toBe(
      'a-webhook-secret',
    );
    // The client secret was discarded: nothing here makes user-to-server
    // calls, so nothing stores the credential for them.
    expect(JSON.stringify(row)).not.toContain('discarded-client-secret');
  });

  test('a null webhook_secret keeps the refuse-all-deliveries posture', async () => {
    const keyring = ring();
    const auth = setupAgent(
      keyring,
      conversionHost({ webhookSecret: null }).fetch,
    );
    const state = new URL((await auth.setup('user-1')).action).searchParams.get(
      'state',
    );

    await auth.convertManifestCode({
      code: 'temporary-code',
      state,
      userId: 'user-1',
    });
    // Setup succeeded — the identity exists and mints — but deliveries are
    // refused exactly as they are with no App at all, rather than a null
    // being sealed and later crashing signature verification.
    await expect(auth.status()).resolves.toMatchObject({
      state: 'authorized',
    });
    await expect(
      githubAppWebhookSecret(database().db, keyring),
    ).resolves.toBeNull();
  });

  test('refuses a conversion when an identity already exists', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    const host = conversionHost();
    const auth = setupAgent(keyring, host.fetch);
    const state = new URL((await auth.setup('user-1')).action).searchParams.get(
      'state',
    );

    const refused = auth.convertManifestCode({
      code: 'temporary-code',
      state,
      userId: 'user-1',
    });
    await expect(refused).rejects.toBeInstanceOf(GitHubAppSetupError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
    // Refused before the far side was ever asked: replacing the identity is a
    // deliberate act, not a side effect of resubmitting the create flow.
    expect(host.conversions).toEqual([]);
  });

  test('refuses a state another session minted, and a missing one', async () => {
    const auth = setupAgent(ring(), conversionHost().fetch);
    const state = new URL(
      (await auth.setup('somebody-else')).action,
    ).searchParams.get('state');

    await expect(
      auth.convertManifestCode({
        code: 'temporary-code',
        state,
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      auth.convertManifestCode({
        code: 'temporary-code',
        state: null,
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('refuses a state past its window', async () => {
    const keyring = ring();
    let clock = new Date('2026-08-13T12:00:00.000Z');
    const auth = setupAgent(keyring, conversionHost().fetch, () => clock);
    const state = new URL((await auth.setup('user-1')).action).searchParams.get(
      'state',
    );

    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    await expect(
      auth.convertManifestCode({
        code: 'temporary-code',
        state,
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('a failed conversion is reported, with the single-use fact', async () => {
    const auth = setupAgent(ring(), conversionHost({ status: 404 }).fetch);
    const state = new URL((await auth.setup('user-1')).action).searchParams.get(
      'state',
    );

    const failed = auth.convertManifestCode({
      code: 'stale-code',
      state,
      userId: 'user-1',
    });
    await expect(failed).rejects.toMatchObject({ status: 502 });
    await expect(failed).rejects.toThrow(/single-use/);
  });
});

describe('an adopted App, from the installation Secret', () => {
  async function adoptedAgent(options?: {
    keyring?: CredentialKeyring | null;
    now?: () => Date;
    fake?: FakeGitHub;
  }) {
    const now = options?.now ?? (() => new Date('2026-08-13T12:00:00.000Z'));
    const fake = options?.fake ?? new FakeGitHub({ now });
    const { pem, publicKey } = await testAppKey('pkcs1');
    const auth = new GitHubAppAuth({
      db: database().db,
      clock: { now },
      keyring: options?.keyring === undefined ? null : options.keyring,
      env: {
        SPINDRIFT_GITHUB_APP_ID: '4576122',
        SPINDRIFT_GITHUB_APP_PRIVATE_KEY: pem,
      },
      apiBaseUrl: fake.baseUrl,
      webBaseUrl: 'https://git.example.test',
      controlPlaneHostname: 'spindrift.example.test',
      installationName: 'example',
      appSlug: 'spindrift-bot',
      webhookUrl: null,
      fetch: fake.fetch,
    });
    return { auth, fake, publicKey };
  }

  test('works with no keyring and no row: the Secret is the whole identity', async () => {
    // The App was registered by hand, so there is no conversion response to
    // seal — the id and PKCS#1 key pasted into the installation Secret are
    // everything, and the slug is the manifest's public declaration.
    const { auth, fake, publicKey } = await adoptedAgent();

    await expect(auth.status()).resolves.toEqual({
      state: 'authorized',
      slug: 'spindrift-bot',
      appId: '4576122',
    });

    const [header, claims, signature] = (await auth.appJwt()).split('.');
    // An adopted identity has no client id, and the docs accept the app id
    // as the issuer.
    expect(decodeSegment(claims ?? '').iss).toBe('4576122');
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Uint8Array.from(
        atob((signature ?? '').replaceAll('-', '+').replaceAll('_', '/')),
        (character) => character.charCodeAt(0),
      ),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);

    // And it mints: the whole point of adopting is that tokens flow.
    await expect(
      auth.authorization({ installationId: fake.installationId }),
    ).resolves.toStartWith('Bearer ');
  });

  test('names its principal on a source receipt', async () => {
    // The receipt is written after the tarball is already in hand, so reading
    // the id from the row alone failed a staging fetch that had succeeded.
    const { auth, fake } = await adoptedAgent();

    await expect(
      auth.principalSubject({ installationId: fake.installationId }),
    ).resolves.toBe(`installation:${fake.installationId}/app:4576122`);
  });

  test('takes precedence over a sealed row', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem);
    const { auth } = await adoptedAgent({ keyring });

    await expect(auth.status()).resolves.toEqual({
      state: 'authorized',
      slug: 'spindrift-bot',
      appId: '4576122',
    });
  });

  test('refuses the manifest-flow conversion: there is nothing to store', async () => {
    const { auth } = await adoptedAgent({ keyring: ring() });
    const refused = auth.convertManifestCode({
      code: 'temporary-code',
      state: 'irrelevant',
      userId: 'user-1',
    });
    await expect(refused).rejects.toBeInstanceOf(GitHubAppSetupError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
  });

  test('half a pair is no identity at all', async () => {
    const now = () => new Date('2026-08-13T12:00:00.000Z');
    const auth = new GitHubAppAuth({
      db: database().db,
      clock: { now },
      keyring: null,
      env: { SPINDRIFT_GITHUB_APP_ID: '4576122' },
      apiBaseUrl: 'https://api.git.example.test',
      webBaseUrl: 'https://git.example.test',
      controlPlaneHostname: 'spindrift.example.test',
      installationName: 'example',
      webhookUrl: null,
    });
    await expect(auth.status()).resolves.toEqual({ state: 'unauthorized' });
  });
});

describe('the webhook secret, per delivery', () => {
  test('the installation Secret wins over the sealed row', async () => {
    const keyring = ring();
    const { pem } = await testAppKey();
    await seedIdentity(keyring, pem, 'sealed-secret');

    await expect(
      githubAppWebhookSecret(database().db, keyring, {
        SPINDRIFT_GITHUB_WEBHOOK_SECRET: 'pasted-secret',
      }),
    ).resolves.toBe('pasted-secret');
    await expect(
      githubAppWebhookSecret(database().db, keyring, {}),
    ).resolves.toBe('sealed-secret');
  });

  test('nothing anywhere is the refuse-all posture, keyring or not', async () => {
    await expect(
      githubAppWebhookSecret(database().db, null, {}),
    ).resolves.toBeNull();
    await expect(
      githubAppWebhookSecret(database().db, ring(), {}),
    ).resolves.toBeNull();
  });
});
