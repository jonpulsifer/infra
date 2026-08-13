/**
 * Build and Deploy, and the three claims §6 makes about them (Task 19).
 *
 * Every test here targets a sentence that would still "work" if it were false,
 * which is what makes them worth writing:
 *
 * - **Two concurrent deploys of the same Component@Target serialize.** Against a
 *   fake database this passes by accident, because a fake has no concurrency to
 *   get wrong. It is asserted here with **two real Postgres sessions contending
 *   for one row**, which is the only arrangement that can fail.
 * - **A late-finishing older build moves nothing** (§4: "a build records an
 *   artifact rather than deploying one... there is no `SUPERSEDED` verdict to
 *   explain"). Asserted by finishing an older Build *after* a newer one is live
 *   and reading the desired row back.
 * - **Rollback dispatches no build** (§6: "rollback is an ordinary deploy"). The
 *   context's build registry throws if it is so much as consulted, so this is a
 *   claim about what the code path does not contain rather than about what it
 *   returned.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { uploadArchive } from '../../src/commands/apps/upload-archive.ts';
import { dispatchBuild } from '../../src/commands/builds/dispatch.ts';
import { placeComponent } from '../../src/commands/components/place.ts';
import {
  createDeploy,
  placeIntent,
} from '../../src/commands/deploys/create.ts';
import { rollbackDeploy } from '../../src/commands/deploys/rollback.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  datastores,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { configVersionOf } from '../../src/domain/config-version.ts';
import { targetLabel } from '../../src/domain/target.ts';
import { policyDrift } from '../../src/supply-chain/posture.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
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
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** A digest of the right shape, distinct per call. */
function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/**
 * A registry whose build side is a tripwire.
 *
 * "Rollback dispatches no build" and "creating a Deploy dispatches no build" are
 * negative claims, and a negative claim needs something that fails when it is
 * violated. A `build()` that throws is that something.
 */
function registryOf(
  deployAdapter: DeployAdapter,
  buildAdapter?: FakeBuildAdapter,
  supplyChain?: SupplyChainHarness,
): AdapterRegistry {
  const chain = supplyChain ?? new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: (route) => {
      if (buildAdapter === undefined) {
        throw new Error(
          `a command that must not build looked up the ${route} route`,
        );
      }
      return route === buildAdapter.name ? buildAdapter : null;
    },
    store: () => {
      throw new Error('a deploy command reached the secret store');
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

/** An App, a Component, and a connected Target that accepts images. */
async function fixture(
  options: {
    kind?: 'service' | 'website';
    adapter?: TargetAdapter;
    /**
     * The Component's §9 pair, which the deploy path now filters on.
     *
     * Defaulted by the column rather than here — `private` behind the Target's
     * authenticated edge — because that is what the cluster fixture serves. A
     * test on a `static` Target has to state `public`: static hosting asserts
     * `public` and nothing else, so a private Component there is a placement
     * that was never offered and is now refused where it is released too.
     */
    reach?: 'none' | 'private' | 'public';
    auth?: 'none' | 'proxy';
  } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: options.kind ?? 'service',
      expose: true,
      ...(options.reach === undefined ? {} : { reach: options.reach }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
    })
    .returning();
  const adapter = options.adapter ?? 'kubernetes';
  const vessel = await insertVessel(db, adapter, {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter,
        vesselId: vessel.id,
        discovery: null,
      }),
    )
    .returning();
  return {
    app: app!,
    component: component!,
    target: target!,
    // `<vessel>/<adapter>` — the same label `targetRowLabel` renders into a
    // refusal message, precomputed here because the row alone cannot say it.
    label: targetLabel({ vessel: vessel.name, adapter }),
  };
}

/** A Build that is ready to deploy: succeeded, with an artifact of one shape. */
async function succeededBuild(
  componentId: string,
  seed: number,
  shape: 'image' | 'files' = 'image',
  verifiedBuildLevel = 2,
) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest(seed),
      targetShape: shape,
      artifactType: shape,
      artifactDigest: digest(seed),
      bundleDigest: digest(seed),
      // Where the bundle was staged. A Build without one cannot be dispatched
      // at all — a route would have nothing to fetch.
      bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel,
      // A signature the pinned verifier will actually admit: §16's gate is
      // real now, so a placeholder bundle would be refused here exactly as it
      // would in production.
      signature: testSignature(digest(seed), FROZEN.toISOString()),
    })
    .returning();
  return build!;
}

/** A Target whose discovery makes it capable, so `artifactTypeFor` agrees. */
function capableAdapter(): FakeDeployAdapter {
  return new FakeDeployAdapter({ adapter: 'kubernetes' });
}

async function desiredRow(componentId: string, targetId: string) {
  const [row] = await database()
    .db.select()
    .from(componentTargetDesired)
    .where(
      and(
        eq(componentTargetDesired.componentId, componentId),
        eq(componentTargetDesired.targetId, targetId),
      ),
    );
  return row;
}

