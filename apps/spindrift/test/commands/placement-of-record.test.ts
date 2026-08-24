/**
 * The placement of record is a stored fact, not an inference.
 *
 * Every surface used to answer "where is this Component placed" from the
 * newest `component_target_desired` row — and every intent bumps its pair's
 * `updatedAt`, so a rollback or config-set addressed at the *old* pair after a
 * move made the old row newest and flipped every reader back to the retired
 * Target. These tests hold the fact to its writers: only `placeComponent`
 * moves `components.placedTargetId`, an intent at the old pair leaves it
 * alone, and the workspace, `deployApp`, and the app list all read the same
 * column — including for a Component that has moved and never deployed.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { listApps } from '../../src/commands/apps/list.ts';
import { setAppLock } from '../../src/commands/apps/set-lock.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { placeComponent } from '../../src/commands/components/place.ts';
import { unplaceComponent } from '../../src/commands/components/unplace.ts';
import { setConfig } from '../../src/commands/config/set.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
import { rollbackDeploy } from '../../src/commands/deploys/rollback.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
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

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** A digest of the right shape, distinct per call. */
function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

let store: FakeSecretStore;

beforeEach(() => {
  store = new FakeSecretStore({ adapter: manifest.secretStore.adapter });
});

function registryOf(deployAdapter: DeployAdapter): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: () => null,
    store: (adapter) =>
      adapter === manifest.secretStore.adapter ? store : null,
    repository: () => null,
    supplyChain: () => new SupplyChainHarness(),
  };
}

/**
 * A context whose principal is a real `users` row, because `setConfig`'s audit
 * trail is a foreign key into it.
 */
async function context(adapters: AdapterRegistry): Promise<CommandContext> {
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return {
    principal: { id: user!.id, displayName: user!.displayName },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** A kubernetes Target that can reach this installation's store. */
async function connectedTarget() {
  const vesselName = `cluster-${crypto.randomUUID()}`;
  const vessel = await insertVessel(database().db, 'kubernetes', {
    name: vesselName,
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
  return { target: target!, vesselName };
}

/** An App, a Component, and two Targets a move can cross between. */
async function fixture() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const from = await connectedTarget();
  const to = await connectedTarget();
  return { app: app!, component: component!, from, to };
}

async function succeededBuild(componentId: string, seed: number) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest(seed),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest(seed),
      bundleDigest: digest(seed),
      bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(digest(seed), FROZEN.toISOString()),
    })
    .returning();
  return build!;
}

async function placedTargetOf(componentId: string): Promise<string | null> {
  const [row] = await database()
    .db.select({ placedTargetId: components.placedTargetId })
    .from(components)
    .where(eq(components.id, componentId));
  return row!.placedTargetId;
}

describe('an intent addressed at the old pair does not move the placement', () => {
  test('a rollback at the retired pair leaves it alone, and deployApp still acts on the move', async () => {
    const { app, component, from, to } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    const first = await succeededBuild(component.id, 1);
    const second = await succeededBuild(component.id, 2);

    // Two releases at the original Target, so a rollback there has an older
    // Build to name.
    for (const build of [first, second]) {
      const deployed = await createDeploy(
        {
          componentId: component.id,
          targetId: from.target.id,
          buildId: build.id,
        },
        ctx,
      );
      expect(deployed.ok).toBe(true);
    }
    expect(await placedTargetOf(component.id)).toBe(from.target.id);

    const moved = await placeComponent(
      { componentId: component.id, targetId: to.target.id, supply: [] },
      ctx,
    );
    expect(moved.ok).toBe(true);
    expect(await placedTargetOf(component.id)).toBe(to.target.id);

    // The regression: an ordinary deploy addressed at the old pair. It
    // succeeds — what still serves there can be rolled back — and it must not
    // move the Component home.
    const rolled = await rollbackDeploy(
      {
        componentId: component.id,
        targetId: from.target.id,
        buildId: first.id,
      },
      ctx,
    );
    expect(rolled.ok).toBe(true);
    expect(await placedTargetOf(component.id)).toBe(to.target.id);

    // Every reader agrees: the screen names the moved-to Target, and the
    // button writes its intent there.
    const workspace = await getAppWorkspace({ name: app.name }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.targetId).toBe(to.target.id);

    // A rollback holds the App's deploys until the operator says the cause is
    // fixed (§6) — that hold is another test's subject; here it is lifted so
    // the press below is answered on placement alone.
    expect((await setAppLock({ appId: app.id, reason: null }, ctx)).ok).toBe(
      true,
    );

    const pressed = await deployApp({ name: app.name }, ctx);
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    const [intent] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, pressed.value.deployId!));
    expect(intent?.targetId).toBe(to.target.id);
  });

  test('a config write at the retired pair redeploys there and leaves it alone', async () => {
    const { app, component, from, to } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    const build = await succeededBuild(component.id, 3);

    const deployed = await createDeploy(
      {
        componentId: component.id,
        targetId: from.target.id,
        buildId: build.id,
      },
      ctx,
    );
    expect(deployed.ok).toBe(true);

    const moved = await placeComponent(
      { componentId: component.id, targetId: to.target.id, supply: [] },
      ctx,
    );
    expect(moved.ok).toBe(true);

    // `setConfig` at the old pair delivers the change to what still serves
    // there — an intent that bumps that pair's desired row.
    const configured = await setConfig(
      {
        componentId: component.id,
        targetId: from.target.id,
        entries: [{ key: 'TOKEN', value: 'one' }],
      },
      ctx,
    );
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.value.deployId).not.toBeNull();

    expect(await placedTargetOf(component.id)).toBe(to.target.id);

    const workspace = await getAppWorkspace({ name: app.name }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.targetId).toBe(to.target.id);
  });
});

