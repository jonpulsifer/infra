// Adoption copies a sibling's Build row under the adopter, so every admission
// gate re-runs on the copied evidence and nothing builds.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { listArtifacts } from '../../src/commands/artifacts/list.ts';
import { adoptBuild } from '../../src/commands/builds/adopt.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, builds, components, targets } from '../../src/db/schema.ts';
import { targetLabel } from '../../src/domain/target.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-12T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/** `build()` throws, so any path that builds fails the test. */
function registryOf(deployAdapter: DeployAdapter): AdapterRegistry {
  const chain = new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: (route) => {
      throw new Error(`adoption looked up the ${route} build route`);
    },
    store: () => {
      throw new Error('adoption reached the secret store');
    },
    repository: () => null,
    supplyChain: () => chain,
  };
}

function context(adapters: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

async function aTarget(minBuildLevel?: number) {
  const db = database().db;
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        discovery: null,
        ...(minBuildLevel === undefined ? {} : { minBuildLevel }),
      }),
    )
    .returning();
  return {
    target: target!,
    label: targetLabel({ vessel: vessel.name, adapter: 'kubernetes' }),
  };
}

async function aMonolith(name: string) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name, sourceKind: 'repo', sourceRepoUrl: `https://x/${name}` })
    .returning();
  const [web] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const [worker] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'worker',
      kind: 'job',
      reach: 'none',
      auth: 'none',
    })
    .returning();
  return { app: app!, web: web!, worker: worker! };
}

/** The sibling's finished artifact: succeeded, attested, signed. */
async function anArtifact(componentId: string, seed: number, level = 2) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: `${seed}`.padStart(40, 'a'),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest(seed),
      artifactRefs: ['ghcr.io/lab/shop/web'],
      bundleDigest: digest(seed + 1000),
      bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
      bundleSubpath: 'apps/web',
      status: 'SUCCEEDED',
      runner: 'hosted',
      verifiedBuildLevel: level,
      signature: testSignature(digest(seed), FROZEN.toISOString()),
    })
    .returning();
  return build!;
}

const capable = () => new FakeDeployAdapter({ adapter: 'kubernetes' });

