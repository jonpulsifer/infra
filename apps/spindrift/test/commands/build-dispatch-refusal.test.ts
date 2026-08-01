/**
 * What a refused dispatch tells the operator (ticket 25).
 *
 * `runBuildPass` is `if (result.ok) dispatched += 1`: it keeps the successes and
 * drops everything else. So a refusal made before the claim reaches nobody
 * unless dispatch writes it down first, and the Build sits PENDING being refused
 * again once a second in silence.
 *
 * That is not hypothetical. Build 13 sat PENDING for two hours over a missing
 * `roles/iam.serviceAccountTokenCreator` binding while the true sentence was
 * composed once a second and thrown away every time; it was named in the end by
 * reading Terraform, not by anything Spindrift said.
 *
 * Two dispositions, separated by whether a later tick can clear the refusal —
 * and a suppression rule, because the honest fix to a silent 1Hz loop is a
 * chatty one.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { asc, desc, eq } from 'drizzle-orm';
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
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const baseManifest = await fixtureManifest();

const BUNDLE_DIGEST =
  'sha256:3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03';
const DEPOT_LOCATION = `gs://bluenose-spindrift-source/${BUNDLE_DIGEST.slice(7)}.tgz`;

/** Federation that impersonates but cannot sign — build 13's 403, verbatim in shape. */
function cloudThatCannotSign() {
  return async (request: Request): Promise<Response> => {
    if (request.url.includes(':signBlob')) {
      return Response.json(
        {
          error: {
            code: 403,
            message:
              'Permission iam.serviceAccounts.signBlob denied on resource',
          },
        },
        { status: 403 },
      );
    }
    return Response.json({ access_token: 'federated', expires_in: 3600 });
  };
}

const FEDERATION = {
  audience: '//iam.googleapis.com/projects/1/locations/global/x/y',
  tokenUrl: 'https://sts.googleapis.test/v1/token',
  tokenPath: '/var/run/secrets/spindrift/gcp-token',
  impersonationUrl:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
  readToken: async () => 'projected-jwt',
};

