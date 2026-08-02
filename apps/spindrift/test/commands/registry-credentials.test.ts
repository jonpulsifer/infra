/**
 * Holding a registry push credential (§13's named exception, §16).
 *
 * Three properties, and each one is a way this could go quietly wrong.
 *
 * **The token is proved before it is kept.** Unlike the bucket and the bare
 * registry check, this one can be strong — a credential in hand can complete
 * the registry's own challenge — so a wrong token is a sentence on the form
 * rather than an `unauthorized` at the last step of a green build.
 *
 * **The token is never readable.** Nothing above `RegistryCredentialStore` has
 * a verb that returns one, and the row holds an envelope. The plaintext grep
 * here is the same discipline `config.test.ts` applies to config values, for
 * the same reason: a future shortcut that kept one has somewhere to fail.
 *
 * **The hosted route cannot carry one.** Its dispatch inputs are rendered in
 * the GitHub run header, so a credential in the spec would be published to
 * anyone who can see the run. `dispatchBuild` refuses before the claim.
 */
import { describe, expect, test } from 'bun:test';
import { forgetRegistryCredential } from '../../src/commands/storage/forget-registry-credential.ts';
import { listArtifactRegistries } from '../../src/commands/storage/list-registries.ts';
import { setRegistryCredential } from '../../src/commands/storage/set-registry-credential.ts';
import { testRegistryReachability } from '../../src/commands/storage/test-registry.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { CredentialKeyring } from '../../src/crypto/credential-envelope.ts';
import { registryCredentialStore } from '../../src/storage/registry-credentials.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-08-02T12:00:00.000Z');
const TOKEN = 'a-token-nobody-should-be-able-to-read-back';
const HOST = 'registry.example.test';
const DECLARED = `${HOST}/artifacts`;

/** A keyring, the way an installation Secret supplies one. */
function keyring(): CredentialKeyring {
  const key = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
  const parsed = CredentialKeyring.fromEnvironment({
    SPINDRIFT_CREDENTIAL_KEYRING: JSON.stringify({
      active: 'k1',
      keys: { k1: key },
    }),
  });
  if (parsed === null) throw new Error('the test keyring did not parse');
  return parsed;
}

/**
 * A registry that speaks the distribution token flow.
 *
 * Three hops, because that is what a real one does and a fake that collapsed
 * them would pass an implementation that only ever tries Basic: `/v2/` answers
 * `401` with a Bearer challenge, the realm mints a token for the right
 * password, and `/v2/` accepts that token.
 */
function tokenRegistry(accepts: string) {
  const asked: string[] = [];
  const send = async (request: Request): Promise<Response> => {
    asked.push(request.url);
    const auth = request.headers.get('authorization') ?? '';

    if (request.url.includes('/token')) {
      const [, encoded = ''] = auth.split(' ');
      const [, password] = Buffer.from(encoded, 'base64').toString().split(':');
      return password === accepts
        ? Response.json({ token: 'a-minted-token' })
        : new Response('', { status: 401 });
    }

    if (auth === 'Bearer a-minted-token') return Response.json({});
    return new Response('', {
      status: 401,
      headers: {
        'www-authenticate': `Bearer realm="https://${HOST}/token",service="${HOST}"`,
      },
    });
  };
  return { send, asked };
}

async function context(
  accepts = TOKEN,
): Promise<{ ctx: CommandContext; asked: string[] }> {
  const registry = tokenRegistry(accepts);
  const store = registryCredentialStore(database().db, keyring(), () => NOW);
  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: () => null,
    store: () => null,
    repository: () => null,
    registryTransport: () => registry.send,
    registryCredentials: () => store,
    supplyChain: () => {
      throw new Error('a registry credential reached the supply chain');
    },
  };

  return {
    asked: registry.asked,
    ctx: {
      principal: { id: 'user-1', displayName: 'Operator' },
      clock: { now: () => NOW },
      db: database().db,
      adapters,
      manifest: await fixtureManifest(),
    },
  };
}

describe('setting a registry credential', () => {
  test('completes the registry’s challenge, then keeps it', async () => {
    const { ctx, asked } = await context();
    const result = await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host).toBe(HOST);
    expect(result.value.probe.authenticated).toBe(true);
    // The token endpoint was actually visited: a Basic-only implementation
    // would have skipped it and reported a correct Docker Hub token as wrong.
    expect(asked.some((url) => url.includes('/token'))).toBe(true);
  });

  test('writes nothing when the registry refuses the token', async () => {
    const { ctx } = await context('a-different-token');
    const result = await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');

    const listed = await listArtifactRegistries({}, ctx);
    expect(listed.ok && listed.value.registries[0]?.credentialUsername).toBe(
      null,
    );
  });

  test('takes a bare host as readily as a namespace', async () => {
    const { ctx } = await context();
    const result = await setRegistryCredential(
      { registry: HOST, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    expect(result.ok && result.value.host).toBe(HOST);
  });

  test('refuses when there is no keyring to seal it with', async () => {
    const { ctx } = await context();
    const result = await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      {
        ...ctx,
        adapters: { ...ctx.adapters, registryCredentials: () => null },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('keyring');
  });
});

describe('what a listing may know about it', () => {
  test('the username and when, never the token', async () => {
    const { ctx } = await context();
    await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    const listed = await listArtifactRegistries({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.canHoldCredentials).toBe(true);
    expect(listed.value.registries[0]).toMatchObject({
      host: HOST,
      credentialUsername: 'an-owner',
    });
    expect(JSON.stringify(listed.value)).not.toContain(TOKEN);
  });

  /**
   * The same search `config.test.ts` runs over every column after a set. A
   * credential is sealed or it is not, and the database is where that is
   * proved rather than asserted.
   */
  test('and no column of any table holds the plaintext', async () => {
    const { ctx } = await context();
    await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    const tables = await ctx.db.execute<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'`,
    );
    let searched = 0;
    for (const { table_name: table } of tables) {
      const rows = await ctx.db.execute<Record<string, unknown>>(
        `select * from "${table}"`,
      );
      for (const row of rows) {
        searched += 1;
        expect(JSON.stringify(row)).not.toContain(TOKEN);
      }
    }
    // A grep that searched nothing proves nothing.
    expect(searched).toBeGreaterThan(0);
  });
});

describe('verifying a registry that has one', () => {
  test('exercises the stored credential rather than asking anonymously', async () => {
    const { ctx } = await context();
    await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    const result = await testRegistryReachability({ namespace: DECLARED }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authenticated).toBe(true);
    expect(result.value.detail).toContain('an-owner');
  });

  test('and says nobody tried where none is held', async () => {
    const { ctx } = await context();
    const result = await testRegistryReachability({ namespace: DECLARED }, ctx);

    expect(result.ok && result.value.authenticated).toBe(null);
  });
});

describe('forgetting one', () => {
  test('removes it and says what it did not do', async () => {
    const { ctx } = await context();
    await setRegistryCredential(
      { registry: DECLARED, username: 'an-owner', secret: TOKEN },
      ctx,
    );

    const result = await forgetRegistryCredential({ registry: DECLARED }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.forgotten).toBe(true);
    // Forgetting is not revoking, and the sentence has to say so.
    expect(result.value.detail).toContain('revoke');

    const listed = await listArtifactRegistries({}, ctx);
    expect(listed.ok && listed.value.registries[0]?.credentialUsername).toBe(
      null,
    );
  });

  test('says so when there was nothing held', async () => {
    const { ctx } = await context();
    const result = await forgetRegistryCredential({ registry: DECLARED }, ctx);

    expect(result.ok && result.value.forgotten).toBe(false);
  });
});
