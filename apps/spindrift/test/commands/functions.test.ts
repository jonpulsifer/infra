/**
 * `listFunctions`, `getFunction`, `saveFunction`, `runFunction`,
 * `deleteFunction` (`functions/contract.ts`).
 *
 * `saveFunction` is the interesting one: it always saves, and only refuses
 * when the installation has no deployer at all for the requested target — a
 * deploy that reaches the far side and fails still lands as `ok`, with the
 * failure written onto the row's `error` column, because a Save that could
 * not go live still saved. The one refusal that comes *before* the write is an
 * environment with nowhere to be sealed: values are never stored in clear.
 *
 * The environment tests read the row's own `env` column, because "write-only"
 * is a claim about storage as much as about the wire — a plaintext value in
 * Postgres would satisfy every command-level assertion here.
 */

import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '@repo/archive/bytes';
import { eq } from 'drizzle-orm';
import { dispatch } from '../../src/commands/registry.ts';
import type { Clock, CommandContext } from '../../src/commands/types.ts';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialKeyring,
} from '../../src/crypto/credential-envelope.ts';
import { functions } from '../../src/db/schema.ts';
import {
  FunctionDeployError,
  type FunctionDeployer,
  type FunctionDeployers,
  type FunctionEnv,
  type FunctionTarget,
} from '../../src/functions/contract.ts';
import { functionEnvSealer } from '../../src/functions/env.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const resolved = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

interface FunctionDetailShape {
  readonly name: string;
  readonly source: string;
  readonly envKeys: readonly string[];
}

interface RecordedDeployer extends FunctionDeployer {
  readonly deployCalls: {
    readonly name: string;
    readonly source: string;
    readonly env: FunctionEnv;
  }[];
  readonly removeCalls: string[];
}

/** A keyring, the way an installation Secret supplies one. */
function keyring(): CredentialKeyring {
  const parsed = CredentialKeyring.fromEnvironment({
    [CREDENTIAL_KEYRING_VAR]: JSON.stringify({
      active: 'k1',
      keys: { k1: base64urlEncode(new Uint8Array(32).fill(11)) },
    }),
  });
  if (parsed === null) throw new Error('the test keyring did not parse');
  return parsed;
}

function fakeDeployer(
  target: FunctionTarget,
  options: {
    readonly deploy?: () => Promise<{ readonly url: string }>;
    readonly remove?: () => Promise<void>;
  } = {},
): RecordedDeployer {
  const deployCalls: { name: string; source: string; env: FunctionEnv }[] = [];
  const removeCalls: string[] = [];
  return {
    target,
    deployCalls,
    removeCalls,
    async deploy(name, source, env) {
      deployCalls.push({ name, source, env });
      return options.deploy
        ? options.deploy()
        : { url: `https://${name}.fn.example.test` };
    },
    async remove(name) {
      removeCalls.push(name);
      if (options.remove) await options.remove();
    },
    async *tail() {},
  };
}

/**
 * An installation with a keyring, or — with `sealed` false — one without,
 * which is what a Save carrying values has to be refused by.
 */
function context(
  deployers: FunctionDeployers | null = null,
  sealed = true,
): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    manifest: resolved,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => {
        throw new Error('a Function command reached the store');
      },
      repository: () => null,
      supplyChain: () => {
        throw new Error('a Function command reached the supply chain');
      },
      functions: () => deployers,
      functionEnv: () => (sealed ? functionEnvSealer(keyring()) : null),
    } as unknown as CommandContext['adapters'],
  };
}

async function row(name: string) {
  const [found] = await database()
    .db.select()
    .from(functions)
    .where(eq(functions.name, name));
  return found;
}

