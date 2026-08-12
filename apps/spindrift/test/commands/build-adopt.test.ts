/**
 * Adopting a sibling's artifact (§2, §4, §16).
 *
 * The claim is that sharing an artifact costs **no new noun and no second
 * build**: the adopter gets a `builds` row of its own naming the same digest, so
 * `deploys → builds → components` stays true and every admission gate re-runs on
 * the evidence that came with the digest rather than on a waiver.
 *
 * Each test here targets a sentence that would still look like it worked if it
 * were false:
 *
 * - **The gates re-run.** A destination Target with a higher policy than the
 *   source's refuses the adopted Build. Copying the provenance columns forward is
 *   only honest if this is true — otherwise it is a way to launder a Build past a
 *   threshold, which is exactly what §16 exists to prevent.
 * - **The ledger does not call it supplied.** `artifacts/list.ts:114` reads a null
 *   runner as §4's uploaded artifact, so a copy that dropped the runner would file
 *   a built artifact under "nobody built this" and nothing would say so.
 * - **Nothing builds.** The registry's `build()` throws, so "no second build" is
 *   asserted as a property of the code path rather than of the row it returned.
 */
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

/** A digest of the right shape, distinct per call. */
function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/**
 * A registry whose build side is a tripwire — adoption exists so that nothing
 * builds, and a `build()` that throws is what fails when something does.
 */
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

/** A Target that takes images, connected, with a stated policy. */
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

/** §2's monolith: one App, the Component that builds, the Component that runs. */
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
    // The whole of what the copy carries — the digest, the addresses it is
    // pulled by, the source it came out of, and the evidence admission re-runs.
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

    // And it is deployable as itself: `createDeploy`'s "that Build belongs to a
    // different Component" guard is untouched, and the copy is what routes
    // around it while keeping deploys → builds → components true.
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
    // The guard that makes the copy necessary. If this ever passes, adoption is
    // solving a problem that no longer exists — and `deploys → builds →
    // components` has stopped meaning anything.
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
    // Nothing was written: the App boundary is not a warning.
    expect(
      await database()
        .db.select()
        .from(builds)
        .where(eq(builds.componentId, mine.worker.id)),
    ).toEqual([]);
  });

  test('a destination Target with a higher policy still refuses the adopted Build', async () => {
    // The test that decides whether copying the provenance columns is honest.
    // The source Build reached L2 and would deploy anywhere that asks for L2;
    // adopting it does not buy the adopter an L3 Target.
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
    // §4's supplied artifact is uploaded finished output no builder ran over.
    // A builder ran over this one; it just ran for the sibling.
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
    // §2's key is (component, commit, target-shape). The adopter built this
    // commit itself, so the key is taken by a row that is not this artifact —
    // overwriting it would retarget a Build somebody may already be deploying.
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