describe('createDeploy writes an intent, and only an intent', () => {
  test('the Deploy is PENDING and the desired row points at it', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 1);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('PENDING');
    // Nothing was live here before, so there is nothing this superseded.
    expect(result.value.supersededBuildId).toBeNull();

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));
    expect(row?.phase).toBe('PENDING');
    // §6: the loop owns every phase after PENDING, so an intent has placed
    // nothing and carries no adapter handle yet.
    expect(row?.ref).toBeNull();
    expect(row?.url).toBeNull();

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(build.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  test('a Build that has not succeeded has no artifact to place', async () => {
    const { component, target } = await fixture();
    const [pending] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(9),
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
      })
      .returning();

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: pending!.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    // No intent row was written, so the loop has nothing to find.
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a shape the Target does not take needs a rebuild, and says so', async () => {
    // §3: "changing placement across shapes forces a rebuild." A `files`
    // artifact against a cluster is that case, caught here rather than as a
    // deploy that fails on the far side.
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 2, 'files');

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('rebuild');
  });

  test('a Component is refused at a reach its Target does not assert', async () => {
    // §3's filter, asked where the release actually happens. Placement excluded
    // this Target when the developer was offered it; nothing re-asked when the
    // Deploy was created, so "the Target says it cannot and it happened anyway"
    // was the whole of the defect — a declared boundary that was advisory.
    const { component, target, label } = await fixture();
    // `auth: 'none'` so this is a claim about reach alone — the authenticated
    // edge is the test below, and a Component carrying both would be refused
    // twice and prove neither.
    await database()
      .db.update(components)
      .set({ reach: 'public', auth: 'none' })
      .where(eq(components.id, component.id));
    const build = await succeededBuild(component.id, 60);
    const intent = {
      componentId: component.id,
      targetId: target.id,
      buildId: build.id,
    };

    const refused = await createDeploy(
      intent,
      context(registryOf(capableAdapter())),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_DEPLOYABLE');
    expect(refused.failure.message).toContain(label);
    expect(refused.failure.message).toContain(
      'no way to serve a public address',
    );
    expect(await desiredRow(component.id, target.id)).toBeUndefined();

    // Rollback shares this gate, and has to: a Component released at a reach
    // its Target does not serve is the same defect whichever intent wrote it,
    // and a guard that lived in `createDeploy` alone would leave rollback and
    // `setConfig` open.
    const rolled = await rollbackDeploy(
      intent,
      context(registryOf(capableAdapter())),
    );
    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.message).toContain(
      'no way to serve a public address',
    );

    // And it reads the asserted column rather than refusing `public`
    // categorically: the operator states the tunnel, because §3 says nothing
    // reports one, and the same call goes through.
    await database()
      .db.update(targets)
      .set({ reaches: ['none', 'private', 'public'] })
      .where(eq(targets.id, target.id));

    const allowed = await createDeploy(
      intent,
      context(registryOf(capableAdapter())),
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect((await desiredRow(component.id, target.id))?.desiredDeployId).toBe(
      allowed.value.deployId,
    );
  });

  test('a Target with no authenticated edge for a reach refuses a proxied Component', async () => {
    // §9's half, which no live Component exercises today: the fixture Target
    // asserts an edge for `private` and serves `public` once the tunnel is
    // stated, so it can carry a public address and still not authenticate one.
    const { component, target } = await fixture();
    await database()
      .db.update(components)
      .set({ reach: 'public', auth: 'proxy' })
      .where(eq(components.id, component.id));
    await database()
      .db.update(targets)
      .set({ reaches: ['none', 'private', 'public'], authReaches: ['private'] })
      .where(eq(targets.id, target.id));
    const build = await succeededBuild(component.id, 61);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('admits a single user');
  });

  test('a disconnected Target takes nothing new', async () => {
    const { component, target } = await fixture();
    await database()
      .db.update(targets)
      .set({ status: 'disconnected' })
      .where(eq(targets.id, target.id));
    const build = await succeededBuild(component.id, 3);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
  });

  test('supplied files need no image provenance or image signature', async () => {
    const { component, target } = await fixture({
      kind: 'website',
      adapter: 'static',
      // What a site on static hosting is: a public address with no runtime to
      // authenticate anything, which is the only placement that Target offers.
      reach: 'public',
      auth: 'none',
    });
    const deployAdapter = new FakeDeployAdapter({
      adapter: 'static',
      artifactTypes: ['files'],
    });
    const ctx = context(registryOf(deployAdapter));
    const uploaded = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(5),
        location: 'https://depot.lolwtf.ca/bundles/shop/site.zip',
        contents: 'artifact',
        subpath: '.',
      },
      ctx,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const placed = await createDeploy(
      {
        componentId: component.id,
        targetId: target.id,
        buildId: uploaded.value.buildId,
      },
      ctx,
    );
    expect(placed.ok).toBe(true);
  });

  test('raised policy leaves LIVE serving but blocks every new placement', async () => {
    const { component, target, label } = await fixture();
    const build = await succeededBuild(component.id, 4);
    const first = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await database()
      .db.update(deploys)
      .set({ phase: 'LIVE' })
      .where(eq(deploys.id, first.value.deployId));
    await database()
      .db.update(targets)
      .set({ minBuildLevel: 3 })
      .where(eq(targets.id, target.id));

    expect(
      policyDrift({
        phase: 'LIVE',
        achievedLevel: build.verifiedBuildLevel as 2,
        requiredLevel: 3,
      }),
    ).toEqual({
      drifted: true,
      reason: 'verified Build Level 2 is below this Target’s current L3 policy',
    });
    expect(
      await database()
        .db.select({ phase: deploys.phase })
        .from(deploys)
        .where(eq(deploys.id, first.value.deployId)),
    ).toEqual([{ phase: 'LIVE' }]);

    const next = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );
    expect(next).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${build.id} achieved verified Build Level 2, and ${label} currently requires L3`,
      },
    });
  });

  test('a signature that will not verify fails closed before any intent row is written', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 9);

    const supplyChain = new SupplyChainHarness(undefined, async () => ({
      ok: false,
      reason: 'tampered bundle',
    }));
    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter(), undefined, supplyChain)),
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${build.id} signature did not verify: tampered bundle`,
      },
    });
    expect(supplyChain.signatureChecks.admissions).toHaveLength(1);
    expect(supplyChain.signatureChecks.admissions[0]?.artifactDigest).toBe(
      build.artifactDigest!,
    );

    // Fail-closed: no desired row was created and no Deploy row was written.
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
    expect(
      await database()
        .db.select()
        .from(deploys)
        .where(eq(deploys.buildId, build.id)),
    ).toEqual([]);
  });

  test('admission re-verifies the recorded signature on every image deploy', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 10);

    const supplyChain = new SupplyChainHarness();
    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter(), undefined, supplyChain)),
    );

    expect(result.ok).toBe(true);
    expect(supplyChain.signatureChecks.admissions).toHaveLength(1);
    expect(supplyChain.signatureChecks.admissions[0]?.signature).toEqual(
      build.signature!,
    );
  });

  test('a files artifact skips signature admission', async () => {
    const { component, target } = await fixture({
      kind: 'website',
      adapter: 'static',
      // What a site on static hosting is: a public address with no runtime to
      // authenticate anything, which is the only placement that Target offers.
      reach: 'public',
      auth: 'none',
    });
    const deployAdapter = new FakeDeployAdapter({
      adapter: 'static',
      artifactTypes: ['files'],
    });
    const supplyChain = new SupplyChainHarness();
    const ctx = context(registryOf(deployAdapter, undefined, supplyChain));
    const uploaded = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(11),
        location: 'https://depot.lolwtf.ca/bundles/shop/site.zip',
        contents: 'artifact',
        subpath: '.',
      },
      ctx,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const placed = await createDeploy(
      {
        componentId: component.id,
        targetId: target.id,
        buildId: uploaded.value.buildId,
      },
      ctx,
    );
    expect(placed.ok).toBe(true);
    // A files artifact has no image signature, so admission never consulted the
    // signature verifier.
    expect(supplyChain.signatureChecks.admissions).toHaveLength(0);
  });

  test('Cloud Run image deploys share the same admission gate (§16)', async () => {
    const { component } = await fixture({ adapter: 'cloudrun' });
    const cloudVessel = await insertVessel(database().db, 'cloudrun', {
      name: `cloud-${crypto.randomUUID()}`,
    });
    const [cloudTarget] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'cloudrun',
          vesselId: cloudVessel.id,
          discovery: null,
        }),
      )
      .returning();
    const build = await succeededBuild(component.id, 12);

    const refusing = new SupplyChainHarness(undefined, async () => ({
      ok: false,
      reason: 'cloud admission rejects',
    }));
    const deployAdapter = new FakeDeployAdapter({ adapter: 'cloudrun' });

    const refused = await createDeploy(
      {
        componentId: component.id,
        targetId: cloudTarget!.id,
        buildId: build.id,
      },
      context(registryOf(deployAdapter, undefined, refusing)),
    );

    expect(refused).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${build.id} signature did not verify: cloud admission rejects`,
      },
    });
    expect(refusing.signatureChecks.admissions).toHaveLength(1);
  });
});

describe('deployApp selects which Component it acts on', () => {
  /**
   * A second Component on the fixture's App — a `job` alongside the fixture's
   * `service`, the shape that had no path to a Build at all before `deployApp`
   * could be told which Component it meant. Placed on the fixture's own Target
   * so `desiredTargets` — not a Deploy history that does not exist yet — is
   * what resolves `targetId`.
   */
  async function secondComponent(appId: string, targetId: string) {
    const db = database().db;
    const [component] = await db
      .insert(components)
      .values({
        appId,
        name: 'worker',
        kind: 'job',
        reach: 'none',
        auth: 'none',
        placedTargetId: targetId,
      })
      .returning();
    await db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId, updatedAt: FROZEN });
    return component!;
  }

  /**
   * The upload a second Component of an **archive** App has to have of its own.
   *
   * §15 holds an archive's bytes per Component — `uploadArchive` writes them
   * onto a Build row — so a sibling that never had one has nothing any route
   * could fetch, and `deployApp` refuses that rather than writing a Build
   * `dispatchBuild` closes on sight. These tests are about *which* Component
   * the press acts on, so the sibling carries the upload that refusal asks for.
   * `FAILED`, so the press below is still the Build-starting act rather than
   * the deploy one.
   */
  async function uploadedBundle(componentId: string, seed: number) {
    const [row] = await database()
      .db.insert(builds)
      .values({
        componentId,
        commit: digest(seed),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(seed),
        bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
        status: 'FAILED',
      })
      .returning();
    return row!;
  }

  test('a second Component gets its own Build, not the primary’s', async () => {
    const { app, component, target } = await fixture();
    const primaryBuild = await succeededBuild(component.id, 10);
    const worker = await secondComponent(app.id, target.id);
    const workerUpload = await uploadedBundle(worker.id, 11);

    const result = await deployApp(
      { name: app.name, component: worker.name },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing was deployable yet for `worker`, so this is the Build-starting
    // act, not the deploy one.
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.deployId).toBeNull();

    const [started] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(started?.componentId).toBe(worker.id);
    // Its own row, not the one its bundle came off: a rerun writes a new Build
    // keyed by when it was asked for.
    expect(started?.id).not.toBe(workerUpload.id);

    // The primary's own Build is untouched — a different Component's deploy
    // wrote nothing onto it.
    const primaryRows = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(primaryRows).toEqual([primaryBuild]);
  });

  test('a named second Component with an artifact gets its own Deploy, not the primary’s', async () => {
    const { app, component, target } = await fixture();
    await succeededBuild(component.id, 11);
    const worker = await secondComponent(app.id, target.id);
    const workerBuild = await succeededBuild(worker.id, 12);

    const result = await deployApp(
      { name: app.name, component: worker.name },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('PENDING');
    expect(result.value.buildId).toBe(workerBuild.id);

    const [deploy] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId!));
    expect(deploy?.componentId).toBe(worker.id);

    // The primary Component gets no Deploy out of an intent aimed at `worker`.
    const primaryDeploys = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(primaryDeploys).toHaveLength(0);

    const desired = await desiredRow(worker.id, target.id);
    expect(desired?.desiredBuildId).toBe(workerBuild.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  test('an unknown Component name is refused, naming what the App actually has', async () => {
    const { app, component } = await fixture();

    const result = await deployApp(
      { name: app.name, component: 'no-such-component' },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('no-such-component');
    expect(result.failure.message).toContain(component.name);
  });

  /**
   * Placement is a fact `placeComponent` or a first deploy writes, so a
   * Component that has done neither has none to read back. Naming a Target is
   * how the first deploy writes it.
   */
  test('a first deploy names the Target that placement will remember', async () => {
    const { app, target } = await fixture();
    const db = database().db;
    const [nightly] = await db
      .insert(components)
      .values({
        appId: app.id,
        name: 'nightly',
        kind: 'job',
        reach: 'none',
        auth: 'none',
      })
      .returning();
    await uploadedBundle(nightly!.id, 15);

    const result = await deployApp(
      { name: app.name, component: nightly!.name, target: target.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');

    const desired = await desiredRow(nightly!.id, target.id);
    expect(desired).toBeDefined();
  });

  test('a Target that disagrees with existing placement is refused', async () => {
    const { app, component, target } = await fixture();
    await succeededBuild(component.id, 14);
    await database().db.insert(componentTargetDesired).values({
      componentId: component.id,
      targetId: target.id,
      updatedAt: FROZEN,
    });
    await database()
      .db.update(components)
      .set({ placedTargetId: target.id })
      .where(eq(components.id, component.id));
    const elsewhereVessel = await insertVessel(database().db, 'kubernetes', {
      name: `cluster-${crypto.randomUUID()}`,
    });
    const [elsewhere] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'kubernetes',
          vesselId: elsewhereVessel.id,
          discovery: null,
        }),
      )
      .returning();

    const result = await deployApp(
      { name: app.name, target: elsewhere!.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toContain('placed elsewhere');
  });

  test('an unknown Target is refused by name', async () => {
    const { app } = await fixture();

    const result = await deployApp(
      { name: app.name, target: 'no-such-target' },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('no-such-target');
  });

  test('an absent Component still deploys the primary, unchanged', async () => {
    const { app, component, target } = await fixture();
    const build = await succeededBuild(component.id, 13);
    await database().db.insert(componentTargetDesired).values({
      componentId: component.id,
      targetId: target.id,
      updatedAt: FROZEN,
    });
    await database()
      .db.update(components)
      .set({ placedTargetId: target.id })
      .where(eq(components.id, component.id));

    const result = await deployApp(
      { name: app.name },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('PENDING');
    expect(result.value.buildId).toBe(build.id);

    const [deploy] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId!));
    expect(deploy?.componentId).toBe(component.id);
  });
});

describe('a move across shapes reaches the Build the refusal asks for (§3)', () => {
  /**
   * The remediation loop, end to end: a website with an image-shaped history
   * moves to static hosting, the deploy at the new placement refuses with
   * "this placement needs a rebuild", the rebuild stages a *files* Build —
   * the moved-to Target's shape, not the predecessor's — and deploying it is
   * admitted. Before the rerun arm derived shape from the placed Target it
   * inherited the predecessor's, so the Build this refusal prescribes was
   * unreachable from the Component it refused.
   */
  test('move, rebuild into files, deploy admitted', async () => {
    const { app, component, target } = await fixture({
      kind: 'website',
      reach: 'public',
      auth: 'none',
    });
    // Image-shaped history on a runtime Target, placed and built long enough
    // ago that the move below is unambiguously the newest placement.
    const before = new Date(FROZEN.getTime() - 60_000);
    await database().db.insert(componentTargetDesired).values({
      componentId: component.id,
      targetId: target.id,
      updatedAt: before,
    });
    const imageBuild = await succeededBuild(component.id, 70, 'image');
    await database()
      .db.update(builds)
      .set({ createdAt: before })
      .where(eq(builds.id, imageBuild.id));

    const staticVessel = await insertVessel(database().db, 'static', {
      name: `static-${crypto.randomUUID()}`,
    });
    const [staticTarget] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'static',
          vesselId: staticVessel.id,
          discovery: null,
        }),
      )
      .returning();
    const ctx = context(
      registryOf(
        new FakeDeployAdapter({ adapter: 'static', artifactTypes: ['files'] }),
      ),
    );

    // The move commits, and commits the row `deployApp` reads as placement.
    const moved = await placeComponent(
      { componentId: component.id, targetId: staticTarget!.id, supply: [] },
      ctx,
    );
    expect(moved.ok).toBe(true);
    expect(await desiredRow(component.id, staticTarget!.id)).toBeDefined();

    // The button now acts on the new placement, and refuses with the exact
    // remediation the rest of this test follows.
    const refused = await deployApp({ name: app.name }, ctx);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_DEPLOYABLE');
    expect(refused.failure.message).toContain('needs a rebuild');

    // Following it: the rebuild stages a Build of the *new* Target's shape.
    const rebuilt = await deployApp({ name: app.name, rebuild: true }, ctx);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.phase).toBe('BUILDING');
    const [staged] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, rebuilt.value.buildId));
    expect(staged?.targetShape).toBe('files');
    expect(staged?.artifactType).toBe('files');

    // The build loop finishing is not under test; a finished files artifact is.
    await database()
      .db.update(builds)
      .set({
        status: 'SUCCEEDED',
        artifactDigest: digest(71),
        artifactRefs: ['https://shop.static.test/site'],
      })
      .where(eq(builds.id, rebuilt.value.buildId));

    const admitted = await deployApp({ name: app.name }, ctx);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.phase).toBe('PENDING');
    expect(admitted.value.buildId).toBe(rebuilt.value.buildId);

    const desired = await desiredRow(component.id, staticTarget!.id);
    expect(desired?.desiredBuildId).toBe(rebuilt.value.buildId);
  });
});

describe('concurrency: the locking read (§6)', () => {
  /**
   * The load-bearing test, and the reason the harness hands out a second
   * session.
   *
   * §6 rests correctness on "a **locking read** on the desired row", and the
   * honest way to assert a lock is to **hold it from another session and watch
   * the command stop**. Firing two commands with `Promise.all` does not do that:
   * it passes whether or not the `FOR UPDATE` is there, because nothing forces
   * the two transactions to overlap. This test forces it — the row is locked
   * before `createDeploy` is called and released only after we have observed it
   * blocked — so deleting the `FOR UPDATE` makes it fail.
   */
  test('an intent waits for whoever holds the desired row', async () => {
    const { component, target } = await fixture();
    const first = await succeededBuild(component.id, 60);
    const second = await succeededBuild(component.id, 61);
    const registry = registryOf(capableAdapter());

    // The desired row has to exist before it can be locked.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: first.id },
      context(registry),
    );

    const other = database().connect();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = other.begin(async (tx: typeof other) => {
      await tx.unsafe(
        'select * from component_target_desired where component_id = $1 and target_id = $2 for update',
        [component.id, target.id],
      );
      await held;
    });

    // Give the holder time to actually take the lock before contending.
    await Bun.sleep(100);

    let settled = false;
    const contending = createDeploy(
      { componentId: component.id, targetId: target.id, buildId: second.id },
      context(registry),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Bun.sleep(400);
    // The claim: it is *stopped*, not merely slow-and-lucky. Without the
    // locking read this command would have committed by now.
    expect(settled).toBe(false);

    release();
    await holding;

    const result = await contending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Having waited, it read the committed state rather than the stale one.
    expect(result.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  /**
   * The check-and-set itself, with the interleaving pinned.
   *
   * The previous test proves a contending intent *waits*; it does not prove the
   * `FOR UPDATE` is what makes it wait, because the closing `UPDATE` takes a row
   * lock too and would block a second transaction anyway. What only the locking
   * read gives is **what the second transaction reads**: without it, both read
   * the desired row before either commits, both see the same stale value, and
   * the second one's answer about what it superseded is a lie that the row it
   * finally writes does not contradict.
   *
   * So this test holds the first transaction open *past its read* — using the
   * guard, which runs under the lock — starts the second, and asserts the second
   * saw the first's write. Deleting `.for('update')` fails it.
   */
  test('the second intent reads what the first wrote, not what preceded it', async () => {
    const { component, target } = await fixture();
    const existing = await succeededBuild(component.id, 69);
    const first = await succeededBuild(component.id, 70);
    const second = await succeededBuild(component.id, 71);
    const registry = registryOf(capableAdapter());

    // The desired row must already exist and be committed. If the two intents
    // below were both its first writer they would serialize on its unique index
    // instead — which is correct behaviour, but it is not the locking read, and
    // a test that cannot tell them apart proves nothing about `FOR UPDATE`.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: existing.id },
      context(registry),
    );

    const preconditions = {
      componentId: component.id,
      targetId: target.id,
      // Nothing is configured here, and the empty document still has a version
      // (§10) — "no config" is a state a Deploy is pinned to like any other.
      configVersion: await configVersionOf([]),
      desired: aDesiredDocument({ reach: 'private', auth: 'proxy' }),
    };

    let announceRead = (): void => {};
    const hasRead = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    // First intent: enters the transaction, takes the lock, reads — and then
    // stops inside the guard, still holding everything.
    const holding = placeIntent(
      context(registry),
      { ...preconditions, buildId: first.id },
      async () => {
        announceRead();
        await released;
        return null;
      },
    );

    await hasRead;

    // Second intent, started while the first is provably mid-transaction.
    const contending = createDeploy(
      { componentId: component.id, targetId: target.id, buildId: second.id },
      context(registry),
    );

    // Long enough that an unlocked read would certainly have happened by now.
    await Bun.sleep(300);
    release();

    const [a, b] = await Promise.all([holding, contending]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // The first superseded what was already there; the second superseded the
    // first. That pair is only reachable if the second's read happened after the
    // first's commit — without the locking read, both read `existing` and the
    // second's answer is stale.
    expect(a.value.supersededBuildId).toBe(existing.id);
    expect(b.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(b.value.deployId);
  });

  test('two concurrent deploys of one Component@Target serialize', async () => {
    // The claim under test is that the desired row ends up describing *one* of
    // the two intents completely — same Build, same Deploy — rather than a torn
    // pair where one command's Build is left beside the other's Deploy. Only
    // two real sessions contending on one row can produce the torn state, which
    // is why this test is worth its Postgres.
    const { component, target } = await fixture();
    const first = await succeededBuild(component.id, 10);
    const second = await succeededBuild(component.id, 11);

    const registry = registryOf(capableAdapter());
    const [a, b] = await Promise.all([
      createDeploy(
        { componentId: component.id, targetId: target.id, buildId: first.id },
        context(registry),
      ),
      createDeploy(
        { componentId: component.id, targetId: target.id, buildId: second.id },
        context(registry),
      ),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Both intents exist — neither was lost, and neither was refused.
    const rows = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(rows).toHaveLength(2);

    const desired = await desiredRow(component.id, target.id);
    const winner = [a.value, b.value].find(
      (value) => value.deployId === desired?.desiredDeployId,
    );
    // The pair is consistent: the desired Build is the one that winning intent
    // named. A lost update would leave the other command's Build here.
    expect(winner).toBeDefined();
    expect(desired?.desiredBuildId).toBe(winner!.buildId);

    // Exactly one of them saw the other's write, which is what serialization
    // means: the loser ran second and read the winner's row under the lock.
    const superseded = [a.value, b.value].map((v) => v.supersededBuildId);
    expect(superseded.filter((value) => value === null)).toHaveLength(1);
    expect(superseded.filter((value) => value !== null)).toHaveLength(1);
  });
});

describe('§4: a late-finishing older build moves nothing', () => {
  test('finishing an older Build leaves the desired row alone', async () => {
    const { app, component, target } = await fixture();
    const older = await succeededBuild(component.id, 20);
    const newer = await succeededBuild(component.id, 21);

    // The newer artifact is what should be live here.
    const deployed = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registryOf(capableAdapter())),
    );
    expect(deployed.ok).toBe(true);

    const before = await desiredRow(component.id, target.id);

    // Now the older build finishes — late, as §4 allows. It records an artifact
    // and that is the whole of its effect.
    await database()
      .db.update(builds)
      .set({ status: 'PENDING', artifactDigest: null })
      .where(eq(builds.id, older.id));
    const builder = new FakeBuildAdapter({
      script: [{ result: { status: 'SUCCEEDED', digest: digest(20) } }],
    });
    const finished = await dispatchBuild(
      { buildId: older.id, route: builder.name },
      context(registryOf(capableAdapter(), builder)),
    );

    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.value.status).toBe('SUCCEEDED');

    const after = await desiredRow(component.id, target.id);
    expect(after?.desiredBuildId).toBe(before!.desiredBuildId!);
    expect(after?.desiredDeployId).toBe(before!.desiredDeployId!);

    // And no second Deploy appeared for the App as a side effect.
    const all = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(all).toHaveLength(1);
    expect(app.id).toBeDefined();
  });
});

describe('§6: rollback is an ordinary deploy', () => {
  test('it places an older Build and dispatches nothing', async () => {
    const { component, target } = await fixture();
    const older = await succeededBuild(component.id, 30);
    const newer = await succeededBuild(component.id, 31);

    // The build registry throws if consulted — see `registryOf`.
    const registry = registryOf(capableAdapter());

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registry),
    );

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );

    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    // A newer intent row pointing at an older Build — §6's definition, verbatim.
    expect(rolled.value.buildId).toBe(older.id);
    expect(rolled.value.supersededBuildId).toBe(newer.id);
    expect(rolled.value.phase).toBe('PENDING');

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(older.id);
    expect(desired?.desiredDeployId).toBe(rolled.value.deployId);

    // Three intents, one per act. Rollback made a Deploy like any other.
    const all = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(all).toHaveLength(3);
  });

  test('a "rollback" to a newer Build is refused as the typo it is', async () => {
    const { component, target } = await fixture();
    const older = await succeededBuild(component.id, 40);
    const newer = await succeededBuild(component.id, 41);
    const registry = registryOf(capableAdapter());

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registry),
    );

    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.code).toBe('NOT_DEPLOYABLE');
    expect(rolled.failure.message).toContain('older');

    // The refusal wrote nothing: the desired row still names the first intent.
    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(older.id);
  });

  test('rolling back where nothing was ever deployed is refused', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 50);

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.message).toContain('nothing has been deployed');
  });

  test('rollback cannot bypass the Target’s current build policy', async () => {
    const { component, target, label } = await fixture();
    const older = await succeededBuild(component.id, 42);
    const newer = await succeededBuild(component.id, 43, 'image', 3);
    const deployed = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registryOf(capableAdapter())),
    );
    expect(deployed.ok).toBe(true);

    await database()
      .db.update(targets)
      .set({ minBuildLevel: 3 })
      .where(eq(targets.id, target.id));

    expect(
      await rollbackDeploy(
        { componentId: component.id, targetId: target.id, buildId: older.id },
        context(registryOf(capableAdapter())),
      ),
    ).toEqual({
      ok: false,
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `Build ${older.id} achieved verified Build Level 2, and ${label} currently requires L3`,
      },
    });
  });
});

describe('§4: an uploaded artifact is recorded, never built', () => {
  test('a finished bundle becomes a SUCCEEDED Build with no builder invoked', async () => {
    const { component, target } = await fixture({ kind: 'website' });

    // The registry's `build()` throws. If uploading finished output so much as
    // looked for a route, this test fails rather than passing quietly.
    const result = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(60),
        location: 'https://depot.lolwtf.ca/bundles/shop-web/60.zip',
        contents: 'artifact',
        subpath: '.',
      },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('SUCCEEDED');
    expect(result.value.artifactType).toBe('files');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    // §16: the digest is over the uploaded bundle, and it is what names the
    // artifact — one digest, so the receipt and the provenance have a join.
    expect(row?.artifactDigest).toBe(digest(60));
    expect(row?.bundleDigest).toBe(digest(60));
    // §4: the backend and its fidelity are visible on the Build. There was no
    // backend, and saying so beats naming a runner that never ran.
    expect(row?.runner).toBeNull();
    expect(row?.logFidelity).toBeNull();
  });

  test('an uploaded source bundle waits for a route instead', async () => {
    const { component, target } = await fixture();

    const result = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(61),
        location: 'https://depot.lolwtf.ca/bundles/shop-web/61.zip',
        contents: 'source',
        subpath: '.',
      },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('PENDING');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    // Staged, digested, and not yet an artifact — §4's other arm.
    expect(row?.bundleDigest).toBe(digest(61));
    expect(row?.artifactDigest).toBeNull();
  });

  test('a source bundle reaches its builder with the location it was staged at', async () => {
    // The bug this pins: the staged location was only kept on the supplied arm,
    // so every source upload handed its route an empty location — a build that
    // cannot fetch what it is building, with nothing saying so.
    const { component, target } = await fixture();
    const builder = new FakeBuildAdapter();
    const registry = registryOf(capableAdapter(), builder);

    const uploaded = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(63),
        location: 'https://depot.lolwtf.ca/bundles/shop-web/63.zip',
        contents: 'source',
        subpath: 'apps/web',
      },
      context(registry),
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const dispatched = await dispatchBuild(
      { buildId: uploaded.value.buildId, route: builder.name },
      context(registry),
    );
    expect(dispatched.ok).toBe(true);

    expect(builder.built).toHaveLength(1);
    const origin = builder.built[0]!.source.origin;
    expect(origin.type).toBe('archive');
    if (origin.type !== 'archive') return;
    expect(origin.location).toBe(
      'https://depot.lolwtf.ca/bundles/shop-web/63.zip',
    );
    // §5's scope, per Build: the unwrap is a fact about the uploaded bytes.
    expect(origin.subpath).toBe('apps/web');
    // §16's join reaches the route on every path.
    expect(builder.built[0]!.source.bundleDigest).toBe(digest(63));
  });

  test('a Build with no staged bundle is refused rather than dispatched empty', async () => {
    const { component } = await fixture();
    const [orphan] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(64),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(64),
        status: 'PENDING',
      })
      .returning();

    const builder = new FakeBuildAdapter();
    const result = await dispatchBuild(
      { buildId: orphan!.id, route: builder.name },
      context(registryOf(capableAdapter(), builder)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(builder.built).toHaveLength(0);
  });

  test('re-uploading identical bytes lands on the same Build', async () => {
    // §2 keys a Build on (component, commit, target-shape), and for an upload
    // the bundle digest is the commit. Identical bytes are the same input, so
    // they are the same row rather than two rows meaning one thing.
    const { component, target } = await fixture({ kind: 'website' });
    const input = {
      componentId: component.id,
      targetId: target.id,
      bundleDigest: digest(62),
      location: 'https://depot.lolwtf.ca/bundles/shop-web/62.zip',
      contents: 'artifact' as const,
      subpath: '.',
    };
    const registry = registryOf(capableAdapter());

    const first = await uploadArchive(input, context(registry));
    const second = await uploadArchive(input, context(registry));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.buildId).toBe(first.value.buildId);

    // And the second upload changed nothing. The bug this pins: an upsert that
    // wrote on conflict blanked the artifact refs of a Build that had already
    // succeeded — a finished artifact quietly losing the address it is pulled by.
    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, first.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.artifactDigest).toBe(digest(62));
    expect(row?.artifactRefs).toEqual([
      'https://depot.lolwtf.ca/bundles/shop-web/62.zip',
    ]);
  });

  test('a source re-upload cannot blank a Build that already succeeded', async () => {
    const { component, target } = await fixture({ kind: 'website' });
    const registry = registryOf(capableAdapter());
    const common = {
      componentId: component.id,
      targetId: target.id,
      bundleDigest: digest(65),
      location: 'https://depot.lolwtf.ca/bundles/shop-web/65.zip',
      subpath: '.',
    };

    const supplied = await uploadArchive(
      { ...common, contents: 'artifact' as const },
      context(registry),
    );
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;

    // Same bytes, now claimed to be source. The key is identical, so it lands on
    // the same row — which must not be demoted out from under a live Deploy.
    await uploadArchive(
      { ...common, contents: 'source' as const },
      context(registry),
    );

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, supplied.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.artifactDigest).toBe(digest(65));
    expect(row?.artifactRefs).toEqual([
      'https://depot.lolwtf.ca/bundles/shop-web/65.zip',
    ]);
  });
});

describe('§16: verify → sign → record is fail-closed', () => {
  test('a provenance refusal stores no artifact, signature, or success', async () => {
    const { component } = await fixture();
    const builder = new FakeBuildAdapter({
      script: [{ result: { status: 'SUCCEEDED', digest: digest(70) } }],
    });
    // Provenance verification refuses — no signature is ever produced.
    const supplyChain = new SupplyChainHarness(async () => ({
      ok: false,
      code: 'PROVENANCE_INVALID' as const,
      message: 'tampered provenance',
    }));
    const registry = registryOf(capableAdapter(), builder, supplyChain);

    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(70),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(70),
        bundleLocation: 'https://depot.lolwtf.ca/bundles/70.zip',
        status: 'PENDING',
      })
      .returning();

    const result = await dispatchBuild(
      { buildId: build!.id, route: builder.name },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('FAILED');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, build!.id));
    expect(row?.status).toBe('FAILED');
    expect(row?.artifactDigest).toBeNull();
    expect(row?.signature).toBeNull();
    expect(row?.verifiedBuildLevel).toBeNull();
    expect(supplyChain.signed).toHaveLength(0);
  });

  test('a signing failure stores no signature and no success', async () => {
    const { component } = await fixture();
    const builder = new FakeBuildAdapter({
      script: [{ result: { status: 'SUCCEEDED', digest: digest(71) } }],
    });
    // Provenance verifies, but the signer throws. Core must not record a
    // successful posture or a signature it never produced.
    const supplyChain = new SupplyChainHarness();
    supplyChain.signing.failure = new Error('KMS denied the signature');
    const registry = registryOf(capableAdapter(), builder, supplyChain);

    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(71),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(71),
        bundleLocation: 'https://depot.lolwtf.ca/bundles/71.zip',
        status: 'PENDING',
      })
      .returning();

    const result = await dispatchBuild(
      { buildId: build!.id, route: builder.name },
      context(registry),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('FAILED');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, build!.id));
    expect(row?.status).toBe('FAILED');
    expect(row?.signature).toBeNull();
    expect(row?.artifactDigest).toBeNull();
  });
});

describe('§11: an attached Datastore is pinned into the intent', () => {
  /** A managed Datastore in a Vessel, with or without a connection yet. */
  async function attach(
    appId: string,
    vesselId: string,
    engine: 'postgres' | 'valkey',
    connectionRef: string | null,
  ) {
    const [row] = await database()
      .db.insert(datastores)
      .values({
        name: `${engine}-store`,
        engine,
        provenance: 'managed',
        appId,
        vesselId,
        connectionRef,
      })
      .returning();
    return row!;
  }

  test('a Datastore with no connection yet refuses the release', async () => {
    // The operator has not generated the credential, so there is no reference
    // to render. Released anyway, the App comes up green with the variable it
    // was configured with missing — which is the state §10's config demand rule
    // exists to prevent, read for datastores.
    const { app, component, target } = await fixture();
    await attach(app.id, target.vesselId, 'postgres', null);
    const build = await succeededBuild(component.id, 80);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('postgres-store');
    expect(result.failure.message).toContain('provisioning');
    // Refused before the intent exists, so the loop has nothing to find.
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a Datastore in another Vessel refuses the release, and says which', async () => {
    // A `secretKeyRef` cannot leave the namespace it renders in, let alone the
    // cluster. Released anyway, the pod sits in CreateContainerConfigError and
    // the Deploy reports a timeout rather than the cause.
    const { app, component, target, label } = await fixture();
    const other = await insertVessel(database().db, 'kubernetes', {
      name: `cluster-${crypto.randomUUID()}`,
    });
    const [elsewhere] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'kubernetes',
          vesselId: other.id,
          discovery: null,
        }),
      )
      .returning();
    await attach(
      app.id,
      elsewhere!.vesselId,
      'postgres',
      'secret://spindrift-apps/postgres-store-app',
    );
    const build = await succeededBuild(component.id, 81);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain(label);
    expect(result.failure.message).toContain('postgres-store');
  });

  test('a Datastore is reachable from every surface of its vessel', async () => {
    // The comparison above is boundary to boundary, and this is the case that
    // proves it: a gcp-project vessel with two surfaces holds its Datastore
    // once, and a release onto the *other* surface can still reach it. Keyed
    // on a Target instead, this same release refuses — the drift §11's
    // boundary reading exists to prevent.
    const { app, component, target } = await fixture({
      kind: 'website',
      adapter: 'static',
      reach: 'public',
      auth: 'none',
    });
    // The vessel's second surface, where the engine actually runs. The
    // Datastore lives on the vessel either way, so this row is scenery — but
    // it is the scenery a surface-keyed comparison trips over.
    await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'cloudrun',
          vesselId: target.vesselId,
          discovery: null,
        }),
      );
    await attach(
      app.id,
      target.vesselId,
      'postgres',
      'secret://spindrift-apps/postgres-store-app',
    );
    const deployAdapter = new FakeDeployAdapter({
      adapter: 'static',
      artifactTypes: ['files'],
    });
    const ctx = context(registryOf(deployAdapter));
    const uploaded = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(83),
        location: 'https://depot.lolwtf.ca/bundles/shop/site.zip',
        contents: 'artifact',
        subpath: '.',
      },
      ctx,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const result = await createDeploy(
      {
        componentId: component.id,
        targetId: target.id,
        buildId: uploaded.value.buildId,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  test('the variable each engine is read through is fixed, and pinned resolved', async () => {
    // This is the assertion that fails if anyone renames the variables, makes
    // them settable, or routes a datastore back through `ConfigEntry` — which
    // would put a pinned version on a credential whose rotation the engine's
    // operator owns.
    const { app, component, target } = await fixture();
    await attach(
      app.id,
      target.vesselId,
      'postgres',
      'secret://spindrift-apps/postgres-store-app',
    );
    await attach(
      app.id,
      target.vesselId,
      'valkey',
      'redis://valkey-store.spindrift-apps.svc.cluster.local:6379',
    );
    const build = await succeededBuild(component.id, 82);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));
    expect(
      [...(row?.desired.datastores ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ).toEqual([
      {
        name: 'DATABASE_URL',
        connection: 'secret://spindrift-apps/postgres-store-app',
      },
      {
        name: 'REDIS_URL',
        connection:
          'redis://valkey-store.spindrift-apps.svc.cluster.local:6379',
      },
    ]);
  });

  test('an App with nothing attached pins the document it always pinned', async () => {
    // Absent, not an empty array: the field is optional so that a `desired`
    // written before §11's delivery existed reads back identically to one
    // written now, and nothing has to migrate.
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 83);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));
    expect(row?.desired.datastores).toBeUndefined();
  });
});
