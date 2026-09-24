/**
 * `runBuildPass` binds each Build to `components.placedTargetId`, because a
 * moved Component keeps its old desired row until what serves there is retired.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  componentTargetDesired,
  configItems,
  targets,
} from '../../src/db/schema.ts';
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import { reconcilerAttemptDuration } from '../../src/telemetry/index.ts';
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

/** Registers `route` under the fixture's `hosted` build route name. */
function registryOf(route: FakeBuildAdapter): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === 'static'
        ? new FakeDeployAdapter({ adapter: 'static', artifactTypes: ['files'] })
        : adapter === 'vercel'
          ? new FakeDeployAdapter({
              adapter: 'vercel',
              artifactTypes: ['vercel-output', 'files'],
            })
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

  // After the move both desired rows remain, and `placedTargetId` names the
  // static Target.
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
  await db
    .update(components)
    .set({ placedTargetId: staticTarget!.id })
    .where(eq(components.id, component!.id));

  // The files rebuild the move staged.
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

    // No configured route meets the old Target's policy, so a dispatch that
    // succeeds was checked against the new Target.
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

  test('a files Build placed on Vercel dispatches — the accept list, not the preferred shape', async () => {
    // Vercel prefers `vercel-output` for a website but also serves `files`, so
    // a `files` Build staged before the move still dispatches.
    const { component, staticTarget, build } = await movedWebsite();
    const db = database().db;

    const vercelVessel = await insertVessel(db, 'vercel', {
      name: `vercel-${crypto.randomUUID()}`,
    });
    const [vercelTarget] = await db
      .insert(targets)
      .values(
        targetValues({
          adapter: 'vercel',
          vesselId: vercelVessel.id,
          rank: 3,
          discovery: null,
        }),
      )
      .returning();
    await db
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.targetId, staticTarget.id));
    await db
      .update(components)
      .set({ placedTargetId: vercelTarget!.id })
      .where(eq(components.id, component.id));
    await db.insert(componentTargetDesired).values({
      componentId: component.id,
      targetId: vercelTarget!.id,
      updatedAt: FROZEN,
    });

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(context(registryOf(route)))).toBe(1);

    expect((await buildRow(build.id)).status).toBe('SUCCEEDED');
    expect(route.built).toHaveLength(1);
    expect(route.built[0]?.spec.artifactType).toBe('files');
  });

  test('a Build whose shape the placement of record does not take fails and says so', async () => {
    const { component, runtimeTarget, runtimeVessel, staticTarget, build } =
      await movedWebsite();
    const db = database().db;

    // Back on the image Target, no placement the Component holds takes the
    // files Build.
    await db
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.targetId, staticTarget.id));
    await db
      .update(components)
      .set({ placedTargetId: runtimeTarget.id })
      .where(eq(components.id, component.id));

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(context(registryOf(route)))).toBe(0);

    const row = await buildRow(build.id);
    // No configuration makes this row legal, so it fails, and `deployApp`
    // stages the rebuild once it is terminal.
    expect(row.status).toBe('FAILED');
    expect(route.built).toHaveLength(0);
    expect(row.dispatchWaitingOn).toBeNull();

    // A failed row carries no waiting sentence, so the reason goes to the
    // attempt log.
    const log = await db
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, build.id));
    const said = log.map((event) => event.line ?? '').join('\n');
    expect(said).toContain('files');
    expect(said).toContain(
      `${runtimeVessel.name}/${runtimeTarget.adapter} takes image`,
    );
    expect(log.some((event) => event.phase === 'FAILED')).toBe(true);
  });

  test('an unplaced Component’s Build waits and says so', async () => {
    const { component, build } = await movedWebsite();
    const db = database().db;

    // The desired rows that remain are what still serves, never a place to
    // bind a Build.
    await db
      .update(components)
      .set({ placedTargetId: null })
      .where(eq(components.id, component.id));

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(context(registryOf(route)))).toBe(0);

    const row = await buildRow(build.id);
    expect(row.status).toBe('PENDING');
    expect(route.built).toHaveLength(0);
    expect(row.dispatchWaitingOn).toContain('placed on no Target');
  });
});

describe('the attempt histogram', () => {
  /** The outcome labels one pass recorded. */
  async function outcomesOf(route: FakeBuildAdapter): Promise<unknown[]> {
    const record = spyOn(reconcilerAttemptDuration, 'record');
    try {
      await runBuildPass(context(registryOf(route)));
      return record.mock.calls.map(([, labels]) => labels);
    } finally {
      record.mockRestore();
    }
  }

  test('carries the verdict, so a red build is a series an alert can name', async () => {
    await movedWebsite();
    const red = new FakeBuildAdapter({
      script: [{ result: { status: 'FAILED', reason: 'BUILD_FAILED' } }],
    });
    expect(await outcomesOf(red)).toEqual([
      { kind: 'build', outcome: 'FAILED' },
    ]);

    await movedWebsite();
    expect(await outcomesOf(new FakeBuildAdapter())).toEqual([
      { kind: 'build', outcome: 'SUCCEEDED' },
    ]);
  });

  test('an attempt that reached no verdict is refused', async () => {
    const { component } = await movedWebsite();
    await database()
      .db.update(components)
      .set({ placedTargetId: null })
      .where(eq(components.id, component.id));

    // Refused before `dispatchBuild`, so there is no attempt duration to
    // record.
    expect(await outcomesOf(new FakeBuildAdapter())).toEqual([]);
  });
});
