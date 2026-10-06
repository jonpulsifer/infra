// The attempt log stays empty for a LIVE_STATUS run, so the run link is
// recorded on the Build, never as a log line.
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

const BUNDLE_DIGEST = 'sha256:0e6a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c';
const BUNDLE_LOCATION = 'https://depot.example/bundles/site.tgz';
const RUN_URL = 'https://vcs.example/acme/widgets/actions/runs/9';

describe('the run link dispatch records', () => {
  let ctx: CommandContext;

  async function seedBuild() {
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name: 'almanac',
        sourceKind: 'repo',
        sourceRepoUrl: 'acme/widgets',
        sourceRepoSubpath: 'apps/web',
      })
      .returning();
    const [component] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
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

  /** The same context, routing `hosted` to a scripted stream a test names. */
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
    const vessel = await insertVessel(db, 'kubernetes', { name: 'target-a' });
    await db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id, rank: 1 }));

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

  test('a runner event lands on the Build, not in the attempt log', async () => {
    const context = routing(
      new FakeBuildAdapter({
        name: 'hosted',
        logFidelity: 'LIVE_STATUS',
        script: [
          {
            events: [
              { type: 'runner', at: new Date(0), url: RUN_URL },
              { type: 'log', at: new Date(1), line: 'run 9 started' },
            ],
            result: { status: 'SUCCEEDED' },
          },
        ],
      }),
    );
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(true);

    const [stored] = await ctx.db
      .select({ runUrl: builds.runUrl })
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(stored?.runUrl).toBe(RUN_URL);

    const events = await ctx.db
      .select({ line: attemptEvents.line })
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, build.id));
    expect(events.some((event) => event.line?.includes(RUN_URL))).toBe(false);
  });

  test('a route that reports no run link leaves the column null', async () => {
    const context = routing(
      new FakeBuildAdapter({
        name: 'hosted',
        script: [
          {
            events: [{ type: 'log', at: new Date(0), line: 'building' }],
            result: { status: 'SUCCEEDED' },
          },
        ],
      }),
    );
    const build = await seedBuild();

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    const [stored] = await ctx.db
      .select({ runUrl: builds.runUrl })
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(stored?.runUrl).toBeNull();
  });

  test('a re-armed Build sheds the previous attempt\u2019s link at the claim', async () => {
    const context = routing(
      new FakeBuildAdapter({
        name: 'hosted',
        logFidelity: 'LIVE_STATUS',
        script: [
          {
            events: [{ type: 'log', at: new Date(0), line: 'run starting' }],
            result: { status: 'SUCCEEDED' },
          },
        ],
      }),
    );
    const build = await seedBuild();
    // An earlier attempt's concluded run, left on the row when its lease
    // lapsed.
    await ctx.db
      .update(builds)
      .set({ runUrl: 'https://vcs.example/acme/widgets/actions/runs/8' })
      .where(eq(builds.id, build.id));

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    // Not this attempt's run, so cancelBuild must not get it.
    const [stored] = await ctx.db
      .select({ runUrl: builds.runUrl })
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(stored?.runUrl).toBeNull();
  });

  test('a failed build keeps its run link, which is when it is most wanted', async () => {
    const context = routing(
      new FakeBuildAdapter({
        name: 'hosted',
        logFidelity: 'LIVE_STATUS',
        script: [
          {
            events: [{ type: 'runner', at: new Date(0), url: RUN_URL }],
            result: { status: 'FAILED', reason: 'BUILD_FAILED' },
          },
        ],
      }),
    );
    const build = await seedBuild();

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    const [stored] = await ctx.db
      .select({ status: builds.status, runUrl: builds.runUrl })
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(stored?.status).toBe('FAILED');
    expect(stored?.runUrl).toBe(RUN_URL);
  });
});
