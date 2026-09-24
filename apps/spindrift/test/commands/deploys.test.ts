// Two concurrent deploys of one Component@Target serialize under real Postgres
// sessions, a late older build moves nothing, and rollback dispatches no build.
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { uploadArchive } from '../../src/commands/apps/upload-archive.ts';
import {
  DISPATCH_LEASE_TIMEOUT_MS,
  dispatchBuild,
} from '../../src/commands/builds/dispatch.ts';
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
  repositories,
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

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/** `build()` throws unless a route is given, so a path that builds fails. */
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
    /** The column defaults to `private`; a `static` Target states `public`. */
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
    // Precomputed, since the row alone cannot render `<vessel>/<adapter>`.
    label: targetLabel({ vessel: vessel.name, adapter }),
  };
}

/** A Build that is ready to deploy: succeeded, with an artifact of one shape. */
async function succeededBuild(
  componentId: string,
  seed: number,
  shape: 'image' | 'files' | 'vercel-output' = 'image',
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
      // A Build with no staged bundle cannot be dispatched.
      bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel,
      // A signature the pinned verifier admits; a placeholder would be refused.
      signature: testSignature(digest(seed), FROZEN.toISOString()),
    })
    .returning();
  return build!;
}

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
    // The loop owns every phase after PENDING, so an intent has no adapter
    // handle.
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
    // A `files` artifact on a cluster needs a rebuild, caught before the far
    // side.
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

  test('an accepted non-preferred shape is admitted — files lands on Vercel', async () => {
    // The gate is membership in the adapter's accept list: Vercel prefers
    // `vercel-output` and still serves `files`.
    const { component, target } = await fixture({
      kind: 'website',
      adapter: 'vercel',
      reach: 'public',
      auth: 'none',
    });
    const build = await succeededBuild(component.id, 3, 'files');

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(
        registryOf(
          new FakeDeployAdapter({
            adapter: 'vercel',
            artifactTypes: ['vercel-output', 'files'],
          }),
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('PENDING');
  });

  test('the inverse still needs the rebuild — vercel-output on a files host', async () => {
    // A `vercel-output` tar is the Build Output API tree, which a bare files
    // host cannot serve.
    const { component, target } = await fixture({
      kind: 'website',
      adapter: 'static',
      reach: 'public',
      auth: 'none',
    });
    const build = await succeededBuild(component.id, 4, 'vercel-output');

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(
        registryOf(
          new FakeDeployAdapter({
            adapter: 'static',
            artifactTypes: ['files'],
          }),
        ),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('needs a rebuild');
  });

  test('a Component is refused at a reach its Target does not assert', async () => {
    // Placement filtered this Target out, and the release asks again.
    const { component, target, label } = await fixture();
    // `auth: 'none'` so only reach is refused.
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

    // Rollback shares the gate, so no intent can release at that reach.
    const rolled = await rollbackDeploy(
      intent,
      context(registryOf(capableAdapter())),
    );
    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.message).toContain(
      'no way to serve a public address',
    );

    // The gate reads the asserted column, so once the operator states the
    // tunnel the call goes through.
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
    // The Target serves `public` once the tunnel is stated, but authenticates
    // only `private`.
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
      // Static hosting offers only a public address with no auth.
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
      // Static hosting offers only a public address with no auth.
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
    // A files artifact has no image signature to verify.
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
  // A `job` beside the fixture's `service`, placed on the fixture's Target so
  // desiredTargets resolves `targetId`.
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

  // An archive's bytes are held per Component, so the sibling needs its own
  // upload. FAILED, so the press still starts a Build.
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
    // Nothing was deployable yet, so this starts a Build.
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.deployId).toBeNull();

    const [started] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(started?.componentId).toBe(worker.id);
    // A rerun writes a new Build row.
    expect(started?.id).not.toBe(workerUpload.id);

    // The primary's own Build is untouched.
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

  // Only placeComponent or a first deploy writes placement, so this one names
  // the Target.
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
  // A website moves from an image Target to static hosting, the refusal asks
  // for a rebuild, and the rebuild stages the new Target's `files` shape.
  test('move, rebuild into files, deploy admitted', async () => {
    const { app, component, target } = await fixture({
      kind: 'website',
      reach: 'public',
      auth: 'none',
    });
    // Built earlier, so the move below is the newest placement.
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

    // The button acts on the new placement and refuses with the remediation.
    const refused = await deployApp({ name: app.name }, ctx);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_DEPLOYABLE');
    expect(refused.failure.message).toContain('needs a rebuild');

    // The rebuild stages a Build of the new Target's shape.
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

// Re-arming a RUNNING Build with a live lease would revoke its claim without
// stopping the generator, so a live lease is refused and an expired one is not.
describe('deployApp will not re-arm a Build a runner still holds', () => {
  // `createdAt` and `leasedAt` are relative to `FROZEN`: the lease check reads
  // the command clock, and the database defaults to wall time.
  async function inFlightBuild(
    componentId: string,
    seed: number,
    status: 'PENDING' | 'RUNNING',
    leasedAt: Date | null,
  ) {
    const [row] = await database()
      .db.insert(builds)
      .values({
        componentId,
        commit: digest(seed),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(seed),
        bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
        status,
        // dispatchBuild writes the claim with RUNNING; a PENDING row never has
        // one.
        dispatchId: leasedAt === null ? null : `dispatch-${seed}`,
        leasedAt,
        runner: leasedAt === null ? null : 'hosted',
        logFidelity: leasedAt === null ? null : 'LIVE_TEXT',
        createdAt: new Date(FROZEN.getTime() - 60_000),
      })
      .returning();
    return row!;
  }

  /** The fixture's Component, placed, so the press resolves a Target. */
  async function placedFixture() {
    const seeded = await fixture();
    await database()
      .db.update(components)
      .set({ placedTargetId: seeded.target.id })
      .where(eq(components.id, seeded.component.id));
    return seeded;
  }

  async function buildRow(id: number) {
    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, id));
    return row;
  }

  // The same fixture as a repo App at `commit`. The repository row names that
  // commit too, since sourceForRerun reads `authoritative_commit`.
  async function pushedFixture(commit: string) {
    const seeded = await placedFixture();
    const [repository] = await database()
      .db.insert(repositories)
      .values({
        fullName: `example/${crypto.randomUUID()}`,
        // TEXT: the far side's numeric id is an opaque handle here.
        installationId: '42',
        defaultBranch: 'main',
        authoritativeCommit: commit,
      })
      .returning();
    await database()
      .db.update(apps)
      .set({
        sourceKind: 'repo',
        sourceRepoUrl: `https://git.invalid/${repository!.fullName}`,
        repositoryId: repository!.id,
      })
      .where(eq(apps.id, seeded.app.id));
    return { ...seeded, repository: repository! };
  }

  // Runs `claim` to completion just before the command's first UPDATE, the
  // reset, so a competing claim commits between its read and its write.
  function claimingBeforeItsFirstWrite(
    db: CommandContext['db'],
    claim: () => Promise<unknown>,
  ): CommandContext['db'] {
    let armed = true;
    const fire = async (): Promise<void> => {
      if (!armed) return;
      armed = false;
      await claim();
    };
    // Drizzle builders are lazy and run when awaited, so the wrap hooks `then`.
    const deferring = <T extends object>(builder: T): T =>
      new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (typeof value !== 'function') return value;
          const method = value as (...args: unknown[]) => unknown;
          if (property === 'then') {
            return (...args: unknown[]) =>
              fire().then(() => method.apply(target, args));
          }
          return (...args: unknown[]) => {
            const next = method.apply(target, args);
            return typeof next === 'object' && next !== null
              ? deferring(next)
              : next;
          };
        },
      });
    return new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        return property === 'update'
          ? (...args: unknown[]) =>
              deferring(method.apply(target, args) as object)
          : method.bind(target);
      },
    });
  }

  test('a RUNNING Build under a live lease is refused, and keeps its lease', async () => {
    const { app, component, target } = await placedFixture();
    const running = await inFlightBuild(component.id, 80, 'RUNNING', FROZEN);

    const result = await deployApp(
      { name: app.name },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    // The remedy is about the Build holding the press off, so it is named.
    expect(result.failure.message).toContain(`Build ${running.id}`);

    // The claim must survive the refusal, or the loop dispatches a second
    // generator.
    const row = await buildRow(running.id);
    expect(row?.status).toBe('RUNNING');
    expect(row?.dispatchId).toBe('dispatch-80');
    expect(row?.leasedAt?.getTime()).toBe(FROZEN.getTime());

    // Refused before any write: no second Build and no desired row.
    const rows = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(rows).toHaveLength(1);
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a RUNNING Build whose lease has expired is reclaimed, not refused', async () => {
    const { app, component, target } = await placedFixture();
    // A second past the cutoff, clear of the boundary.
    const expired = new Date(
      FROZEN.getTime() - DISPATCH_LEASE_TIMEOUT_MS - 1_000,
    );
    const stale = await inFlightBuild(component.id, 81, 'RUNNING', expired);

    const result = await deployApp(
      { name: app.name },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.deployId).toBeNull();
    // The same row, re-armed, not a new Build.
    expect(result.value.buildId).toBe(stale.id);

    // A runner that died leaves a RUNNING row nobody holds, and the press frees
    // it.
    const row = await buildRow(stale.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.dispatchId).toBeNull();
    expect(row?.leasedAt).toBeNull();
    expect(row?.runner).toBeNull();
    expect(row?.logFidelity).toBeNull();

    expect(await desiredRow(component.id, target.id)).toBeDefined();
  });

  test('a PENDING Build is still re-armed — it never had a lease to revoke', async () => {
    const { app, component, target } = await placedFixture();
    const queued = await inFlightBuild(component.id, 82, 'PENDING', null);

    const result = await deployApp(
      { name: app.name },
      context(registryOf(capableAdapter())),
    );

    // The fence keys on RUNNING under a live lease. A queued Build has no
    // generator streaming into it.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.buildId).toBe(queued.id);

    const row = await buildRow(queued.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.dispatchId).toBeNull();
    expect(row?.leasedAt).toBeNull();

    // Re-armed, not re-staged: the press wrote no second Build row.
    const rows = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(rows).toHaveLength(1);
    expect(await desiredRow(component.id, target.id)).toBeDefined();
  });

  test('a push whose runner died reclaims the Build rather than reporting it as building', async () => {
    // `inFlightBuild` sets the commit to `digest(seed)`, so the push and the
    // dead Build share one.
    const commit = digest(83);
    const { app, component, target } = await pushedFixture(commit);
    const dead = await inFlightBuild(
      component.id,
      83,
      'RUNNING',
      // A lease nobody renewed, a second past the cutoff: a runner that died.
      new Date(FROZEN.getTime() - DISPATCH_LEASE_TIMEOUT_MS - 1_000),
    );

    const result = await deployApp(
      { name: app.name, commit },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Requeued, not re-staged: its bundle was staged for this commit.
    expect(result.value.buildId).toBe(dead.id);

    // runBuildPass selects only PENDING rows, so the reset arm is the only
    // reclaimer of a dead RUNNING row.
    const row = await buildRow(dead.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.dispatchId).toBeNull();
    expect(row?.leasedAt).toBeNull();
    expect(row?.runner).toBeNull();
    expect(row?.logFidelity).toBeNull();

    const rows = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(rows).toHaveLength(1);
    // The loop needs the desired row to dispatch the reclaimed Build.
    expect(await desiredRow(component.id, target.id)).toBeDefined();
  });

  test('a push whose Build is genuinely in flight waits for it', async () => {
    const commit = digest(84);
    const { app, component, target } = await pushedFixture(commit);
    const live = await inFlightBuild(component.id, 84, 'RUNNING', FROZEN);

    const result = await deployApp(
      { name: app.name, commit },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.deployId).toBeNull();
    expect(result.value.buildId).toBe(live.id);

    // A generator is streaming into this attempt, so the row is untouched.
    const row = await buildRow(live.id);
    expect(row?.status).toBe('RUNNING');
    expect(row?.dispatchId).toBe('dispatch-84');
    expect(row?.leasedAt?.getTime()).toBe(FROZEN.getTime());
    expect(row?.runner).toBe('hosted');
    expect(row?.logFidelity).toBe('LIVE_TEXT');

    // Nothing was written, not even the desired row.
    const rows = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(rows).toHaveLength(1);
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a claim that lands after the command read the row is not clobbered', async () => {
    const { app, component, target } = await placedFixture();
    // Queued, so the command's opening read sees no lease.
    const queued = await inFlightBuild(component.id, 85, 'PENDING', null);

    // dispatchBuild claims the row after the command reads it and before it
    // writes.
    const racing = claimingBeforeItsFirstWrite(database().db, () =>
      database()
        .db.update(builds)
        .set({
          status: 'RUNNING',
          dispatchId: 'dispatch-85',
          leasedAt: FROZEN,
          runner: 'hosted',
          logFidelity: 'LIVE_TEXT',
        })
        .where(eq(builds.id, queued.id)),
    );

    const result = await deployApp(
      { name: app.name },
      { ...context(registryOf(capableAdapter())), db: racing },
    );

    // Had the claim committed after the reset, the press would have succeeded.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain(`Build ${queued.id}`);

    // The condition lives in the UPDATE's WHERE, so zero rows matched is the
    // refusal.
    const row = await buildRow(queued.id);
    expect(row?.status).toBe('RUNNING');
    expect(row?.dispatchId).toBe('dispatch-85');
    expect(row?.leasedAt?.getTime()).toBe(FROZEN.getTime());
    expect(row?.runner).toBe('hosted');
    expect(row?.logFidelity).toBe('LIVE_TEXT');

    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });
});

