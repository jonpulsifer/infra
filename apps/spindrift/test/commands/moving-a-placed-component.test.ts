/**
 * A placed Component moved to another Target, as the workspace drives it
 * (ticket 121, §3, §10).
 *
 * The commands have been written and tested since #1813; what had never been
 * stated is the sequence a screen performs with them, and the two facts that
 * sequence depends on:
 *
 * - **The artifact travels.** A same-shape move followed by an ordinary press
 *   of Deploy reuses the Build that already succeeded
 *   (`src/commands/apps/deploy.ts:406-425`), so one digest ends up admitted on
 *   two Targets with no second Build anywhere. If that ever stopped being true
 *   the move would silently become a rebuild, which is the substitution
 *   `deployApp` exists to refuse.
 * - **The pair that was left keeps serving, and is nameable.** `placeComponent`
 *   leaves the old desired row alone on purpose, and `componentTargetDesired`
 *   had never been read anywhere in `src/` — so nothing could list the pairs an
 *   Unplace control has to hang off. The workspace reads them now, and this
 *   holds it to naming both before the retirement and one after.
 *
 * The cross-shape half of the move is already held to its refusal by
 * `test/commands/deploys.test.ts`'s "move, rebuild into files, deploy
 * admitted": the deploy at the new placement refuses with "this placement needs
 * a rebuild", and `deployApp({ rebuild: true })` stages a Build of the new
 * Target's shape. Restating it here would be a second copy of one claim.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import {
  createDeploy,
  placeComponent,
  unplaceComponent,
} from '../../src/commands/index.ts';
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

/** A digest of the right shape, distinct per call. */
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

    // Where it lives today: one release, admitted on the first Target.
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
    // Nothing crossed a store boundary, so nothing was demanded and no value
    // moved — the whole of §10's free case.
    expect(moved.value.carried).toEqual([]);

    // The press, exactly as the screen makes it after a move: no Target named,
    // because the placement is the answer, and no rebuild, because §3's
    // rebuild is a different act.
    const pressed = await deployApp({ name: app.name }, ctx);
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    expect(pressed.value.buildId).toBe(build.id);

    // No second Build. The move is not a rebuild, and a press that quietly
    // made one would be the substitution `deployApp`'s header forbids.
    const built = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, component.id));
    expect(built.length).toBe(1);

    // One digest, two Targets, independently admitted on each.
    const released = await database()
      .db.select({ targetId: deploys.targetId, buildId: deploys.buildId })
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(released.length).toBe(2);
    expect(new Set(released.map((row) => row.targetId))).toEqual(
      new Set([from.target.id, to.target.id]),
    );
    expect(released.every((row) => row.buildId === build.id)).toBe(true);

    // And the pair it moved away from is still one: what is live there keeps
    // serving until it is retired by name.
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

    // The address the old release answers on. `createDeploy` writes the intent
    // and the loop places it, so the ref is set here rather than waited for —
    // what is under test is that `unplaceComponent` tears down whatever the
    // pair is holding, not how it came to hold it.
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
    // Labelled the way every other Target on this screen is, because the
    // control is a sentence about a boundary and a surface.
    expect(web?.serving?.map((pair) => pair.label).sort()).toEqual(
      [`${from.vesselName}/kubernetes`, `${to.vesselName}/kubernetes`].sort(),
    );

    // The act the control performs, on the pair it named.
    const retired = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.destroyed).toBe(true);
    expect(deployAdapter.destroyed).toEqual(['apps/shop-web']);

    // The home the move wrote is not this command's to touch, and the screen
    // now offers exactly one pair to retire.
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

    // Pressing it again has nothing left to answer: the row that named the
    // placement is gone, which is the honest reading of "do it again".
    const again = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.failure.code).toBe('NOT_FOUND');

    // And the release that was serving there is history rather than an intent
    // the loops still chase.
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
