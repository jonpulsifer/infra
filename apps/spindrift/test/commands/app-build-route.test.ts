/**
 * An App names the route it builds on (§4, §16).
 *
 * §16's sentence is "the level is a threshold, then admin rank wins", and the
 * App's choice enters on the *rank* side of that comma — it narrows the
 * candidates, it never lowers the bar. So the two things worth pinning are the
 * two halves of one rule: a chosen route that clears the Target's minimum is
 * what dispatch takes, and a chosen route that does not is refused with the
 * same sentence any other ineligible route gets.
 *
 * The fixture installation ranks `hosted` (L2) first, then `managed` (L3), then
 * `local` (L1) — three levels in rank order, which is what makes "rank picked
 * it" and "the App picked it" distinguishable at all.
 */
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
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const baseManifest = await fixtureManifest();

describe('an App choosing its build route', () => {
  let ctx: CommandContext;
  let appId: string;
  let targetId: string;

  /** Every route the fixture configures is available unless a test says not. */
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
    await db.delete(users);

    const [operator] = await db
      .insert(users)
      .values({ displayName: 'Operator' })
      .returning();
    const [target] = await db
      .insert(targets)
      .values(targetValues({ name: 'target-a', rank: 1, minBuildLevel }))
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

  /**
   * The behaviour before this column existed, and the behaviour of every App
   * that has not asked for anything. Null is "no opinion", not "no route".
   */
  test('takes the highest-ranked eligible route when it has no opinion', async () => {
    expect(await routeForTarget(targetId, ctx, appId)).toBe('hosted');
  });

  test('takes the route it named instead of the one rank would have picked', async () => {
    const result = await setAppBuildRoute({ appId, route: 'managed' }, ctx);

    expect(result.ok).toBe(true);
    expect(await routeForTarget(targetId, ctx, appId)).toBe('managed');
    // The Target's own answer is unchanged: this is the App's say, not a
    // re-ranking of the installation for everybody.
    expect(await routeForTarget(targetId, ctx)).toBe('hosted');
  });

  test('goes back to rank order when the choice is cleared', async () => {
    await setAppBuildRoute({ appId, route: 'managed' }, ctx);
    const result = await setAppBuildRoute({ appId, route: null }, ctx);

    expect(result.ok).toBe(true);
    expect(await routeForTarget(targetId, ctx, appId)).toBe('hosted');
  });

  /**
   * §16's threshold, applied to the App's choice exactly as to any other
   * candidate. `local` is the in-cluster route and it is L1, so a Target at the
   * default L2 will not take it — and naming it is not a way around that.
   */
  test('refuses a route below the Target’s minimum, naming the level', async () => {
    const result = await setAppBuildRoute({ appId, route: 'local' }, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain('target-a');
    expect(result.failure.message).toContain('Build Level 1');
    // Nothing was written: a refused choice is not a choice.
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

  /**
   * A route an installation configures but this process cannot construct is
   * unavailable rather than ineligible, and dispatch has to fall through it —
   * otherwise a missing GitHub credential silently pins every App to a route
   * that cannot run.
   */
  test('falls through a chosen route the process cannot construct', async () => {
    await setAppBuildRoute({ appId, route: 'managed' }, ctx);
    const without = {
      ...ctx,
      adapters: registryWith(['hosted', 'local']),
    } as CommandContext;

    expect(await routeForTarget(targetId, without, appId)).toBeNull();
  });

  /**
   * The half a level threshold does not cover, and the one the cloud builder
   * makes real: a route publishes where its own identity reaches, and a Target
   * pulls from where it can reach. If those do not meet, the Build is green and
   * the Deploy fails at the pull — so it is refused here instead.
   */
  test('refuses a route that publishes nowhere the Target can pull from', async () => {
    // A route whose identity reaches only the artifact registry, against a
    // Target that pulls only from GHCR: the cloud builder's exact situation
    // before a GHCR credential exists.
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

  /**
   * The other spelling a reachable list is allowed to use: a bare host, for a
   * Target that reaches every namespace on one registry. The route publishes
   * to a namespace under that host, so the two meet — refusing here was the
   * bug this test pins, because live Targets declare hosts.
   */
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

  /**
   * The Target's threshold is the Target's, so raising it takes the choice away
   * — which is the direction being wrong has to fail in.
   */
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