describe('concurrency: the locking read (§6)', () => {
  // The row is locked from another session before createDeploy runs, so
  // dropping FOR UPDATE fails this; a Promise.all race would pass either way.
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

    // Give the holder time to take the lock before contending.
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
    // Stopped, not slow: without the locking read it would have committed.
    expect(settled).toBe(false);

    release();
    await holding;

    const result = await contending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Having waited, it read the committed state, not the stale one.
    expect(result.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  // The closing UPDATE's row lock would block a second transaction anyway. Only
  // the locking read makes the second read what the first wrote.
  test('the second intent reads what the first wrote, not what preceded it', async () => {
    const { component, target } = await fixture();
    const existing = await succeededBuild(component.id, 69);
    const first = await succeededBuild(component.id, 70);
    const second = await succeededBuild(component.id, 71);
    const registry = registryOf(capableAdapter());

    // Committed first, so the intents below serialize on the lock, not on the
    // unique index.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: existing.id },
      context(registry),
    );

    const preconditions = {
      componentId: component.id,
      targetId: target.id,
      // An empty config document still has a version.
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

    // Takes the lock, reads, then stops inside the guard.
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

    // Only reachable if the second read after the first committed.
    expect(a.value.supersededBuildId).toBe(existing.id);
    expect(b.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(b.value.deployId);
  });

  test('two concurrent deploys of one Component@Target serialize', async () => {
    // The desired row must describe one intent whole, never one command's Build
    // beside the other's Deploy.
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
    // The desired Build is the one the winning intent named.
    expect(winner).toBeDefined();
    expect(desired?.desiredBuildId).toBe(winner!.buildId);

    // Exactly one saw the other's write, having read it under the lock.
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

    // The older build finishes late, and records an artifact only.
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
    // A newer intent pointing at an older Build.
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

    // The registry's `build()` throws, so an upload that looked for a route
    // fails.
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
    // One digest names both the artifact and the uploaded bundle.
    expect(row?.artifactDigest).toBe(digest(60));
    expect(row?.bundleDigest).toBe(digest(60));
    // No backend ran, so none is named.
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
    // Staged and digested, not yet an artifact.
    expect(row?.bundleDigest).toBe(digest(61));
    expect(row?.artifactDigest).toBeNull();
  });

  test('a source bundle reaches its builder with the location it was staged at', async () => {
    // The route needs the staged location to fetch the source.
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
    // The unwrap subpath is a fact about the uploaded bytes.
    expect(origin.subpath).toBe('apps/web');
    // The bundle digest reaches the route on every path.
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
    // For an upload the bundle digest is the commit, so identical bytes are one
    // Build.
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

    // The second upload must not blank a succeeded Build's artifact refs.
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

    // Same key, so the same row, which must not be demoted under a live Deploy.
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
    // The signer throws, so no signature or successful posture may be recorded.
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
    // With no credential there is no reference to render, and the App would
    // come up without the variable.
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
    // A `secretKeyRef` cannot leave its namespace, so the pod would sit in
    // CreateContainerConfigError.
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
    // A vessel with two surfaces holds its Datastore once, so a release onto
    // either surface reaches it.
    const { app, component, target } = await fixture({
      kind: 'website',
      adapter: 'static',
      reach: 'public',
      auth: 'none',
    });
    // The vessel's second surface, where the engine runs.
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
    // The engine's operator owns credential rotation, so these variables are
    // fixed and never config entries.
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
    // Absent, not empty, so a `desired` written before datastores reads back
    // the same.
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
