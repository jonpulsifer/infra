/**
 * Dispatch backoff, and the signed URL as an attempt's last acquisition
 * (story 101).
 *
 * The incident this pins: a wedged Build was retried at loop cadence —
 * 500-1500ms, around the clock — and every attempt minted a signed bundle URL
 * (one STS exchange, one SignBlob) before failing on a condition knowable for
 * free. 84,729 SignBlob calls in a day, first noticed on a billing alert.
 *
 * Two mechanisms, asserted separately:
 *
 * - **Backoff**: a refused row earns an exponentially growing wait (capped),
 *   kept on the row, and the loop does not look at it again until the wait is
 *   up. A fresh claim or a fresh press resets the clock.
 * - **Ordering**: the signed URL is minted after every refusal *and after the
 *   claim*, so a refused attempt — missing route, refused shape, full
 *   concurrency slot, lost claim, even a federation gap — spends zero cloud
 *   calls, or fails before spending any more.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  DISPATCH_BACKOFF_CAP_MS,
  dispatchBackoffMs,
  dispatchBuild,
} from '../../src/commands/builds/dispatch.ts';
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
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
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

const NOW = new Date('2026-08-01T12:00:00.000Z');
const BUNDLE_DIGEST =
  'sha256:3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03';
const DEPOT_LOCATION =
  'gs://bluenose-spindrift-source/3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03.tgz';

/** A cloud that answers exchanges and signatures, and counts what it spent. */
function countingCloud(): {
  fetch: (request: Request) => Promise<Response>;
  spent: () => { total: number; signatures: number };
} {
  let total = 0;
  let signatures = 0;
  return {
    fetch: async (request: Request): Promise<Response> => {
      total += 1;
      if (request.url.includes(':signBlob')) {
        signatures += 1;
        return Response.json({ signedBlob: btoa('\x01\x02') });
      }
      return Response.json({ access_token: 'federated', expires_in: 3600 });
    },
    spent: () => ({ total, signatures }),
  };
}

