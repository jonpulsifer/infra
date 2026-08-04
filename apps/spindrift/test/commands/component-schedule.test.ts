/**
 * Changing or removing a `kind: job` Component's cadence after creation (75,
 * §2, §6).
 *
 * `components.schedule` was write-once — `createComponent` was its only
 * writer — so the Cloud Run adapter's removal branch (an `apply` whose
 * `desired.schedule` is absent, `src/adapters/deploy/cloudrun/index.ts:287-311`)
 * could never be reached by any command: nothing could ever produce a
 * re-deploy whose schedule differed from the one set at creation. Three claims
 * here, and the last is the one that answers the ticket's own criterion:
 *
 * - **A non-job Component has nothing to schedule.** The refusal is a
 *   `NOT_FOUND`-shaped `INVALID_INPUT`, matching `runComponent`'s.
 * - **The edit writes the Component and leaves a Deploy to be pressed.**
 *   Nothing already running changes — `pendingRelease` names where it has not
 *   yet.
 * - **A re-deploy after removing the schedule reaches the adapter with
 *   `desired.schedule` absent.** This is the box: the removal branch that used
 *   to be unreachable through any command is now reachable through this one.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createDeploy,
  setComponentSchedule,
} from '../../src/commands/index.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, builds, components, targets } from '../../src/db/schema.ts';
import {
  type DeployLoopContext,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function registryOf(deployAdapter: FakeDeployAdapter): AdapterRegistry {
  const chain = new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: () => {
      throw new Error('a schedule edit must not reach a builder');
    },
    store: () => {
      throw new Error('a schedule edit must not reach the secret store');
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

function loopContext(adapter: FakeDeployAdapter): DeployLoopContext {
  return {
    db: database().db,
    adapters: { deploy: (name) => (name === adapter.adapter ? adapter : null) },
    clock,
    manifest,
  };
}

/** An App with one Component of the given kind, a cluster Target, a Build. */
async function fixture(
  kind: 'job' | 'service' = 'job',
  schedule: string | null = '0 3 * * *',
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'batch', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'nightly',
      kind,
      schedule: kind === 'job' ? schedule : null,
      reach: 'none',
      auth: 'none',
    })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cloudrun-${crypto.randomUUID()}`,
        adapter: 'kubernetes',
        discovery: null,
      }),
    )
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: DIGEST,
      bundleDigest: DIGEST,
      bundleLocation: 'https://depot.example.test/bundles/1.zip',
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(DIGEST, FROZEN.toISOString()),
    })
    .returning();
  return { app: app!, component: component!, target: target!, build: build! };
}

async function componentRow(id: string) {
  const [row] = await database()
    .db.select()
    .from(components)
    .where(eq(components.id, id));
  return row;
}

describe('only a job Component has a schedule to change', () => {
  test('a service is refused, naming the field', async () => {
    const { component } = await fixture('service', null);

    const refused = await dispatch(
      'setComponentSchedule',
      { componentId: component.id, schedule: '0 3 * * *' },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('INVALID_INPUT');
  });

  test('an unknown Component is a refusal with an identity', async () => {
    const missing = crypto.randomUUID();
    const result = await setComponentSchedule(
      { componentId: missing, schedule: null },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain(missing);
  });
});

describe('the edit writes a Component and leaves a Deploy to be pressed', () => {
  test('a Component that has never been placed has nothing serving the old cadence', async () => {
    const { component } = await fixture('job', '0 3 * * *');

    const result = await setComponentSchedule(
      { componentId: component.id, schedule: null },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingRelease).toEqual([]);
    const row = await componentRow(component.id);
    expect(row?.schedule).toBeNull();
    expect(row?.updatedAt).toEqual(FROZEN);
  });

  test('a Target already placed is named, and nothing is deployed', async () => {
    const { component, target, build } = await fixture('job', '0 3 * * *');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));
    expect(adapter.applied).toHaveLength(1);

    const result = await setComponentSchedule(
      { componentId: component.id, schedule: null },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingRelease).toEqual([target.name]);
    // Same rule as `setComponentReach`: writing the row asks the platform for
    // nothing. A second `apply` here would be this command re-placing a live
    // release nobody pressed Deploy for.
    expect(adapter.applied).toHaveLength(1);
  });
});

describe('a re-deploy is what reaches the adapter (75)', () => {
  test('removing the schedule and pressing Deploy hands the adapter an absent schedule', async () => {
    const { component, target, build } = await fixture('job', '0 3 * * *');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    const first = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    expect(first.ok).toBe(true);
    await runDeployPass(loopContext(adapter));
    expect(adapter.applied).toHaveLength(1);
    // The Component still declares its schedule at the first attempt: proves
    // the fixture, not the fix.
    expect(adapter.applied[0]?.desired.schedule).toBe('0 3 * * *');

    const edited = await setComponentSchedule(
      { componentId: component.id, schedule: null },
      context(adapters),
    );
    expect(edited.ok).toBe(true);

    const second = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    expect(second.ok).toBe(true);
    await runDeployPass(loopContext(adapter));

    expect(adapter.applied).toHaveLength(2);
    // The removal branch: no command could ever produce this before —
    // `components.schedule` was write-once, so `desired.schedule` could never
    // differ from what `createComponent` set. Revert this file's registration
    // (drop `setComponentSchedule` from the registry, or make its input
    // schema default `schedule` to the old value) and this assertion is what
    // goes red, because nothing would ever have written `null` onto the row.
    expect(adapter.applied[1]?.desired.schedule).toBeUndefined();
  });

  test('setting a new cadence and pressing Deploy hands the adapter the new one', async () => {
    const { component, target, build } = await fixture('job', '0 3 * * *');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const edited = await setComponentSchedule(
      { componentId: component.id, schedule: '0 9 * * 1' },
      context(adapters),
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.schedule).toBe('0 9 * * 1');

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    expect(adapter.applied).toHaveLength(2);
    expect(adapter.applied[1]?.desired.schedule).toBe('0 9 * * 1');
  });
});
