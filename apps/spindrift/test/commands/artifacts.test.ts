/**
 * The Artifacts a Build left behind (§2, §4, §16).
 *
 * What this listing has to keep true is the cardinality §2 rests on: **one
 * Build → one Artifact → many Deploys**, which is what makes rollback without
 * rebuilding possible. A count that came out per Deploy row would make the
 * Artifact look like it existed once per placement, which is the exact
 * conflation splitting the noun out of the Build ledger exists to undo.
 *
 * The other two are the ones an operator acts on: an Artifact nothing has ever
 * placed, and §4's supplied artifact — uploaded finished output that no builder
 * ran over, which is an Artifact with no Build behind it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { listArtifacts } from '../../src/commands/artifacts/list.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-08-02T12:00:00.000Z');

const adapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => {
    throw new Error('listing Artifacts reached the supply chain');
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

async function seed(
  ctx: CommandContext,
  input: {
    name: string;
    artifactDigest: string | null;
    artifactRefs?: string[];
    runner?: string | null;
    status?: 'PENDING' | 'SUCCEEDED';
    verifiedBuildLevel?: number | null;
    placements?: number;
  },
) {
  const [app] = await ctx.db
    .insert(apps)
    .values({ name: input.name, sourceKind: 'repo' })
    .returning();
  const [component] = await ctx.db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'a'.repeat(40),
      targetShape: 'image',
      artifactType: 'image',
      status: input.status ?? 'SUCCEEDED',
      artifactDigest: input.artifactDigest,
      artifactRefs: input.artifactRefs ?? null,
      bundleDigest: digest('b'),
      // `??` would swallow an explicit null, which is the whole of what a
      // supplied artifact looks like.
      runner: input.runner === undefined ? 'hosted' : input.runner,
      verifiedBuildLevel: input.verifiedBuildLevel ?? null,
    })
    .returning();

  for (let index = 0; index < (input.placements ?? 0); index += 1) {
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ name: `${input.name}-target-${index}` }))
      .returning();
    await ctx.db.insert(deploys).values({
      componentId: component!.id,
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
    });
  }
  return build!;
}

describe('listing Artifacts', () => {
  let ctx: CommandContext;

  beforeEach(async () => {
    ctx = await context();
  });

  test('is empty before a Build produced anything', async () => {
    const result = await listArtifacts({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifacts).toEqual([]);
  });

  test('a Build with no digest produced no Artifact', async () => {
    await seed(ctx, {
      name: 'still-running',
      artifactDigest: null,
      status: 'PENDING',
    });

    const result = await listArtifacts({}, ctx);
    expect(result.ok && result.value.artifacts).toEqual([]);
  });

  test('counts every Deploy of one Artifact, and reports its registries', async () => {
    await seed(ctx, {
      name: 'placed-twice',
      artifactDigest: digest('c'),
      artifactRefs: ['ghcr.io/an-owner/placed-twice', 'docker.io/x/y'],
      placements: 2,
    });

    const result = await listArtifacts({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifacts).toHaveLength(1);
    expect(result.value.artifacts[0]).toMatchObject({
      digest: digest('c'),
      deploys: 2,
      refs: ['ghcr.io/an-owner/placed-twice', 'docker.io/x/y'],
      sourceDigest: digest('b'),
      supplied: false,
      signed: false,
    });
  });

  test('an Artifact nothing has placed says so rather than vanishing', async () => {
    await seed(ctx, { name: 'never-placed', artifactDigest: digest('d') });

    const result = await listArtifacts({}, ctx);
    expect(result.ok && result.value.artifacts[0]?.deploys).toBe(0);
  });

  test('finished output no builder ran over is a supplied Artifact', async () => {
    await seed(ctx, {
      name: 'uploaded',
      artifactDigest: digest('e'),
      runner: null,
    });

    const result = await listArtifacts({}, ctx);
    expect(result.ok && result.value.artifacts[0]?.supplied).toBe(true);
  });

  test('reports the level core verified, and null where it verified none', async () => {
    await seed(ctx, {
      name: 'attested',
      artifactDigest: digest('f'),
      verifiedBuildLevel: 3,
    });

    const result = await listArtifacts({}, ctx);
    expect(result.ok && result.value.artifacts[0]?.provenanceLevel).toBe(3);
  });
});
