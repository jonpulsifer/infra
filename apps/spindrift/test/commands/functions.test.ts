/**
 * `listFunctions`, `getFunction`, `saveFunction`, `runFunction`,
 * `deleteFunction` (`functions/contract.ts`).
 *
 * `saveFunction` is the interesting one: it always saves, and only refuses
 * when the installation has no deployer at all for the requested target — a
 * deploy that reaches the far side and fails still lands as `ok`, with the
 * failure written onto the row's `error` column, because a Save that could
 * not go live still saved.
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dispatch } from '../../src/commands/registry.ts';
import type { Clock, CommandContext } from '../../src/commands/types.ts';
import { functions } from '../../src/db/schema.ts';
import {
  FunctionDeployError,
  type FunctionDeployer,
  type FunctionDeployers,
  type FunctionTarget,
} from '../../src/functions/contract.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const resolved = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

interface RecordedDeployer extends FunctionDeployer {
  readonly deployCalls: { readonly name: string; readonly source: string }[];
  readonly removeCalls: string[];
}

function fakeDeployer(
  target: FunctionTarget,
  options: {
    readonly deploy?: () => Promise<{ readonly url: string }>;
    readonly remove?: () => Promise<void>;
  } = {},
): RecordedDeployer {
  const deployCalls: { name: string; source: string }[] = [];
  const removeCalls: string[] = [];
  return {
    target,
    deployCalls,
    removeCalls,
    async deploy(name, source) {
      deployCalls.push({ name, source });
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

function context(deployers: FunctionDeployers | null = null): CommandContext {
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

describe('runFunction', () => {
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
