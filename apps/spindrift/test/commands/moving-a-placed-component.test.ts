/**
 * Moving a placed Component to another Target, as the workspace drives it. A
 * same-shape move redeploys the same Build, and the old pair serves until
 * retired.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { placeComponent } from '../../src/commands/components/place.ts';
import { unplaceComponent } from '../../src/commands/components/unplace.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
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
  deploys,
  targets,
  users,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
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

const FROZEN = new Date('2026-08-12T10:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

let store: FakeSecretStore;
let deployAdapter: FakeDeployAdapter;

beforeEach(() => {
  store = new FakeSecretStore({ adapter: manifest.secretStore.adapter });
  deployAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
});

function context(): Promise<CommandContext> {
  const adapters: AdapterRegistry = {
    deploy: (adapter) => (adapter === 'kubernetes' ? deployAdapter : null),
    build: () => null,
    store: (adapter) =>
      adapter === manifest.secretStore.adapter ? store : null,
    repository: () => null,
    supplyChain: () => new SupplyChainHarness(),
  };
  return database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning()
    .then(([user]) => ({
      principal: { id: user!.id, displayName: user!.displayName },
      clock,
      db: database().db,
      adapters,
      manifest,
    }));
}

/** A kubernetes Target this installation's store can be reached from. */
async function connectedTarget() {
  const vessel = await insertVessel(database().db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID().slice(0, 8)}`,
  });
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        discovery: CAPABLE_DISCOVERY,
      }),
    )
    .returning();
  return { target: target!, vesselName: vessel.name };
}

/** An App with one `service`, and the two same-shape Targets a move crosses. */
async function fixture() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({
      name: `shop-${crypto.randomUUID().slice(0, 8)}`,
      sourceKind: 'archive',
    })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: digest(1),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest(7),
      bundleDigest: digest(1),
      bundleLocation: `https://depot.lolwtf.ca/bundles/${digest(1)}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(digest(7), FROZEN.toISOString()),
    })
    .returning();
  return {
    app: app!,
    component: component!,
    build: build!,
    from: await connectedTarget(),
    to: await connectedTarget(),
  };
}

async function servingPairs(componentId: string): Promise<string[]> {
  const rows = await database()
    .db.select({ targetId: componentTargetDesired.targetId })
    .from(componentTargetDesired)
    .where(eq(componentTargetDesired.componentId, componentId));
  return rows.map((row) => row.targetId).sort();
}

describe('a same-shape move puts one digest on a second Target', () => {
  test('Deploy after the move reuses the Build, and both Targets carry it', async () => {
    const { app, component, build, from, to } = await fixture();
    const ctx = await context();

    const first = await createDeploy(
      {
        componentId: component.id,
        targetId: from.target.id,
        buildId: build.id,
      },
      ctx,
    );
    expect(first.ok).toBe(true);

    const moved = await placeComponent(
      { componentId: component.id, targetId: to.target.id, supply: [] },
      ctx,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    // Both Targets reach the same store, so no config value moves.
    expect(moved.value.carried).toEqual([]);

    // The screen's press after a move names no Target and asks for no rebuild.
    const pressed = await deployApp({ name: app.name }, ctx);
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    expect(pressed.value.buildId).toBe(build.id);

    const built = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(built.length).toBe(1);

    const released = await database()
      .db.select({ targetId: deploys.targetId, buildId: deploys.buildId })
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(released.length).toBe(2);
    expect(new Set(released.map((row) => row.targetId))).toEqual(
      new Set([from.target.id, to.target.id]),
    );
    expect(released.every((row) => row.buildId === build.id)).toBe(true);

    // The old pair keeps serving until Unplace retires it.
    expect(await servingPairs(component.id)).toEqual(
      [from.target.id, to.target.id].sort(),
    );
  });
});

describe('the pairs that still serve are what the screen hangs Unplace off', () => {
  test('the workspace names both, and one after the retirement', async () => {
    const { app, component, build, from, to } = await fixture();
    const ctx = await context();

    const first = await createDeploy(
      {
        componentId: component.id,
        targetId: from.target.id,
        buildId: build.id,
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The deploy loop sets the ref after `createDeploy`; this test sets it
    // directly.
    await database()
      .db.update(deploys)
      .set({ ref: 'apps/shop-web' })
      .where(eq(deploys.id, first.value.deployId));

    const moved = await placeComponent(
      { componentId: component.id, targetId: to.target.id, supply: [] },
      ctx,
    );
    expect(moved.ok).toBe(true);

    const before = await getAppWorkspace({ name: app.name }, ctx);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const web = before.value.workspace.components[0];
    expect(web?.serving?.map((pair) => pair.targetId).sort()).toEqual(
      [from.target.id, to.target.id].sort(),
    );
    expect(web?.serving?.map((pair) => pair.label).sort()).toEqual(
      [`${from.vesselName}/kubernetes`, `${to.vesselName}/kubernetes`].sort(),
    );

    const retired = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.destroyed).toBe(true);
    expect(deployAdapter.destroyed).toEqual(['apps/shop-web']);

    // Unplace leaves the placement the move wrote.
    const [row] = await database()
      .db.select({ placedTargetId: components.placedTargetId })
      .from(components)
      .where(eq(components.id, component.id));
    expect(row?.placedTargetId).toBe(to.target.id);

    const after = await getAppWorkspace({ name: app.name }, ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.workspace.components[0]?.serving?.map((pair) => pair.label),
    ).toEqual([`${to.vesselName}/kubernetes`]);

    const again = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.failure.code).toBe('NOT_FOUND');

    // Orphaned, so the loops stop chasing it.
    const [orphaned] = await database()
      .db.select({ orphanedAt: deploys.orphanedAt })
      .from(deploys)
      .where(
        and(
          eq(deploys.componentId, component.id),
          eq(deploys.targetId, from.target.id),
        ),
      );
    expect(orphaned?.orphanedAt).not.toBeNull();
  });
});
