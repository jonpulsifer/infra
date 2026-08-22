/**
 * Stopping a specific (Component, Target) placement (75, §6, §13).
 *
 * Two holes this closes, both the same shape once a live ref exists: a
 * Component whose Target moved left the old address running, and a Component
 * whose kind changed `job` → `service` left the old `jobs/<id>` ref orphaned
 * under a name nothing holds a handle on any more. `unplaceComponent` does not
 * distinguish the two — both are "a (Component, Target) pair with a live ref
 * that nobody wants any more" — so one set of tests below drives a real
 * Target move and the other drives the ref shape a kind change would strand,
 * without needing a kind-change command to exist yet (none does: see the
 * fixture in the second `describe`).
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { unplaceComponent } from '../../src/commands/components/unplace.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
import { dispatch } from '../../src/commands/registry.ts';
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
} from '../../src/db/schema.ts';
import {
  type DeployLoopContext,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeDnsPublisher } from '../harness/fakes/dns-publisher.ts';
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
const DIGEST = `sha256:${'a'.repeat(64)}`;

function registryOf(
  ...adapters: readonly FakeDeployAdapter[]
): AdapterRegistry {
  const chain = new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapters.find((candidate) => candidate.adapter === adapter) ?? null,
    build: () => {
      throw new Error('unplacing a Component must not reach a builder');
    },
    store: () => {
      throw new Error('unplacing a Component must not reach the secret store');
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

function loopContext(
  ...fakes: readonly FakeDeployAdapter[]
): DeployLoopContext {
  return {
    db: database().db,
    adapters: {
      deploy: (name) => fakes.find((fake) => fake.adapter === name) ?? null,
    },
    clock,
    manifest,
  };
}

/** An App with one Component, a Target of the given adapter type, a Build. */
async function fixture(options: {
  kind?: 'job' | 'service';
  schedule?: string | null;
  adapter?: 'kubernetes' | 'cloudrun';
}) {
  const db = database().db;
  const kind = options.kind ?? 'service';
  const [app] = await db
    .insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'main',
      kind,
      schedule: kind === 'job' ? (options.schedule ?? null) : null,
      reach: 'none',
      auth: 'none',
    })
    .returning();
  // Its own vessel: a Target is (vessel, adapter), so two fixtures sharing the
  // harness default would collide on that pair rather than on a name.
  const adapter = options.adapter ?? 'kubernetes';
  const vessel = await insertVessel(db, adapter);
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

async function deployRows(componentId: string, targetId: string) {
  return database()
    .db.select()
    .from(deploys)
    .where(
      and(eq(deploys.componentId, componentId), eq(deploys.targetId, targetId)),
    );
}