describe('saveFunction', () => {
  test('inserts, deploys, and stores the URL', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'export default { fetch: () => new Response("hi") }',
      },
      context({ 'cloudflare-workers': workers, 'cloud-run-functions': null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = result.value as { function: { url: string | null } };
    expect(saved.function.url).toBe('https://hello.fn.example.test');
    expect(workers.deployCalls).toHaveLength(1);
    expect(workers.deployCalls[0]?.name).toBe('hello');

    const stored = await row('hello');
    expect(stored?.url).toBe('https://hello.fn.example.test');
    expect(stored?.error).toBeNull();
  });

  test('saving again updates the source and redeploys', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v1' },
      context(deployers),
    );
    await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v2' },
      context(deployers),
    );

    expect(workers.deployCalls).toHaveLength(2);
    expect(workers.deployCalls[1]?.source).toBe('v2');
    const stored = await row('hello');
    expect(stored?.source).toBe('v2');
  });

  test('a target with no deployer refuses NOT_DEPLOYABLE and keeps the row', async () => {
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloud-run-functions',
        source: 'export default { fetch: () => new Response("hi") }',
      },
      context({ 'cloudflare-workers': null, 'cloud-run-functions': null }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');

    const stored = await row('hello');
    expect(stored).toBeDefined();
    expect(stored?.source).toBe(
      'export default { fetch: () => new Response("hi") }',
    );
  });

  test('a deploy that throws still answers ok, with the error on the row', async () => {
    const workers = fakeDeployer('cloudflare-workers', {
      deploy: async () => {
        throw new FunctionDeployError('the account has no Workers entitlement');
      },
    });
    const result = await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v1' },
      context({ 'cloudflare-workers': workers, 'cloud-run-functions': null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = result.value as {
      function: { url: string | null; error: string | null };
    };
    expect(saved.function.url).toBeNull();
    expect(saved.function.error).toBe('the account has no Workers entitlement');

    const stored = await row('hello');
    expect(stored?.url).toBeNull();
    expect(stored?.error).toBe('the account has no Workers entitlement');
  });

  test('switching target removes from the old deployer before deploying the new one', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const cloudRun = fakeDeployer('cloud-run-functions');
    await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v1' },
      context({
        'cloudflare-workers': workers,
        'cloud-run-functions': cloudRun,
      }),
    );

    const result = await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloud-run-functions', source: 'v2' },
      context({
        'cloudflare-workers': workers,
        'cloud-run-functions': cloudRun,
      }),
    );

    expect(result.ok).toBe(true);
    expect(workers.removeCalls).toEqual(['hello']);
    expect(cloudRun.deployCalls).toHaveLength(1);
    expect(cloudRun.deployCalls[0]?.source).toBe('v2');

    const stored = await row('hello');
    expect(stored?.target).toBe('cloud-run-functions');
  });
});

describe('saveFunction environment', () => {
  test('hands the map to the deploy and keeps only an envelope on the row', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { API_TOKEN: 'sekrit' },
      },
      context({ 'cloudflare-workers': workers, 'cloud-run-functions': null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(workers.deployCalls[0]?.env).toEqual({ API_TOKEN: 'sekrit' });
    expect(
      (result.value as { function: { envKeys: string[] } }).function.envKeys,
    ).toEqual(['API_TOKEN']);

    const stored = await row('hello');
    expect(stored?.env).toBeString();
    expect(stored?.env).not.toContain('sekrit');
    expect(JSON.parse(stored?.env ?? 'null')).toMatchObject({
      version: 1,
      keyId: 'k1',
    });
  });

  test('getFunction answers with the names and never the values', async () => {
    const deployers = {
      'cloudflare-workers': fakeDeployer('cloudflare-workers'),
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { B: 'b', A: 'a' },
      },
      context(deployers),
    );

    const got = await dispatch(
      'getFunction',
      { name: 'hello' },
      context(deployers),
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const { function: detail } = got.value as { function: FunctionDetailShape };
    expect(detail.envKeys).toEqual(['A', 'B']);
    expect(JSON.stringify(detail)).not.toContain('"a"');
  });

  test('a later Save deletes what it nulls and keeps what it omits', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { A: 'a', B: 'b' },
      },
      context(deployers),
    );
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v2',
        env: { B: null, C: 'c' },
      },
      context(deployers),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(workers.deployCalls[1]?.env).toEqual({ A: 'a', C: 'c' });
    expect(
      (result.value as { function: { envKeys: string[] } }).function.envKeys,
    ).toEqual(['A', 'C']);
  });

  test('emptying the environment clears the envelope', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { A: 'a' },
      },
      context(deployers),
    );
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { A: null },
      },
      context(deployers),
    );

    expect(workers.deployCalls[1]?.env).toEqual({});
    expect((await row('hello'))?.env).toBeNull();
  });

  test('no keyring refuses NOT_DEPLOYABLE before anything is written', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { API_TOKEN: 'sekrit' },
      },
      context(
        { 'cloudflare-workers': workers, 'cloud-run-functions': null },
        false,
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain(CREDENTIAL_KEYRING_VAR);
    expect(await row('hello')).toBeUndefined();
    expect(workers.deployCalls).toHaveLength(0);
  });

  test('a saved environment nobody can open refuses an unrelated edit too', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { API_TOKEN: 'sekrit' },
      },
      context({ 'cloudflare-workers': workers, 'cloud-run-functions': null }),
    );
    const before = await row('hello');
    expect(before?.env).not.toBeNull();

    const result = await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v2' },
      context(
        { 'cloudflare-workers': workers, 'cloud-run-functions': null },
        false,
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    const after = await row('hello');
    expect(after?.env).toBe(before?.env ?? null);
    expect(after?.source).toBe('v1');
    expect(workers.deployCalls).toHaveLength(1);
  });
});

