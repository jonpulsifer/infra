/**
 * The Sources an installation has staged (§4, §15).
 *
 * Three derivations carry the whole listing and each is easy to get subtly
 * wrong, which is why they are asserted rather than read.
 *
 * **A row is a digest, not a Build.** The same staged bytes are dispatched once
 * per target shape, so a per-Build listing counted one Source twice and paged
 * as though there were two. Grouping is what makes the noun mean itself.
 *
 * **`supplied` is what happened, not what was declared.** §4's supplied
 * artifact is an archive of finished output that no route ever ran over, and
 * the durable evidence of that is a `SUCCEEDED` Build with no runner. Reading
 * the App's declared archive contents instead would mark a Source on the
 * strength of a claim made before anything was staged.
 *
 * **`retention` follows the source kind**, per `source-bundle.ts`: an upload is
 * durable and a repository fetch is ephemeral. It is what decides whether the
 * location on a row still resolves.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { listSources } from '../../src/commands/sources/list.ts';
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
    throw new Error('listing Sources reached the supply chain');
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

/** One App, one Component, one Build — the whole of what a Source row joins. */
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
    /** A second shape over the same bytes, which must not be a second Source. */
    targetShape?: string;
    commit?: string;
    repoUrl?: string;
  },
) {
  const existing = await ctx.db.query.apps.findFirst({
    where: (app, { eq }) => eq(app.name, input.name),
  });
  const app =
    existing ??
    (
      await ctx.db
        .insert(apps)
        .values({
          name: input.name,
          sourceKind: input.sourceKind,
          sourceRepoUrl: input.repoUrl ?? null,
        })
        .returning()
    )[0]!;
  const component =
    (await ctx.db.query.components.findFirst({
      where: (row, { eq }) => eq(row.appId, app.id),
    })) ??
    (
      await ctx.db
        .insert(components)
        .values({ appId: app.id, name: 'web', kind: 'service' })
        .returning()
    )[0]!;
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: component.id,
      commit: input.commit ?? input.bundleDigest ?? 'a'.repeat(40),
      targetShape: input.targetShape ?? input.artifactType ?? 'image',
      artifactType: input.artifactType ?? 'image',
      status: input.status ?? 'SUCCEEDED',
      bundleDigest: input.bundleDigest,
      bundleLocation: input.bundleLocation ?? null,
      runner: input.runner ?? null,
    })
    .returning();
  return build!;
}

describe('listing Sources', () => {
  let ctx: CommandContext;

  beforeEach(async () => {
    ctx = await context();
  });

  test('is empty before anything is staged', async () => {
    const result = await listSources({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toEqual([]);
  });

  test('a repository Source is ephemeral and names its commit', async () => {
    await seed(ctx, {
      name: 'from-a-repo',
      sourceKind: 'repo',
      repoUrl: 'https://github.com/an-owner/a-repo',
      commit: 'c'.repeat(40),
      bundleDigest: digest('a'),
      bundleLocation: 'gs://a-bucket/aaaa.tgz',
      runner: 'hosted',
    });

    const result = await listSources({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]).toMatchObject({
      app: 'from-a-repo',
      component: 'web',
      origin: 'repo',
      repository: 'https://github.com/an-owner/a-repo',
      commit: 'c'.repeat(40),
      retention: 'ephemeral',
      supplied: false,
      fetchable: true,
      builds: 1,
    });
  });

  test('an uploaded archive no route ran over is durable and supplied', async () => {
    await seed(ctx, {
      name: 'an-upload',
      sourceKind: 'archive',
      bundleDigest: digest('b'),
      bundleLocation: 'gs://a-bucket/bbbb.tgz',
      artifactType: 'files',
      runner: null,
    });

    const result = await listSources({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]).toMatchObject({
      origin: 'upload',
      repository: null,
      commit: null,
      retention: 'durable',
      supplied: true,
    });
  });

  test('a Build still pending is not supplied however it was sourced', async () => {
    await seed(ctx, {
      name: 'not-yet',
      sourceKind: 'archive',
      bundleDigest: digest('c'),
      status: 'PENDING',
      runner: null,
    });

    const result = await listSources({}, ctx);
    expect(result.ok && result.value.sources[0]?.supplied).toBe(false);
  });

  /**
   * `upload://` is deliberately not a URL — no route can fetch it — and a
   * listing that did not say so would show a Source that cannot be built as
   * indistinguishable from one that can.
   */
  test('names a location no builder could fetch', async () => {
    await seed(ctx, {
      name: 'on-local-disk',
      sourceKind: 'archive',
      bundleDigest: digest('d'),
      bundleLocation: `upload://${'d'.repeat(64)}`,
    });

    const result = await listSources({}, ctx);
    expect(result.ok && result.value.sources[0]?.fetchable).toBe(false);
  });

  test('a Build that has staged nothing is not a Source', async () => {
    await seed(ctx, {
      name: 'nothing-staged',
      sourceKind: 'repo',
      bundleDigest: null,
    });

    const result = await listSources({}, ctx);
    expect(result.ok && result.value.sources).toEqual([]);
  });

  /**
   * The reason this listing groups. One commit built for two target shapes is
   * two Builds over one set of bytes, and §15 stages those bytes once.
   */
  test('one digest built for two shapes is one Source that counts both', async () => {
    await seed(ctx, {
      name: 'two-shapes',
      sourceKind: 'repo',
      commit: 'e'.repeat(40),
      bundleDigest: digest('e'),
      targetShape: 'image',
    });
    const second = await seed(ctx, {
      name: 'two-shapes',
      sourceKind: 'repo',
      commit: 'e'.repeat(40),
      bundleDigest: digest('e'),
      targetShape: 'files',
      artifactType: 'files',
    });

    const result = await listSources({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]).toMatchObject({
      digest: digest('e'),
      builds: 2,
      latestBuildId: second.id,
    });
  });

  test('is newest first, and says what it capped at', async () => {
    await seed(ctx, {
      name: 'older',
      sourceKind: 'repo',
      bundleDigest: digest('f'),
    });
    await seed(ctx, {
      name: 'newer',
      sourceKind: 'repo',
      bundleDigest: digest('0'),
    });

    const result = await listSources({ limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources.map((one) => one.app)).toEqual(['newer']);
    expect(result.value.limit).toBe(1);
  });
});