describe('unplacing after a Target move (75, box 3, first half)', () => {
  test('the old Target is torn down and the new one is untouched', async () => {
    const { component, target: oldTarget, build } = await fixture({});
    const newTarget = (await fixture({})).target;

    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    // Placed and deployed on the old Target — the workload this ticket is
    // about not stranding.
    await createDeploy(
      { componentId: component.id, targetId: oldTarget.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    // The developer's actual move: a second placement, on a different
    // Target, with nothing yet retracting the first — exactly the gap 75
    // names ("nothing stops a developer from placing a Component on a second
    // Target while the first is still live").
    await createDeploy(
      { componentId: component.id, targetId: newTarget.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    expect(adapter.applied).toHaveLength(2);
    expect(adapter.destroyed).toEqual([]);

    const oldRef = (await deployRows(component.id, oldTarget.id))[0]?.ref;
    expect(oldRef).toBeTruthy();
    if (!oldRef) return;

    const result = await unplaceComponent(
      { componentId: component.id, targetId: oldTarget.id },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destroyed).toBe(true);
    expect(adapter.destroyed).toEqual([oldRef]);

    // The old pair's desired row is gone — retracted, not merely stranded.
    expect(await desiredRow(component.id, oldTarget.id)).toBeUndefined();
    const [oldDeploy] = await deployRows(component.id, oldTarget.id);
    expect(oldDeploy?.orphanedAt).not.toBeNull();

    // The new placement is a different pair and this call named neither its
    // ref nor its row.
    expect(await desiredRow(component.id, newTarget.id)).toBeDefined();
    const [newDeploy] = await deployRows(component.id, newTarget.id);
    expect(newDeploy?.orphanedAt).toBeNull();
  });

  test('calling it again on the same pair finds nothing left to unplace', async () => {
    const { component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const first = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );
    expect(first.ok).toBe(true);

    const second = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe('NOT_FOUND');
    // Idempotent at the adapter, not at this layer: a second `destroy` call
    // never happens because there is nothing left here to name it against.
    expect(adapter.destroyed).toHaveLength(1);
  });

  test('a pair that never produced a ref is retracted with no adapter call', async () => {
    const { component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    // Placed, but the reconciler never ran — no ref exists yet.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destroyed).toBe(false);
    expect(adapter.destroyed).toEqual([]);
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a Component never placed on that Target is a plain refusal', async () => {
    const { component } = await fixture({});
    const { target } = await fixture({});
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(registryOf(adapter)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('main');
  });

  test('a destroy the platform refuses leaves the placement exactly as it was', async () => {
    const { component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({
      adapter: 'kubernetes',
      destroyThrows: 'the far side refused to remove this release',
    });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_REMOVABLE');
    expect(result.failure.message).toContain('refused');

    // Nothing moved: the row a retry needs is still there, and the Deploy it
    // named is still live rather than orphaned out from under a failed call.
    expect(await desiredRow(component.id, target.id)).toBeDefined();
    const [deploy] = await deployRows(component.id, target.id);
    expect(deploy?.orphanedAt).toBeNull();
  });
});

describe('unplacing the ref a kind change would strand (75, box 3, second half)', () => {
  test('a job ref is torn down the same way a service ref is', async () => {
    // 75's own read of this half: no command mutates `components.kind` after
    // creation, so a real `job` -> `service` transition cannot be produced
    // through the command layer yet. What is true today, and what this test
    // proves, is that `unplaceComponent` does not care why a (Component,
    // Target) pair has a live ref — a `jobs/<id>`-shaped one a kind change
    // would orphan is torn down through the identical path a Target move is.
    // A future kind-change command's whole stranding answer is "call this."
    const { component, target, build } = await fixture({
      kind: 'job',
      schedule: '0 3 * * *',
    });
    const adapter = new FakeDeployAdapter({
      adapter: 'kubernetes',
      script: [{ verdict: { phase: 'LIVE', ref: `jobs/${component.id}` } }],
    });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const [deploy] = await deployRows(component.id, target.id);
    expect(deploy?.ref).toBe(`jobs/${component.id}`);

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destroyed).toBe(true);
    expect(adapter.destroyed).toEqual([`jobs/${component.id}`]);
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });
});

describe('§9: unplacing withdraws the vanity record (ticket 137b)', () => {
  test('a successful destroy withdraws the handle', async () => {
    const { app, component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const dns = new FakeDnsPublisher();
    const adapters: AdapterRegistry = {
      ...registryOf(adapter),
      dns: () => dns,
    };

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    // §9's handle is `<App>-<Component>` — idempotent even though a cluster
    // Target publishes its own vanity record through the App chart rather
    // than through this seam, which is why the test asserts the call was
    // made rather than asserting anything about what it converged.
    expect(dns.withdrawn).toEqual([`${app.name}-main`]);
  });

  test('a destroy the platform refuses never reaches the DNS publisher', async () => {
    const { component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({
      adapter: 'kubernetes',
      destroyThrows: 'the far side refused to remove this release',
    });
    const dns = new FakeDnsPublisher();
    const adapters: AdapterRegistry = {
      ...registryOf(adapter),
      dns: () => dns,
    };

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(false);
    expect(dns.withdrawn).toEqual([]);
  });
});

describe('an unregistered target adapter is a refusal, not a fault', () => {
  test('an installation with no adapter for this Target says so', async () => {
    const { component, target, build } = await fixture({ adapter: 'cloudrun' });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    // No `cloudrun` fake registered — `runDeployPass` cannot apply, so drive
    // the ref straight onto the row the way a hand test of `destroy`'s caller
    // has to: this is testing `unplaceComponent`'s own refusal, not the loop.
    const [row] = await deployRows(component.id, target.id);
    await database()
      .db.update(deploys)
      .set({ ref: 'cloudrun-ref', phase: 'LIVE' })
      .where(eq(deploys.id, row!.id));

    const result = await unplaceComponent(
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_REMOVABLE');
    expect(result.failure.message).toContain('cloudrun');
  });
});

describe('the dispatch surface knows the command', () => {
  test('unplaceComponent is reachable by name', async () => {
    const { component, target, build } = await fixture({});
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));

    const result = await dispatch(
      'unplaceComponent',
      { componentId: component.id, targetId: target.id },
      context(adapters),
    );

    expect(result.ok).toBe(true);
  });
});