describe('a dispatch refusal the operator can see', () => {
  let ctx: CommandContext;
  let route: FakeBuildAdapter;
  let targetId: string;

  async function seedBuild(
    overrides: {
      readonly location?: string | null;
      readonly digest?: string | null;
      readonly appName?: string;
      readonly componentName?: string;
    } = {},
  ) {
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name: overrides.appName ?? `app-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'repo',
        sourceRepoUrl: 'jonpulsifer/infra',
        sourceRepoSubpath: 'apps/spindrift-demo/plain',
      })
      .returning();
    const [component] = await ctx.db
      .insert(components)
      .values({
        appId: app!.id,
        name: overrides.componentName ?? 'web',
        kind: 'service',
      })
      .returning();
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId });
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest:
          overrides.digest === undefined ? BUNDLE_DIGEST : overrides.digest,
        bundleLocation:
          overrides.location === undefined
            ? DEPOT_LOCATION
            : overrides.location,
      })
      .returning();
    return build!;
  }

  function withFederation(federation: unknown): CommandContext {
    return {
      ...ctx,
      manifest: {
        ...baseManifest,
        cloud: { ...baseManifest.cloud, federation },
      },
    } as CommandContext;
  }

  /** Every log line written against one Build, oldest first. */
  async function linesFor(
    context: CommandContext,
    buildId: number,
  ): Promise<string[]> {
    const rows = await context.db
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, buildId))
      .orderBy(asc(attemptEvents.id));
    return rows
      .filter((row) => row.eventType === 'log')
      .map((row) => row.line ?? '');
  }

  async function buildRow(context: CommandContext, buildId: number) {
    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, buildId));
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
    const [target] = await db
      .insert(targets)
      .values(targetValues({ name: 'target-a', rank: 1 }))
      .returning();
    targetId = target!.id;

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

  describe('a refusal no later tick can clear', () => {
    test('closes the Build out rather than retrying it forever', async () => {
      // A Build with no staged bundle location. Nothing about a later tick
      // stages one — staging happens where the Build is created — so leaving it
      // PENDING would be a row refused once a second until the table is dropped.
      const context = withFederation(FEDERATION);
      const build = await seedBuild({ location: null });

      const result = await dispatchBuild(
        { buildId: build.id, route: 'hosted' },
        context,
      );

      expect(result.ok).toBe(false);
      const row = await buildRow(context, build.id);
      expect(row.status).toBe('FAILED');
      expect(row.dispatchWaitingOn).toBeNull();
      expect(await linesFor(context, build.id)).toEqual([
        `Build ${build.id} has no staged bundle location, so no route can fetch it`,
      ]);
    });

    test('carries §6 reason and blame, so the screen can say who is at fault', async () => {
      const context = withFederation(FEDERATION);
      const build = await seedBuild({ digest: null });

      await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

      const [status] = await context.db
        .select()
        .from(attemptEvents)
        .where(eq(attemptEvents.buildId, build.id))
        .orderBy(desc(attemptEvents.id))
        .limit(1);
      expect(status?.eventType).toBe('status');
      expect(status?.phase).toBe('FAILED');
      // Spindrift held the bundle. Nothing the developer wrote caused this.
      expect(status?.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(status?.blame).toBe('platform');
    });
  });

  describe('a refusal a later tick can clear', () => {
    test('leaves the Build PENDING and records what it is waiting on', async () => {
      // The mirror of the case above, and the one that cost the hours: nothing
      // is wrong with this row, so an operator who configures federation gets
      // it dispatched without pressing anything again.
      const context = withFederation(null);
      const build = await seedBuild();

      const result = await dispatchBuild(
        { buildId: build.id, route: 'hosted' },
        context,
      );

      expect(result.ok).toBe(false);
      const row = await buildRow(context, build.id);
      expect(row.status).toBe('PENDING');
      expect(row.dispatchWaitingOn).toContain('federation');
      expect(await linesFor(context, build.id)).toEqual([
        row.dispatchWaitingOn ?? '',
      ]);
    });

    test('writes no status event, because the Build has not failed', async () => {
      const context = withFederation(null);
      const build = await seedBuild();

      await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

      const rows = await context.db
        .select()
        .from(attemptEvents)
        .where(eq(attemptEvents.buildId, build.id));
      expect(rows.every((row) => row.eventType === 'log')).toBe(true);
    });

    test('records the signing failure build 13 sat two hours in', async () => {
      // Federation is configured and impersonation works; `signBlob` is the one
      // call that is refused, because `workloadIdentityUser` carries
      // `getAccessToken` and not `iam.serviceAccounts.signBlob`. The location is
      // a good one, so this is a fact about the installation and not the row.
      const context = withFederation({
        ...FEDERATION,
        fetch: cloudThatCannotSign(),
      });
      const build = await seedBuild();

      await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

      const row = await buildRow(context, build.id);
      expect(row.status).toBe('PENDING');
      const [line] = await linesFor(context, build.id);
      expect(line).toContain('could not mint a signed URL');
      // The object, so an operator can go look it up. Never the signed URL.
      expect(line).toContain(DEPOT_LOCATION);
      expect(line).not.toContain('X-Goog-Signature');
    });
  });

  describe('the sentence names the missing prerequisite', () => {
    test('a route this installation does not have says to configure one', async () => {
      const context = withFederation(FEDERATION);
      const build = await seedBuild();

      const result = await dispatchBuild(
        { buildId: build.id, route: 'managed' },
        context,
      );

      expect(result.ok).toBe(false);
      const [line] = await linesFor(context, build.id);
      expect(line).toContain('managed');
      expect(line).toContain('configured');
      expect((await buildRow(context, build.id)).status).toBe('PENDING');
    });

    test('a Target threshold no route meets names the Target and the route', async () => {
      // §16: "the level is a threshold, then admin rank wins." Both halves are
      // configuration, so this waits rather than closing out.
      await ctx.db
        .update(targets)
        .set({ minBuildLevel: 3 })
        .where(eq(targets.id, targetId));
      const context = withFederation(FEDERATION);
      const build = await seedBuild();

      await dispatchBuild(
        { buildId: build.id, route: 'hosted', placementTargetId: targetId },
        context,
      );

      const [line] = await linesFor(context, build.id);
      expect(line).toContain('target-a');
      expect(line).toContain('fake');
      expect((await buildRow(context, build.id)).status).toBe('PENDING');
    });

    test('a Target no configured route can serve is recorded by the loop itself', async () => {
      // `runBuildPass` selects the route and skips the Build when there is
      // none, so this refusal never reaches `dispatchBuild` at all. Skipping
      // silently is the same disease with a different call site.
      const context = {
        ...withFederation(FEDERATION),
        adapters: { ...ctx.adapters, build: () => null },
      } as CommandContext;
      const build = await seedBuild();

      expect(await runBuildPass(context)).toBe(0);

      const row = await buildRow(context, build.id);
      expect(row.status).toBe('PENDING');
      const [line] = await linesFor(context, build.id);
      expect(line).toContain('no build route');
      expect(line).toContain('Target');
    });
  });

  describe('repeat suppression', () => {
    test('a Build refused every tick is written down once', async () => {
      // The loop runs at 1Hz and the refusal is durable, so the naive fix is a
      // log line a second. An operator wants to know a Build is waiting and
      // what on — not to read it several thousand times.
      const context = withFederation(null);
      const build = await seedBuild();

      for (let tick = 0; tick < 5; tick += 1) {
        await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);
      }

      expect(await linesFor(context, build.id)).toHaveLength(1);
    });

    test('through the loop as well, which is where the ticks actually come from', async () => {
      const context = withFederation(null);
      const build = await seedBuild();

      for (let tick = 0; tick < 5; tick += 1) {
        expect(await runBuildPass(context)).toBe(0);
      }

      expect(await linesFor(context, build.id)).toHaveLength(1);
    });

    test('a refusal that changes is news, and is written again', async () => {
      // Suppression is per sentence, not per Build: an operator who configures
      // federation and then hits the signing gap has been told two different
      // true things, and the second one is the one they need.
      const build = await seedBuild();
      const unconfigured = withFederation(null);
      const unsigned = withFederation({
        ...FEDERATION,
        fetch: cloudThatCannotSign(),
      });

      await dispatchBuild({ buildId: build.id, route: 'hosted' }, unconfigured);
      await dispatchBuild({ buildId: build.id, route: 'hosted' }, unconfigured);
      await dispatchBuild({ buildId: build.id, route: 'hosted' }, unsigned);
      await dispatchBuild({ buildId: build.id, route: 'hosted' }, unsigned);

      const lines = await linesFor(unsigned, build.id);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('no federation');
      expect(lines[1]).toContain('could not mint a signed URL');
    });

    test('a Build that dispatches stops waiting, so a later refusal reports again', async () => {
      // The claim clears the sentence. Without that, a Build whose lease expires
      // and is refused a second time would be suppressed against a sentence from
      // an attempt that is over.
      const build = await seedBuild();
      const unconfigured = withFederation(null);
      const configured = withFederation({
        ...FEDERATION,
        fetch: async (request: Request) =>
          request.url.includes(':signBlob')
            ? Response.json({ signedBlob: btoa('\x01\x02') })
            : Response.json({ access_token: 'federated', expires_in: 3600 }),
      });

      await dispatchBuild({ buildId: build.id, route: 'hosted' }, unconfigured);
      expect(
        (await buildRow(unconfigured, build.id)).dispatchWaitingOn,
      ).not.toBeNull();

      const dispatched = await dispatchBuild(
        { buildId: build.id, route: 'hosted' },
        configured,
      );
      expect(dispatched.ok).toBe(true);
      expect(
        (await buildRow(configured, build.id)).dispatchWaitingOn,
      ).toBeNull();
    });
  });
});
