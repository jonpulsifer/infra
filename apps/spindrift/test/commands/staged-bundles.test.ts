/**
 * The bundles an installation has staged (§4, §15).
 *
 * Two derivations carry the whole listing and both are easy to get subtly
 * wrong, which is why they are asserted rather than read.
 *
 * **`deployable` is what happened, not what was declared.** §4's supplied
 * artifact is an archive of finished output that no route ever ran over, and
 * the durable evidence of that is a `SUCCEEDED` Build with no runner. Reading
 * the App's declared archive contents instead would call a bundle deployable on
 * the strength of a claim made before anything was staged.
 *
 * **`retention` follows the source kind**, per `source-bundle.ts`: an upload is
 * durable and a repository fetch is ephemeral. It is what decides whether the
 * location under a row still resolves.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { listStagedBundles } from '../../src/commands/storage/list-bundles.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, builds, components } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-08-02T12:00:00.000Z');

const adapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => {
    throw new Error('listing bundles reached the supply chain');
  },
};

const digest = (byte: string) => `sha256:${byte.repeat(64)}`;

async function context(): Promise<CommandContext> {
  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => NOW },
    db: database().db,
    adapters,
    manifest: await fixtureManifest(),
  };
}

/** One App, one Component, one Build — the whole of what a bundle row joins. */
async function seed(
  ctx: CommandContext,
  input: {
    name: string;
    sourceKind: 'repo' | 'archive';
    bundleDigest: string | null;
    bundleLocation?: string | null;
    runner?: string | null;
    status?: 'PENDING' | 'SUCCEEDED';
    artifactType?: 'image' | 'files';
  },
) {
  const [app] = await ctx.db
    .insert(apps)
    .values({ name: input.name, sourceKind: input.sourceKind })
    .returning();
  const [component] = await ctx.db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: input.bundleDigest ?? 'a'.repeat(40),
      targetShape: input.artifactType ?? 'image',
      artifactType: input.artifactType ?? 'image',
      status: input.status ?? 'SUCCEEDED',
      bundleDigest: input.bundleDigest,
      bundleLocation: input.bundleLocation ?? null,
      runner: input.runner ?? null,
    })
    .returning();
  return build!;
}

describe('listing staged bundles', () => {
  let ctx: CommandContext;

  beforeEach(async () => {
    ctx = await context();
  });

  test('is empty before anything is staged', async () => {
    const result = await listStagedBundles({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundles).toEqual([]);
  });

  test('a repository bundle is ephemeral and was built by a route', async () => {
    await seed(ctx, {
      name: 'from-a-repo',
      sourceKind: 'repo',
      bundleDigest: digest('a'),
      bundleLocation: 'gs://a-bucket/aaaa.tgz',
      runner: 'hosted',
    });

    const result = await listStagedBundles({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundles[0]).toMatchObject({
      app: 'from-a-repo',
      component: 'web',
      retention: 'ephemeral',
      deployable: false,
      runner: 'hosted',
      fetchable: true,
    });
  });

  test('an uploaded archive no route ran over is durable and deployable', async () => {
    await seed(ctx, {
      name: 'an-upload',
      sourceKind: 'archive',
      bundleDigest: digest('b'),
      bundleLocation: 'gs://a-bucket/bbbb.tgz',
      artifactType: 'files',
      runner: null,
    });

    const result = await listStagedBundles({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundles[0]).toMatchObject({
      retention: 'durable',
      deployable: true,
      artifactType: 'files',
    });
  });

  test('a Build still pending is not deployable however it was sourced', async () => {
    await seed(ctx, {
      name: 'not-yet',
      sourceKind: 'archive',
      bundleDigest: digest('c'),
      status: 'PENDING',
      runner: null,
    });

    const result = await listStagedBundles({}, ctx);
    expect(result.ok && result.value.bundles[0]?.deployable).toBe(false);
  });

  /**
   * `upload://` is deliberately not a URL — no route can fetch it — and a
   * listing that did not say so would show a bundle that cannot be built as
   * indistinguishable from one that can.
   */
  test('names a location no builder could fetch', async () => {
    await seed(ctx, {
      name: 'on-local-disk',
      sourceKind: 'archive',
      bundleDigest: digest('d'),
      bundleLocation: `upload://${'d'.repeat(64)}`,
    });

    const result = await listStagedBundles({}, ctx);
    expect(result.ok && result.value.bundles[0]?.fetchable).toBe(false);
  });

  test('a Build that has staged nothing is not a bundle', async () => {
    await seed(ctx, {
      name: 'nothing-staged',
      sourceKind: 'repo',
      bundleDigest: null,
    });

    const result = await listStagedBundles({}, ctx);
    expect(result.ok && result.value.bundles).toEqual([]);
  });

  test('is newest first, and says what it capped at', async () => {
    await seed(ctx, {
      name: 'older',
      sourceKind: 'repo',
      bundleDigest: digest('e'),
    });
    await seed(ctx, {
      name: 'newer',
      sourceKind: 'repo',
      bundleDigest: digest('f'),
    });

    const result = await listStagedBundles({ limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundles.map((one) => one.app)).toEqual(['newer']);
    expect(result.value.limit).toBe(1);
  });
});
