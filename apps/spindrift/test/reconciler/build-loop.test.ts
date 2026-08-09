/**
 * Which placement `runBuildPass` binds a Build's dispatch to.
 *
 * A moved Component deliberately keeps the old pair's desired row until what
 * still serves there is retired, so a PENDING Build can join two placements.
 * The loop used to bind each Build to whichever Target ranked lowest — which,
 * after a move across shapes, is the *old* Target: the files Build the move's
 * own refusal prescribed was then routed and policy-checked against the image
 * Target it can never land on. These tests hold the loop to the Build's own
 * shape: bind to the newest desired row whose Target admits it, and where none
 * does, say so instead of dispatching anywhere.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  configItems,
  targets,
} from '../../src/db/schema.ts';
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

const BUNDLE_DIGEST = `sha256:${'c'.repeat(64)}`;

/** The build side registered under the fixture's `hosted` route name. */
function registryOf(route: FakeBuildAdapter): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === 'static'
        ? new FakeDeployAdapter({ adapter: 'static', artifactTypes: ['files'] })
        : adapter === 'kubernetes'
          ? new FakeDeployAdapter({ adapter: 'kubernetes' })
          : null,
    build: (name) => (name === 'hosted' ? route : null),
    store: () => new FakeSecretStore(),
    repository: () => null,
    supplyChain: () => new SupplyChainHarness(),
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

/** A website with image-shaped history on a runtime Target, moved to static. */
async function movedWebsite() {
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
      kind: 'website',
      expose: true,
      reach: 'public',
      auth: 'none',
    })
    .returning();

  const runtimeVessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [runtimeTarget] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: runtimeVessel.id,
        rank: 1,
        discovery: null,
      }),
    )
    .returning();

  const staticVessel = await insertVessel(db, 'static', {
    name: `static-${crypto.randomUUID()}`,
  });
  const [staticTarget] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'static',
        vesselId: staticVessel.id,
        rank: 2,
        discovery: null,
      }),
    )
    .returning();

  // The move's residue: the old pair's row survives so unplacement can retire
  // what still serves there, and the new pair's row is the newest — the
  // placement of record.
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: runtimeTarget!.id,
    updatedAt: new Date(FROZEN.getTime() - 60_000),
  });
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: staticTarget!.id,
    updatedAt: FROZEN,
  });

  // The rebuild the move remediation staged: a files Build, PENDING.
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      targetShape: 'files',
      artifactType: 'files',
      bundleDigest: BUNDLE_DIGEST,
      bundleLocation: 'https://depot.lolwtf.ca/bundles/site.zip',
      status: 'PENDING',
    })
    .returning();

  return {
    component: component!,
    runtimeTarget: runtimeTarget!,
    runtimeVessel,
    staticTarget: staticTarget!,
    build: build!,
  };
}

async function buildRow(buildId: number) {
  const [row] = await database()
    .db.select()
    .from(builds)
    .where(eq(builds.id, buildId));
  return row!;
}

describe('a rebuild staged by a move dispatches against the new placement', () => {
  test('the files Build binds to the static Target, not the lower-ranked image one', async () => {
    const { component, runtimeTarget, staticTarget, build } =
      await movedWebsite();
    const db = database().db;

    // The old Target's policy admits no configured route. Bound there, this
    // Build would sit PENDING behind that Target's threshold — so a dispatch
    // that succeeds is a dispatch whose route and policy were evaluated
    // against the new Target.
    await db
      .update(targets)
      .set({ minBuildLevel: 3 })
      .where(eq(targets.id, runtimeTarget.id));

    // A website's build arguments are read for the placement the dispatch
    // names, so a per-Target value pins which Target that was.
    await db.insert(configItems).values([
      {
        componentId: component.id,
        targetId: runtimeTarget.id,
        key: 'SITE_URL',
        kind: 'plain',
        plainValue: 'https://old.example.test',
      },
      {
        componentId: component.id,
        targetId: staticTarget.id,
        key: 'SITE_URL',
        kind: 'plain',
        plainValue: 'https://new.example.test',
      },
    ]);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(context(registryOf(route)))).toBe(1);

    expect((await buildRow(build.id)).status).toBe('SUCCEEDED');
    expect(route.built).toHaveLength(1);
    expect(route.built[0]?.spec.artifactType).toBe('files');
    expect(route.built[0]?.spec.buildArgs).toEqual({
      SITE_URL: 'https://new.example.test',
    });
  });

  test('a Build whose shape no placement takes waits and says so', async () => {
    const { runtimeTarget, runtimeVessel, staticTarget, build } =
      await movedWebsite();
    const db = database().db;

    // Retire the placement that admitted the shape, leaving only the image
    // Target. Binding the files Build there anyway would evaluate policy
    // against a Target the artifact can never land on.
    await db
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.targetId, staticTarget.id));

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(context(registryOf(route)))).toBe(0);

    const row = await buildRow(build.id);
    expect(row.status).toBe('PENDING');
    expect(route.built).toHaveLength(0);
    expect(row.dispatchWaitingOn).toContain('files');
    expect(row.dispatchWaitingOn).toContain(
      `${runtimeVessel.name}/${runtimeTarget.adapter} takes image`,
    );
  });
});
