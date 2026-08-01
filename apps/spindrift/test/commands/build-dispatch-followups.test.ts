/**
 * Tests for PR #1364 build dispatch follow-ups:
 * 1. Durable dispatch identity and lease timeout
 * 2. Explicit Target binding when a Component has multiple placements
 * 3. Atomic per-App concurrency limit across reconciler replicas
 * 4. Fallback to available eligible build route
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CONCURRENT_BUILDS_PER_APP,
  DISPATCH_LEASE_TIMEOUT_MS,
  dispatchBuild,
} from '../../src/commands/builds/dispatch.ts';
import { routeForTarget } from '../../src/commands/builds/route.ts';
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
  targets,
  users,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

describe('build dispatch follow-ups', () => {
  let ctx: CommandContext;

  beforeEach(async () => {
    const { client, db } = database();

    await db.delete(componentTargetDesired);
    await db.delete(builds);
    await db.delete(components);
    await db.delete(apps);
    await db.delete(targets);
    await db.delete(users);

    const [operator] = await db
      .insert(users)
      .values({ displayName: 'Operator' })
      .returning();

    const [_targetA] = await db
      .insert(targets)
      .values(targetValues({ name: 'target-a', rank: 1 }))
      .returning();

    const [_targetB] = await db
      .insert(targets)
      .values(targetValues({ name: 'target-b', rank: 2 }))
      .returning();

    const fakeBuildAdapter = new FakeBuildAdapter();
    const fakeStore = new FakeSecretStore();
    const supplyChain = new SupplyChainHarness();

    const adapters: AdapterRegistry = {
      deploy: () => null,
      build: (name) => (name === 'hosted' ? fakeBuildAdapter : null),
      store: () => fakeStore,
      supplyChain: () => supplyChain,
      repository: () => null,
    };

    let simulatedTime = new Date('2026-07-30T01:00:00.000Z');
    const clock: Clock = {
      now: () => simulatedTime,
    };

    ctx = {
      client,
      db,
      adapters,
      clock,
      manifest,
      operatorId: operator!.id,
      principal: {
        type: 'user',
        id: operator!.id,
        displayName: 'Operator',
      },
      setSimulatedTime: (t: Date) => {
        simulatedTime = t;
      },
    } as CommandContext & { setSimulatedTime: (t: Date) => void };
  });

  test('durable dispatch identity and lease timeout reclamation', async () => {
    const [app] = await ctx.db
      .insert(apps)
      .values({ name: 'my-app', sourceKind: 'archive' })
      .returning();

    const [comp] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();

    const [target] = await ctx.db.select().from(targets).limit(1);
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: comp!.id, targetId: target!.id });

    const dispatchId1 = 'dispatch-lease-1';
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: comp!.id,
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
        dispatchId: dispatchId1,
        leasedAt: ctx.clock.now(),
        bundleDigest:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        bundleLocation: 'https://staging.lolwtf.ca/bundle.tar.gz',
      })
      .returning();

    // 1. Dispatching with a DIFFERENT dispatchId while lease is active returns NOT_BUILDABLE
    const dispatchId2 = 'dispatch-lease-2';
    const result2 = await dispatchBuild(
      { buildId: build!.id, route: 'hosted', dispatchId: dispatchId2 },
      ctx,
    );
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.failure.message).toContain('already running');
    }

    // 2. Fast-forward time past DISPATCH_LEASE_TIMEOUT_MS to expire the lease
    const expiredTime = new Date(
      ctx.clock.now().getTime() + DISPATCH_LEASE_TIMEOUT_MS + 1000,
    );
    (ctx as any).setSimulatedTime(expiredTime);

    // 3. Dispatching with new dispatchId succeeds by reclaiming the expired lease
    const result3 = await dispatchBuild(
      { buildId: build!.id, route: 'hosted', dispatchId: dispatchId2 },
      ctx,
    );
    expect(result3.ok).toBe(true);
    if (result3.ok) {
      expect(result3.value.dispatchId).toBe(dispatchId2);
    }
  });

  test('explicit Target binding required when Component has multiple placements', async () => {
    const [app] = await ctx.db
      .insert(apps)
      .values({ name: 'multi-target-app', sourceKind: 'archive' })
      .returning();

    const [comp] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();

    const allTargets = await ctx.db.select().from(targets);
    expect(allTargets.length).toBeGreaterThanOrEqual(2);

    // Add 2 target placements for this component
    await ctx.db.insert(componentTargetDesired).values([
      { componentId: comp!.id, targetId: allTargets[0]!.id },
      { componentId: comp!.id, targetId: allTargets[1]!.id },
    ]);

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: comp!.id,
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest:
          'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        bundleLocation: 'https://staging.lolwtf.ca/bundle.tar.gz',
      })
      .returning();

    // 1. Dispatching without placementTargetId fails when there are multiple placements
    const resultOmitted = await dispatchBuild(
      { buildId: build!.id, route: 'hosted' },
      ctx,
    );
    expect(resultOmitted.ok).toBe(false);
    if (!resultOmitted.ok) {
      expect(resultOmitted.failure.message).toContain(
        'multiple target placements',
      );
    }

    // 2. Dispatching with explicit placementTargetId succeeds
    const resultExplicit = await dispatchBuild(
      {
        buildId: build!.id,
        route: 'hosted',
        placementTargetId: allTargets[0]!.id,
      },
      ctx,
    );
    expect(resultExplicit.ok).toBe(true);
  });

  test('concurrency limit enforcement across per-App builds', async () => {
    const [app] = await ctx.db
      .insert(apps)
      .values({ name: 'busy-app', sourceKind: 'archive' })
      .returning();

    const [comp] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();

    const [target] = await ctx.db.select().from(targets).limit(1);
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: comp!.id, targetId: target!.id });

    // Create RUNNING builds up to the limit
    for (let i = 0; i < CONCURRENT_BUILDS_PER_APP; i++) {
      await ctx.db.insert(builds).values({
        componentId: comp!.id,
        commit: `commit-${i}`.padEnd(40, '0'),
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
        leasedAt: ctx.clock.now(),
      });
    }

    // New pending build try to dispatch
    const [pendingBuild] = await ctx.db
      .insert(builds)
      .values({
        componentId: comp!.id,
        commit: 'new-commit'.padEnd(40, '0'),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest:
          'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        bundleLocation: 'https://staging.lolwtf.ca/bundle.tar.gz',
      })
      .returning();

    const result = await dispatchBuild(
      { buildId: pendingBuild!.id, route: 'hosted' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain('already has 3 builds running');
    }
  });

  test('routeForTarget selects first available eligible route', async () => {
    const allTargets = await ctx.db.select().from(targets).limit(1);
    const targetId = allTargets[0]!.id;

    // 'hosted' adapter is registered in ctx.adapters.build
    const selectedRoute = await routeForTarget(targetId, ctx);
    expect(selectedRoute).toBe('hosted');
  });
});
