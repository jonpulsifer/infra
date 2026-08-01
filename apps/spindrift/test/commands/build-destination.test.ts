/**
 * What dispatch tells a route to push, and where.
 *
 * This is the layer the defect lived at. `dispatch.ts` handed the installation's
 * registry through unchanged — a namespace, which no registry accepts as a
 * repository — and every adapter-level fixture supplied an already-correct
 * value, so the routes were tested against the shape they expect and the caller
 * that produced the wrong one was tested against nothing. These assert on the
 * spec the route was actually handed.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dispatchBuild } from '../../src/commands/builds/dispatch.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  componentTargetDesired,
  targets,
  users,
} from '../../src/db/schema.ts';
import { artifactTags } from '../../src/domain/artifact-name.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const baseManifest = await fixtureManifest();

/** The fixture installation's §16 registry — a namespace, as §16 says. */
const REGISTRY = baseManifest.supplyChain.registry;
const BUNDLE_DIGEST =
  'sha256:3f5cbbc2a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c';
const BUNDLE_LOCATION = 'https://depot.example/bundles/site.tgz';

describe('the destination dispatch hands a route', () => {
  let ctx: CommandContext;

  async function seedBuild(names: { app: string; component: string }) {
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name: names.app,
        sourceKind: 'repo',
        sourceRepoUrl: 'acme/widgets',
        sourceRepoSubpath: 'apps/web',
      })
      .returning();
    const [component] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: names.component, kind: 'service' })
      .returning();
    const [target] = await ctx.db.select().from(targets).limit(1);
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId: target!.id });
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: BUNDLE_DIGEST,
        bundleLocation: BUNDLE_LOCATION,
      })
      .returning();
    return build!;
  }

  function routing(route: FakeBuildAdapter): CommandContext {
    return {
      ...ctx,
      adapters: {
        deploy: () => null,
        build: (name: string) => (name === 'hosted' ? route : null),
        store: () => new FakeSecretStore(),
        supplyChain: () => new SupplyChainHarness(),
        repository: () => null,
      } as AdapterRegistry,
    } as CommandContext;
  }

  beforeEach(async () => {
    const { client, db } = database();
    await db.delete(attemptEvents);
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
    await db
      .insert(targets)
      .values(targetValues({ name: 'target-a', rank: 1 }));

    ctx = {
      client,
      db,
      adapters: {} as AdapterRegistry,
      clock: { now: () => new Date('2026-08-01T12:00:00.000Z') },
      manifest: baseManifest,
      operatorId: operator!.id,
      principal: {
        type: 'user',
        id: operator!.id,
        displayName: 'Operator',
      },
    } as CommandContext;
  });

  test('names a repository under the registry, not the registry itself', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await seedBuild({
      app: 'infra',
      component: 'spindrift-demo',
    });

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      routing(route),
    );
    expect(result.ok).toBe(true);

    // The bug, stated as an assertion: `ghcr.io/jonpulsifer` reached a runner
    // verbatim and GHCR answered `NAME_INVALID` before authentication was
    // relevant, so `Build and push` could not succeed whatever the App built.
    expect(route.built[0]?.spec.destination).not.toBe(REGISTRY);
    expect(route.built[0]?.spec.destination).toBe(
      `${REGISTRY}/infra/spindrift-demo`,
    );
  });

  test('is stable across dispatches of the same Component', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const context = routing(route);
    const build = await seedBuild({ app: 'infra', component: 'web' });

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);
    await ctx.db
      .update(builds)
      .set({ status: 'PENDING', leasedAt: null, dispatchId: null })
      .where(eq(builds.id, build.id));
    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    expect(route.built).toHaveLength(2);
    expect(route.built[0]?.spec.destination).toBe(
      route.built[1]?.spec.destination,
    );
  });

  test('separates two Components of one App', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const context = routing(route);

    const web = await seedBuild({ app: 'shop', component: 'web' });
    await dispatchBuild({ buildId: web.id, route: 'hosted' }, context);

    // A second App name, because seeding reuses neither row.
    const worker = await seedBuild({ app: 'shop2', component: 'worker' });
    await dispatchBuild({ buildId: worker.id, route: 'hosted' }, context);

    expect(route.built[0]?.spec.destination).toBe(`${REGISTRY}/shop/web`);
    expect(route.built[1]?.spec.destination).toBe(`${REGISTRY}/shop2/worker`);
  });

  test('carries the tags §12 counts, not only an implicit latest', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await seedBuild({ app: 'infra', component: 'web' });

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, routing(route));

    // Retention is "retain by tagging ... N = 10 doubles as rollback depth".
    // Pushed under `latest` alone, every build overwrites the one tag.
    expect(route.built[0]?.spec.tags).toEqual(artifactTags(BUNDLE_DIGEST));
    expect(route.built[0]?.spec.tags).toContain(
      `sha256-${BUNDLE_DIGEST.slice('sha256:'.length)}`,
    );
  });

  test('refuses a name no registry accepts, and says so on the attempt log', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await seedBuild({ app: 'My App', component: 'web' });

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      routing(route),
    );

    expect(result.ok).toBe(false);
    // Nothing was dispatched: a `NAME_INVALID` discovered at the last step of
    // the build costs a whole run to learn.
    expect(route.built).toHaveLength(0);

    // A name is a column on these rows and no later tick makes it legal, so the
    // Build is closed out rather than left to be refused again every second —
    // which is the silent-`PENDING` shape ticket 25 was filed for.
    const [stored] = await ctx.db
      .select({ status: builds.status })
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(stored?.status).toBe('FAILED');

    const events = await ctx.db
      .select({ line: attemptEvents.line })
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, build.id));
    expect(events.some((event) => event.line?.includes('My App'))).toBe(true);
  });
});