describe('story 101: dispatch backoff and signed-URL ordering', () => {
  let ctx: CommandContext;
  let route: FakeBuildAdapter;
  let cloud: ReturnType<typeof countingCloud>;

  function withFederation(federation: unknown): CommandContext {
    return {
      ...ctx,
      manifest: {
        ...baseManifest,
        cloud: { ...baseManifest.cloud, federation },
      },
    } as CommandContext;
  }

  function signable(): unknown {
    return {
      audience: '//iam.googleapis.com/projects/1/locations/global/x/y',
      tokenUrl: 'https://sts.googleapis.test/v1/token',
      tokenPath: '/var/run/secrets/spindrift/gcp-token',
      impersonationUrl:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
      fetch: cloud.fetch,
      readToken: async () => 'projected-jwt',
    };
  }

  async function seedApp(name: string) {
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name,
        sourceKind: 'repo',
        sourceRepoUrl: 'jonpulsifer/infra',
        sourceRepoSubpath: 'apps/spindrift',
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
    return { app: app!, component: component!, target: target! };
  }

  async function seedBuild(
    componentId: string,
    overrides: Partial<typeof builds.$inferInsert> = {},
  ) {
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: `${crypto.randomUUID().replaceAll('-', '')}00000000`,
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: BUNDLE_DIGEST,
        bundleLocation: DEPOT_LOCATION,
        ...overrides,
      })
      .returning();
    return build!;
  }

  async function readBuild(id: number) {
    const [row] = await ctx.db.select().from(builds).where(eq(builds.id, id));
    return row!;
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

    cloud = countingCloud();
    route = new FakeBuildAdapter();
    const adapters: AdapterRegistry = {
      deploy: () => null,
      build: (name) => (name === 'hosted' ? route : null),
      store: () => new FakeSecretStore(),
      supplyChain: () => new SupplyChainHarness(),
      repository: () => null,
    };

    ctx = {
      client,
      db,
      adapters,
      clock: { now: () => NOW },
      manifest: baseManifest,
      operatorId: operator!.id,
      principal: {
        type: 'user',
        id: operator!.id,
        displayName: 'Operator',
      },
    } as CommandContext;
  });

  test('the wait doubles per refusal and is capped', () => {
    expect(dispatchBackoffMs(1)).toBe(1_000);
    expect(dispatchBackoffMs(2)).toBe(2_000);
    expect(dispatchBackoffMs(3)).toBe(4_000);
    // Ten thousand refusals earn the cap, not an overflow: the incident's row
    // would have reached one attempt per five minutes, not one per tick.
    expect(dispatchBackoffMs(10_000)).toBe(DISPATCH_BACKOFF_CAP_MS);
  });

  test('a refusal paces the next attempt instead of the next tick', async () => {
    // A federation gap: nothing is wrong with the row, so it waits — but it
    // now waits with a clock, where it used to be retried every tick.
    const context = withFederation(null);
    const { component } = await seedApp('paced');
    const build = await seedBuild(component.id);

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);
    let row = await readBuild(build.id);
    expect(row.status).toBe('PENDING');
    expect(row.dispatchAttempts).toBe(1);
    expect(row.nextDispatchAt?.getTime()).toBe(NOW.getTime() + 1_000);
    // The claim this attempt took was released — nothing ran under it.
    expect(row.dispatchId).toBeNull();
    expect(row.leasedAt).toBeNull();

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);
    row = await readBuild(build.id);
    expect(row.dispatchAttempts).toBe(2);
    expect(row.nextDispatchAt?.getTime()).toBe(NOW.getTime() + 2_000);
  });

  test('the loop does not look at a row whose wait is not up', async () => {
    // An unplaced Component: the pass itself refuses, before dispatch. The
    // first pass earns the row a wait; the second pass, at the same instant,
    // must not spend an attempt on it.
    await seedBuild((await seedApp('waiting')).component.id);
    await ctx.db
      .update(components)
      .set({ placedTargetId: null })
      .where(eq(components.name, 'web'));

    await runBuildPass(ctx);
    const [after] = await ctx.db.select().from(builds);
    expect(after?.dispatchAttempts).toBe(1);

    await runBuildPass(ctx);
    const [again] = await ctx.db.select().from(builds);
    // Unchanged: the row was not selected, so nothing advanced its clock.
    expect(again?.dispatchAttempts).toBe(1);
  });

  test('a refused attempt spends no signature', async () => {
    // The app is at its concurrency limit — a refusal knowable for free, and
    // one that used to come *after* the mint. Zero cloud calls is the claim.
    const context = withFederation(signable());
    const { component } = await seedApp('busy');
    for (let sibling = 0; sibling < 3; sibling += 1) {
      await seedBuild(component.id, { status: 'RUNNING', leasedAt: NOW });
    }
    const build = await seedBuild(component.id);

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(false);
    expect(cloud.spent().total).toBe(0);
    // And the refusal advanced the backoff clock like any other.
    const row = await readBuild(build.id);
    expect(row.dispatchAttempts).toBe(1);
    expect(row.nextDispatchAt).not.toBeNull();
  });

  test('a dispatched attempt signs once, and the claim resets the clock', async () => {
    const context = withFederation(signable());
    const { component } = await seedApp('shipped');
    // A history of refusals, as the incident's row had.
    const build = await seedBuild(component.id, {
      dispatchAttempts: 7,
      nextDispatchAt: NOW,
    });

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(true);
    expect(cloud.spent().signatures).toBe(1);
    expect(
      route.built[0]?.source.origin.location.startsWith(
        'https://storage.googleapis.com/',
      ),
    ).toBe(true);
    const row = await readBuild(build.id);
    expect(row.dispatchAttempts).toBe(0);
    expect(row.nextDispatchAt).toBeNull();
  });
});