describe('listFunctions and getFunction', () => {
  test('list and get answer the same shape, ordered by name', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      { name: 'zeta', target: 'cloudflare-workers', source: 'z' },
      context(deployers),
    );
    await dispatch(
      'saveFunction',
      { name: 'alpha', target: 'cloudflare-workers', source: 'a' },
      context(deployers),
    );

    const listed = await dispatch('listFunctions', {}, context(deployers));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { functions: list } = listed.value as {
      functions: { name: string }[];
    };
    expect(list.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);

    const got = await dispatch(
      'getFunction',
      { name: 'alpha' },
      context(deployers),
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const { function: detail } = got.value as {
      function: { name: string; source: string };
    };
    expect(detail.name).toBe('alpha');
    expect(detail.source).toBe('a');
  });

  test('getFunction refuses NOT_FOUND for an absent name', async () => {
    const result = await dispatch(
      'getFunction',
      { name: 'nothing-here' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('deleteFunction', () => {
  test('removes from the deployer, then the row', async () => {
    const workers = fakeDeployer('cloudflare-workers');
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v1' },
      context(deployers),
    );

    const result = await dispatch(
      'deleteFunction',
      { name: 'hello' },
      context(deployers),
    );

    expect(result.ok).toBe(true);
    expect(workers.removeCalls).toEqual(['hello']);
    expect(await row('hello')).toBeUndefined();
  });

  test('a remove that throws refuses NOT_REMOVABLE and keeps the row', async () => {
    const workers = fakeDeployer('cloudflare-workers', {
      remove: async () => {
        throw new Error('the script is still bound to a route');
      },
    });
    const deployers = {
      'cloudflare-workers': workers,
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloudflare-workers', source: 'v1' },
      context(deployers),
    );

    const result = await dispatch(
      'deleteFunction',
      { name: 'hello' },
      context(deployers),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_REMOVABLE');
    expect(await row('hello')).toBeDefined();
  });

  test('deleteFunction refuses NOT_FOUND for an absent name', async () => {
    const result = await dispatch(
      'deleteFunction',
      { name: 'nothing-here' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('probeFunction', () => {
  test('a row with no url reads as not deployed', async () => {
    const result = await dispatch(
      'saveFunction',
      { name: 'hello', target: 'cloud-run-functions', source: 'v1' },
      context({ 'cloudflare-workers': null, 'cloud-run-functions': null }),
    );
    expect(result.ok).toBe(false); // no deployer — the row saves with no url

    const probed = await dispatch(
      'probeFunction',
      { name: 'hello' },
      context(),
    );
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.value).toEqual({
      ready: false,
      detail: 'not deployed',
      checkedAt: FROZEN.toISOString(),
    });
  });

  test('probeFunction refuses NOT_FOUND for an absent name', async () => {
    const result = await dispatch(
      'probeFunction',
      { name: 'nothing-here' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('runFunction', () => {
  test('a named function previews with its saved environment', async () => {
    const deployers = {
      'cloudflare-workers': fakeDeployer('cloudflare-workers'),
      'cloud-run-functions': null,
    };
    await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'v1',
        env: { GREETING: 'bonjour' },
      },
      context(deployers),
    );

    const result = await dispatch(
      'runFunction',
      {
        name: 'hello',
        source:
          'export default { fetch: (request, env) => new Response(env.GREETING) }',
        request: { method: 'GET', path: '/' },
      },
      context(deployers),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { body: string }).body).toBe('bonjour');
  });

  test('previews a handler with no row and no adapter', async () => {
    const result = await dispatch(
      'runFunction',
      {
        source: 'export default { fetch: () => Response.json({ ok: true }) }',
        request: { method: 'GET', path: '/' },
      },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = result.value as { ok: boolean; status: number | null };
    expect(preview.ok).toBe(true);
    expect(preview.status).toBe(200);
  });
});

describe('input validation', () => {
  test('a variable name a handler could not read is INVALID_INPUT', async () => {
    const result = await dispatch(
      'saveFunction',
      {
        name: 'hello',
        target: 'cloudflare-workers',
        source: 'x',
        env: { 'not a name': 'v' },
      },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
  });

  test('an invalid name is INVALID_INPUT', async () => {
    const result = await dispatch(
      'saveFunction',
      { name: 'Not A Valid Name', target: 'cloudflare-workers', source: 'x' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
  });

  test('the name the create route spends is INVALID_INPUT', async () => {
    const result = await dispatch(
      'saveFunction',
      { name: 'new', target: 'cloudflare-workers', source: 'x' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
  });
});
