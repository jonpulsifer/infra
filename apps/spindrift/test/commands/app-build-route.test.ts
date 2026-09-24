// The fixture ranks `hosted` (L2), then `managed` (L3), then `local` (L1), so
// the App's choice and rank order pick different routes.
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppBuildRoute } from '../../src/commands/apps/build-route.ts';
import { routeForTarget } from '../../src/commands/builds/route.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  components,
  componentTargetDesired,
  targets,
  users,
  vessels,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const baseManifest = await fixtureManifest();

describe('an App choosing its build route', () => {
  let ctx: CommandContext;
  let appId: string;
  let targetId: string;

  function registryWith(available: readonly string[]): AdapterRegistry {
    return {
      deploy: () => null,
      build: (name) =>
        available.includes(name) ? new FakeBuildAdapter() : null,
      store: () => new FakeSecretStore(),
      supplyChain: () => new SupplyChainHarness(),
      repository: () => null,
    };
  }

  async function seed(minBuildLevel: number | null): Promise<void> {
    const { client, db } = database();
    await db.delete(componentTargetDesired);
    await db.delete(components);
    await db.delete(apps);
    await db.delete(targets);
    // A second seed in one test would otherwise hit vessels_name_unique.
    await db.delete(vessels).where(eq(vessels.name, 'target-a'));
    await db.delete(users);

    const [operator] = await db
      .insert(users)
      .values({ displayName: 'Operator' })
      .returning();
    const vessel = await insertVessel(db, 'kubernetes', { name: 'target-a' });
    const [target] = await db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id, rank: 1, minBuildLevel }))
      .returning();
    targetId = target!.id;
    const [app] = await db
      .insert(apps)
      .values({
        name: 'plainboi',
        sourceKind: 'repo',
        sourceRepoUrl: 'jonpulsifer/infra',
        sourceRepoSubpath: 'apps/spindrift-demo/plain',
      })
      .returning();
    appId = app!.id;
    const [component] = await db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();
    await db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId });

    ctx = {
      client,
      db,
      adapters: registryWith(['hosted', 'managed', 'local']),
      clock: { now: () => new Date('2026-08-03T12:00:00.000Z') },
      manifest: baseManifest,
      operatorId: operator!.id,
      principal: {
        type: 'user',
        id: operator!.id,
        displayName: 'Operator',
      },
    } as CommandContext;
  }

  beforeEach(async () => {
    await seed(null);
  });

  test('takes the highest-ranked eligible route when it has no opinion', async () => {
    expect(await routeForTarget(targetId, ctx, appId)).toBe('hosted');
  });

  test('takes the route it named instead of the one rank would have picked', async () => {
    const result = await setAppBuildRoute({ appId, route: 'managed' }, ctx);

    expect(result.ok).toBe(true);
    expect(await routeForTarget(targetId, ctx, appId)).toBe('managed');
    expect(await routeForTarget(targetId, ctx)).toBe('hosted');
  });

  test('goes back to rank order when the choice is cleared', async () => {
    await setAppBuildRoute({ appId, route: 'managed' }, ctx);
    const result = await setAppBuildRoute({ appId, route: null }, ctx);

    expect(result.ok).toBe(true);
    expect(await routeForTarget(targetId, ctx, appId)).toBe('hosted');
  });

  // `local` is L1, below the default L2 minimum.
  test('refuses a route below the Target’s minimum, naming the level', async () => {
    const result = await setAppBuildRoute({ appId, route: 'local' }, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain('target-a');
    expect(result.failure.message).toContain('Build Level 1');
    const [row] = await ctx.db
      .select({ buildRoute: apps.buildRoute })
      .from(apps)
      .where(eq(apps.id, appId));
    expect(row?.buildRoute).toBeNull();
  });

  test('refuses a route this installation does not have', async () => {
    const result = await setAppBuildRoute({ appId, route: 'imaginary' }, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toContain('imaginary');
  });

  // A chosen route the process cannot construct yields no route, never one that
  // cannot run.
  test('falls through a chosen route the process cannot construct', async () => {
    await setAppBuildRoute({ appId, route: 'managed' }, ctx);
    const without = {
      ...ctx,
      adapters: registryWith(['hosted', 'local']),
    } as CommandContext;

    expect(await routeForTarget(targetId, without, appId)).toBeNull();
  });

  // A route publishes where its own identity reaches. A Target that cannot pull
  // from there would fail the Deploy at the pull.
  test('refuses a route that publishes nowhere the Target can pull from', async () => {
    const narrow = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        build: (name: string) =>
          name === 'managed'
            ? new FakeBuildAdapter({
                selfAuthorizedRegistries: ['artifactRegistry'],
              })
            : new FakeBuildAdapter(),
      },
    } as CommandContext;
    await narrow.db
      .update(targets)
      .set({
        discovery: {
          reachableRegistries: ['ghcr.io/jonpulsifer'],
        } as never,
      })
      .where(eq(targets.id, targetId));

    const result = await setAppBuildRoute({ appId, route: 'managed' }, narrow);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toContain('cannot pull');
    expect(result.failure.message).toContain('target-a');
  });

  // A bare host in reachableRegistries covers every namespace under it.
  test('a Target declaring a bare registry host accepts a route publishing a namespace under it', async () => {
    await ctx.db
      .update(targets)
      .set({
        discovery: {
          reachableRegistries: ['registry.example.test'],
        } as never,
      })
      .where(eq(targets.id, targetId));

    const result = await setAppBuildRoute({ appId, route: 'managed' }, ctx);

    expect(result.ok).toBe(true);
  });

  test('an L3 Target takes the L3 route the App named and refuses the L2 one', async () => {
    await seed(3);

    expect((await setAppBuildRoute({ appId, route: 'managed' }, ctx)).ok).toBe(
      true,
    );
    expect(await routeForTarget(targetId, ctx, appId)).toBe('managed');

    const refused = await setAppBuildRoute({ appId, route: 'hosted' }, ctx);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.failure.message).toContain('at least L3');
  });
});
