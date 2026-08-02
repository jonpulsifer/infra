/**
 * Declaring where artifacts are pushed (§16, §20).
 *
 * The same check-then-write order `source-buckets.test.ts` asserts, over a
 * weaker check — and the weakness is the thing most of this file pins down. A
 * bucket is verified *writable* with the identity that would write to it. A
 * registry has no such identity here: §13 leaves every push authorized by the
 * build route that makes it. So a registry that answers `401` is **reachable**,
 * and a check that called that a failure would refuse every private registry an
 * installation actually uses.
 *
 * The other half is order. `registry[0]` is what a Target with no declared
 * `reachableRegistries` pulls from, so moving the first entry is a real act and
 * not a cosmetic reorder.
 */
import { describe, expect, test } from 'bun:test';
import { listArtifactRegistries } from '../../src/commands/storage/list-registries.ts';
import { testRegistryReachability } from '../../src/commands/storage/test-registry.ts';
import { useArtifactRegistry } from '../../src/commands/storage/use-registry.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  readStoredManifest,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-08-02T12:00:00.000Z');

/** What the fixture manifest declares, so the assertions do not restate it. */
const DECLARED = 'registry.example.test/artifacts';

/**
 * A registry far side that answers `GET /v2/` with one status.
 *
 * It records the URL it was asked for, because the whole of the Docker Hub
 * alias lives in that string: a probe that asked the namespace's host as
 * written would ask the wrong one.
 */
function registryAnswering(status: number) {
  const asked: string[] = [];
  const send = async (request: Request): Promise<Response> => {
    asked.push(request.url);
    return status === 200
      ? Response.json({})
      : new Response('', {
          status,
          headers:
            status === 401 ? { 'www-authenticate': 'Bearer realm="x"' } : {},
        });
  };
  return { send, asked };
}

async function context(
  status = 200,
): Promise<{ ctx: CommandContext; asked: string[] }> {
  const manifest = await fixtureManifest();
  const registry = registryAnswering(status);
  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: () => null,
    store: () => null,
    repository: () => null,
    registryTransport: () => registry.send,
    supplyChain: () => {
      throw new Error('declaring a registry reached the supply chain');
    },
  };

  await writeStoredManifest(database().db, await authoredFixture());

  return {
    asked: registry.asked,
    ctx: {
      principal: { id: 'user-1', displayName: 'Operator' },
      clock: { now: () => NOW },
      db: database().db,
      adapters,
      manifest,
    },
  };
}

async function storedRegistries() {
  return (await readStoredManifest(database().db))?.supplyChain.registry;
}

describe('listing the registries', () => {
  test('says which one an unqualified Target pulls from', async () => {
    const { ctx } = await context();
    const result = await listArtifactRegistries({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registries).toEqual([
      {
        namespace: DECLARED,
        host: 'registry.example.test',
        flavour: 'other',
        first: true,
      },
    ]);
  });
});

describe('probing a registry', () => {
  test('an anonymous answer is reachable', async () => {
    const { ctx } = await context(200);
    const result = await testRegistryReachability({ namespace: DECLARED }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answers).toBe(true);
    expect(result.value.requiresAuth).toBe(false);
  });

  /** The one that matters: a private registry must not read as broken. */
  test('a challenge is reachable and closed, not unreachable', async () => {
    const { ctx } = await context(401);
    const result = await testRegistryReachability({ namespace: DECLARED }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answers).toBe(true);
    expect(result.value.requiresAuth).toBe(true);
  });

  test('anything that is not the distribution API is not reachable', async () => {
    const { ctx } = await context(404);
    const result = await testRegistryReachability({ namespace: DECLARED }, ctx);

    expect(result.ok && result.value.answers).toBe(false);
  });

  test('asks Docker Hub at the registry rather than at the index', async () => {
    const { ctx, asked } = await context(401);
    const result = await testRegistryReachability(
      { namespace: 'docker.io/an-owner' },
      ctx,
    );

    expect(result.ok && result.value.flavour).toBe('dockerHub');
    expect(asked).toEqual(['https://registry-1.docker.io/v2/']);
  });

  test('refuses a namespace that is not one, before asking anybody', async () => {
    const { ctx, asked } = await context(200);
    const result = await testRegistryReachability(
      { namespace: 'registry.example.test' },
      ctx,
    );

    expect(result.ok && result.value.answers).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('declaring a registry', () => {
  test('checks it, then declares it, keeping the order it found', async () => {
    const { ctx } = await context();
    const result = await useArtifactRegistry(
      { namespace: 'ghcr.io/an-owner', makeFirst: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registries).toEqual([DECLARED, 'ghcr.io/an-owner']);
    expect(await storedRegistries()).toEqual([DECLARED, 'ghcr.io/an-owner']);
  });

  test('makes it first when asked, in the same act', async () => {
    const { ctx } = await context();
    await useArtifactRegistry(
      { namespace: 'ghcr.io/an-owner', makeFirst: true },
      ctx,
    );

    expect(await storedRegistries()).toEqual(['ghcr.io/an-owner', DECLARED]);
  });

  test('moves the tie-break onto one already declared, without duplicating it', async () => {
    const { ctx } = await context();
    await useArtifactRegistry(
      { namespace: 'ghcr.io/an-owner', makeFirst: true },
      ctx,
    );
    await useArtifactRegistry({ namespace: DECLARED, makeFirst: true }, ctx);

    expect(await storedRegistries()).toEqual([DECLARED, 'ghcr.io/an-owner']);
  });

  test('declaring the same namespace twice adds nothing', async () => {
    const { ctx } = await context();
    await useArtifactRegistry({ namespace: DECLARED, makeFirst: false }, ctx);

    expect(await storedRegistries()).toEqual([DECLARED]);
  });

  test('writes nothing when the registry does not answer', async () => {
    const { ctx } = await context(500);
    const result = await useArtifactRegistry(
      { namespace: 'ghcr.io/an-owner', makeFirst: true },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('ghcr.io/an-owner');
    // The whole point: a refused check leaves the manifest as it was.
    expect(await storedRegistries()).toEqual([DECLARED]);
  });

  test('writes nothing for a namespace no registry would accept', async () => {
    const { ctx } = await context();
    const result = await useArtifactRegistry(
      { namespace: 'ghcr.io/An-Owner', makeFirst: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(await storedRegistries()).toEqual([DECLARED]);
  });

  test('refuses when there is no transport to ask with', async () => {
    const { ctx } = await context();
    const result = await useArtifactRegistry(
      { namespace: 'ghcr.io/an-owner', makeFirst: false },
      { ...ctx, adapters: { ...ctx.adapters, registryTransport: () => null } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('transport');
  });
});