describe('unplacing clears the fact only for the pair that is it', () => {
  test('unplacing the placement itself sets the Component home to nowhere', async () => {
    const { component, from } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const placed = await placeComponent(
      { componentId: component.id, targetId: from.target.id, supply: [] },
      ctx,
    );
    expect(placed.ok).toBe(true);
    expect(await placedTargetOf(component.id)).toBe(from.target.id);

    const retracted = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(retracted.ok).toBe(true);
    expect(await placedTargetOf(component.id)).toBeNull();
  });

  test('unplacing the retired pair after a move leaves the home where the move put it', async () => {
    const { component, from, to } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    for (const targetId of [from.target.id, to.target.id]) {
      const placed = await placeComponent(
        { componentId: component.id, targetId, supply: [] },
        ctx,
      );
      expect(placed.ok).toBe(true);
    }
    expect(await placedTargetOf(component.id)).toBe(to.target.id);

    const retracted = await unplaceComponent(
      { componentId: component.id, targetId: from.target.id },
      ctx,
    );
    expect(retracted.ok).toBe(true);
    expect(await placedTargetOf(component.id)).toBe(to.target.id);
  });
});

describe('a moved-but-never-deployed Component reads the same everywhere', () => {
  test('the workspace names the Target the deploy button would act on', async () => {
    const { app, component, from, to } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    for (const targetId of [from.target.id, to.target.id]) {
      const placed = await placeComponent(
        { componentId: component.id, targetId, supply: [] },
        ctx,
      );
      expect(placed.ok).toBe(true);
    }

    // Nothing has ever deployed, so history has no answer — the fact does.
    const workspace = await getAppWorkspace({ name: app.name }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.targetId).toBe(to.target.id);
    expect(workspace.value.workspace.vessel).toBe(to.vesselName);

    // The uploaded bundle this archive App was created from. An archive
    // Component carries one from the moment it exists — `uploadArchive` and
    // `completeCreationDraft` are the only ways it gets a Build at all — and
    // without it `deployApp` refuses rather than writing a Build no route
    // could fetch a bundle for. It failed, so the press below is still a
    // rebuild rather than a Deploy of something already built.
    await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(9),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(9),
        bundleLocation: `https://depot.lolwtf.ca/bundles/${digest(9)}.zip`,
        status: 'FAILED',
      });

    // The button acts on the same Target the screen named: with nothing built
    // yet, it stages a Build for the moved-to placement.
    const pressed = await deployApp({ name: app.name }, ctx);
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    expect(pressed.value.phase).toBe('BUILDING');
    expect(await placedTargetOf(component.id)).toBe(to.target.id);
  });
});

describe('the app list shows a placement no deploy has reached (§18)', () => {
  test('placed-but-never-deployed names the Target; unplaced stays none', async () => {
    const { app, component, from } = await fixture();
    const ctx = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    const placed = await placeComponent(
      { componentId: component.id, targetId: from.target.id, supply: [] },
      ctx,
    );
    expect(placed.ok).toBe(true);

    // A second App nobody has placed, to hold the two rows apart.
    const [bare] = await database()
      .db.insert(apps)
      .values({ name: 'bare', sourceKind: 'archive' })
      .returning();
    await database()
      .db.insert(components)
      .values({ appId: bare!.id, name: 'web', kind: 'service', expose: true });

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byId = new Map(listed.value.apps.map((row) => [row.id, row]));

    // The placed row names its Target and boundary, marked as awaiting its
    // first deploy — distinguishable from both a live placement and `none`.
    expect(byId.get(app.id)?.target).toBe('kubernetes (awaiting first deploy)');
    expect(byId.get(app.id)?.vessel).toBe(from.vesselName);

    expect(byId.get(bare!.id)?.target).toBe('none');
    expect(byId.get(bare!.id)?.vessel).toBe('');
  });
});