describe('adopting a sibling Component’s artifact', () => {
  test('the adopter gets its own Build naming the same artifact, and deploys it', async () => {
    const { web, worker } = await aMonolith('shop');
    const { target } = await aTarget();
    const source = await anArtifact(web.id, 1);
    const ctx = context(registryOf(capable()));

    const adopted = await adoptBuild(
      { componentId: worker.id, fromBuildId: source.id },
      ctx,
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.value.artifactDigest).toBe(source.artifactDigest!);
    expect(adopted.value.buildId).not.toBe(source.id);

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, adopted.value.buildId));
    expect(row).toMatchObject({
      componentId: worker.id,
      status: 'SUCCEEDED',
      commit: source.commit,
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: source.artifactDigest,
      artifactRefs: source.artifactRefs,
      bundleDigest: source.bundleDigest,
      bundleLocation: source.bundleLocation,
      bundleSubpath: source.bundleSubpath,
      verifiedBuildLevel: source.verifiedBuildLevel,
      runner: source.runner,
    });
    expect(row?.signature).toEqual(source.signature!);

    // The copy belongs to the adopter, so createDeploy's different-Component
    // guard passes.
    const placed = await createDeploy(
      {
        componentId: worker.id,
        targetId: target.id,
        buildId: adopted.value.buildId,
      },
      ctx,
    );
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.value.buildId).toBe(adopted.value.buildId);
  });

  test('the sibling’s own Build stays refused for the adopter', async () => {
    // The guard that makes the copy necessary.
    const { web, worker } = await aMonolith('guarded');
    const { target } = await aTarget();
    const source = await anArtifact(web.id, 2);

    const placed = await createDeploy(
      { componentId: worker.id, targetId: target.id, buildId: source.id },
      context(registryOf(capable())),
    );

    expect(placed.ok).toBe(false);
    if (placed.ok) return;
    expect(placed.failure.message).toBe(
      'that Build belongs to a different Component',
    );
  });

  test('a Build of another App is refused, naming both ids', async () => {
    const mine = await aMonolith('ours');
    const theirs = await aMonolith('theirs');
    const source = await anArtifact(theirs.web.id, 3);

    const adopted = await adoptBuild(
      { componentId: mine.worker.id, fromBuildId: source.id },
      context(registryOf(capable())),
    );

    expect(adopted.ok).toBe(false);
    if (adopted.ok) return;
    expect(adopted.failure.code).toBe('INVALID_INPUT');
    expect(adopted.failure.message).toContain(theirs.web.id);
    expect(adopted.failure.message).toContain(mine.worker.id);
    expect(
      await database()
        .db.select()
        .from(builds)
        .where(eq(builds.componentId, mine.worker.id)),
    ).toEqual([]);
  });

  test('a destination Target with a higher policy still refuses the adopted Build', async () => {
    // An L2 source does not buy the adopter an L3 Target.
    const { web, worker } = await aMonolith('policed');
    const { target, label } = await aTarget(3);
    const source = await anArtifact(web.id, 4, 2);
    const ctx = context(registryOf(capable()));

    const adopted = await adoptBuild(
      { componentId: worker.id, fromBuildId: source.id },
      ctx,
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;

    expect(
      await createDeploy(
        {
          componentId: worker.id,
          targetId: target.id,
          buildId: adopted.value.buildId,
        },
        ctx,
      ),
    ).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${adopted.value.buildId} achieved verified Build Level 2, and ${label} currently requires L3`,
      },
    });
  });

  test('the Artifacts ledger does not call an adopted artifact supplied', async () => {
    const { web, worker } = await aMonolith('ledger');
    const source = await anArtifact(web.id, 5);
    const ctx = context(registryOf(capable()));

    const adopted = await adoptBuild(
      { componentId: worker.id, fromBuildId: source.id },
      ctx,
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;

    const listed = await listArtifacts({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.value.artifacts.find(
      (artifact) => artifact.buildId === adopted.value.buildId,
    );
    // A supplied artifact is one no builder ran; this one was built for the
    // sibling.
    expect(row).toMatchObject({
      component: 'worker',
      supplied: false,
      provenanceLevel: 2,
      signed: true,
    });
  });

  test('adopting the same artifact twice lands on the row the first one wrote', async () => {
    const { web, worker } = await aMonolith('idempotent');
    const source = await anArtifact(web.id, 6);
    const ctx = context(registryOf(capable()));
    const input = { componentId: worker.id, fromBuildId: source.id };

    const first = await adoptBuild(input, ctx);
    const second = await adoptBuild(input, ctx);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.buildId).toBe(first.value.buildId);
    expect(
      await database()
        .db.select()
        .from(builds)
        .where(eq(builds.componentId, worker.id)),
    ).toHaveLength(1);
  });

  test('a commit the adopter already has as a different artifact is refused', async () => {
    // The adopter built this commit itself, so the (component, commit,
    // target-shape) key is taken by a different artifact.
    const { web, worker } = await aMonolith('collided');
    const source = await anArtifact(web.id, 7);
    const [own] = await database()
      .db.insert(builds)
      .values({
        componentId: worker.id,
        commit: source.commit,
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
      })
      .returning();

    const adopted = await adoptBuild(
      { componentId: worker.id, fromBuildId: source.id },
      context(registryOf(capable())),
    );

    expect(adopted.ok).toBe(false);
    if (adopted.ok) return;
    expect(adopted.failure.code).toBe('INVALID_INPUT');
    expect(adopted.failure.message).toContain(`Build ${own!.id}`);
    // The Build in flight was left alone.
    const [after] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, own!.id));
    expect(after?.status).toBe('RUNNING');
    expect(after?.artifactDigest).toBeNull();
  });

  test('a Build that has not succeeded has no artifact to adopt', async () => {
    const { web, worker } = await aMonolith('unfinished');
    const [running] = await database()
      .db.insert(builds)
      .values({
        componentId: web.id,
        commit: digest(8),
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
      })
      .returning();

    const adopted = await adoptBuild(
      { componentId: worker.id, fromBuildId: running!.id },
      context(registryOf(capable())),
    );

    expect(adopted).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${running!.id} has no artifact — it is running`,
      },
    });
  });
});
