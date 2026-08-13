/**
 * The route GitHub's create and install flows land on (§15).
 *
 * Two legs, one path, and the discipline under test is which callback is
 * believed: the `code=` leg carries a `state` checked against the acting
 * session and is the one leg whose parameters mean anything; the
 * `installation_id=` leg is distrusted wholesale — the docs say not to rely
 * on the parameter — and answers by sending the operator back to the screen
 * that re-enumerates through the App JWT. Every answer is `no-store`,
 * because the exchange upstream of this route is the only place the App's
 * key ever exists as plaintext outside GitHub.
 */
import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '../../src/auth/bytes.ts';
import type { RequestAuthentication } from '../../src/auth/types.ts';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialKeyring,
} from '../../src/crypto/credential-envelope.ts';
import { githubApp } from '../../src/db/schema.ts';
import { GitHubAppAuth } from '../../src/integrations/github/app-auth.ts';
import type { Fetcher } from '../../src/integrations/github/http.ts';
import {
  GITHUB_SETUP_PATH,
  githubSetupRoutes,
} from '../../src/web/github-setup-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { testAppKey } from '../harness/fakes/github-api.ts';

const database = withIsolatedDatabase();

const OPERATOR = { id: 'user-1', displayName: 'Operator' };

function keyring(): CredentialKeyring {
  return CredentialKeyring.fromEnvironment({
    [CREDENTIAL_KEYRING_VAR]: JSON.stringify({
      active: 'current',
      keys: { current: base64urlEncode(new Uint8Array(32).fill(7)) },
    }),
  })!;
}

/** The far side: only the conversion endpoint, answering the design's shape. */
const conversionHost: Fetcher = async (request) => {
  if (!new URL(request.url).pathname.startsWith('/app-manifests/')) {
    return new Response('{"message":"Not Found"}', { status: 404 });
  }
  const { pem } = await testAppKey('pkcs1');
  return Response.json(
    {
      id: 1234567,
      slug: 'spindrift-test',
      client_id: 'Iv23liTestClientId',
      pem,
      webhook_secret: 'a-webhook-secret',
    },
    { status: 201 },
  );
};

function serve(
  options: { authenticated?: boolean; ring?: CredentialKeyring | null } = {},
) {
  const ring = options.ring === undefined ? keyring() : options.ring;
  const auth =
    ring === null
      ? null
      : new GitHubAppAuth({
          db: database().db,
          clock: { now: () => new Date('2026-08-13T12:00:00.000Z') },
          keyring: ring,
          env: {},
          apiBaseUrl: 'https://api.git.example.test',
          webBaseUrl: 'https://git.example.test',
          controlPlaneHostname: 'spindrift.example.test',
          installationName: 'example',
          webhookUrl: null,
          fetch: conversionHost,
        });
  const routes = githubSetupRoutes({
    authenticate: async (): Promise<RequestAuthentication> =>
      options.authenticated === false
        ? { kind: 'anonymous' }
        : { kind: 'authenticated', principal: OPERATOR },
    auth: async () => auth,
  });
  return {
    auth,
    land: (query: string) =>
      routes[GITHUB_SETUP_PATH]!(
        new Request(
          `https://spindrift.example.test${GITHUB_SETUP_PATH}${query}`,
        ),
      ),
  };
}

describe('the setup landing', () => {
  test('needs the session that started the flow', async () => {
    const { land } = serve({ authenticated: false });
    const response = await land('?code=abc');
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('the code leg converts, stores the identity, and returns to /repos', async () => {
    const { auth, land } = serve();
    const state = new URL(
      (await auth!.setup(OPERATOR.id)).action,
    ).searchParams.get('state');

    const response = await land(
      `?code=temporary-code&state=${encodeURIComponent(state ?? '')}`,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/repos');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const [row] = await database().db.select().from(githubApp);
    expect(row?.slug).toBe('spindrift-test');
    // Sealed, never plaintext: the response above carried nothing either.
    expect(row?.encryptedPrivateKey).not.toContain('PRIVATE KEY');
  });

  test('a second conversion is refused: replacing the identity is deliberate', async () => {
    const { auth, land } = serve();
    const state = new URL(
      (await auth!.setup(OPERATOR.id)).action,
    ).searchParams.get('state');
    const query = `?code=temporary-code&state=${encodeURIComponent(state ?? '')}`;

    expect((await land(query)).status).toBe(303);
    const again = await land(query);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('deliberate act');
  });

  test('the install callback is a pure refresh signal — nothing is believed', async () => {
    const { land } = serve({ ring: null });
    // Even with no keyring at all: the parameter is not trusted, so there is
    // nothing this leg needs the App identity for.
    const response = await land('?installation_id=99999');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/repos');
  });

  test('neither leg is a 400, and a POST is not how GitHub arrives', async () => {
    const { land } = serve();
    expect((await land('')).status).toBe(400);
  });
});
