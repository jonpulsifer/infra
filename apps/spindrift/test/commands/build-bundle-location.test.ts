// A `gs://` bundle needs a Google credential to fetch, so dispatch hands the
// route a signed URL instead.
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

const BUNDLE_DIGEST =
  'sha256:3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03';
const DEPOT_LOCATION =
  'gs://bluenose-spindrift-source/3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03.tgz';

/** A cloud that answers the token exchange and signs, and records nothing else. */
function fakeCloud() {
  return async (request: Request): Promise<Response> => {
    if (request.url.includes(':signBlob')) {
      return Response.json({ signedBlob: btoa('\x01\x02') });
    }
    return Response.json({ access_token: 'federated', expires_in: 3600 });
  };
}

describe('the bundle location a route is dispatched with', () => {
  let ctx: CommandContext;
  let route: FakeBuildAdapter;

  async function seedBuild(
    location: string,
    sourceKind: 'repo' | 'archive' = 'repo',
  ) {
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name: `app-${sourceKind}-${location.length}`,
        sourceKind,
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
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: BUNDLE_DIGEST,
        bundleLocation: location,
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

  const signable = {
    audience: '//iam.googleapis.com/projects/1/locations/global/x/y',
    tokenUrl: 'https://sts.googleapis.test/v1/token',
    tokenPath: '/var/run/secrets/spindrift/gcp-token',
    impersonationUrl:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
    fetch: fakeCloud(),
    readToken: async () => 'projected-jwt',
  };

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

  test('a depot address reaches the route as a URL curl can follow', async () => {
    const context = withFederation(signable);
    const build = await seedBuild(DEPOT_LOCATION);

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(true);

    const origin = route.built[0]?.source.origin;
    expect(origin?.location.startsWith('https://storage.googleapis.com/')).toBe(
      true,
    );
    expect(new URL(origin!.location).searchParams.get('X-Goog-Signature')).toBe(
      '0102',
    );
  });

  test('an archive source is resolved the same way a repository one is', async () => {
    // Both source kinds stage one bundle and read the same column.
    const context = withFederation(signable);
    const build = await seedBuild(DEPOT_LOCATION, 'archive');

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(true);
    expect(route.built[0]?.source.origin.type).toBe('archive');
    expect(route.built[0]?.source.origin.location.startsWith('https://')).toBe(
      true,
    );
  });

  test('the signed URL never lands on the operator-visible attempt log', async () => {
    // The signed URL is a short-lived bearer capability; the log records the
    // object.
    const context = withFederation(signable);
    const build = await seedBuild(DEPOT_LOCATION);
    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    const events = await context.db.select().from(attemptEvents);
    const written = JSON.stringify(events);
    expect(written).not.toContain('X-Goog-Signature');
    expect(written).not.toContain('storage.googleapis.com');
  });

  test('a location that is already fetchable passes through untouched', async () => {
    const context = withFederation(signable);
    const build = await seedBuild('https://staging.lolwtf.ca/bundle.tar.gz');

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(true);
    expect(route.built[0]?.source.origin.location).toBe(
      'https://staging.lolwtf.ca/bundle.tar.gz',
    );
  });

  test('refuses a pre-depot handle instead of handing it to curl', async () => {
    // `upload://` names the web pod's own disk and is not a URL curl can fetch.
    const context = withFederation(signable);
    const build = await seedBuild(`upload://${BUNDLE_DIGEST.slice(7)}`);

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_BUILDABLE');
      expect(result.failure.message).toContain('upload://');
      // The App, and what makes it buildable again.
      expect(result.failure.message).toContain('app-repo-');
      expect(result.failure.message).toContain('deploy');
    }
    expect(route.built).toHaveLength(0);
  });

  test('the refusal lands where the operator is already looking', async () => {
    // runBuildPass drops refusals and the location never becomes fetchable, so
    // the refusal is logged and the Build closed out.
    const context = withFederation(signable);
    const build = await seedBuild('upload://3f5cbbc2ced9');

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    const events = await context.db
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, build.id));
    expect(events.some((event) => event.line?.includes('upload://'))).toBe(
      true,
    );
    const terminal = events.find((event) => event.eventType === 'status');
    expect(terminal?.phase).toBe('FAILED');
    // The platform held the location, so the developer is not to blame.
    expect(terminal?.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(terminal?.blame).toBe('platform');

    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(row?.status).toBe('FAILED');
  });

  test('a federation gap leaves the Build for the next tick', async () => {
    // Nothing is wrong with the row, so once federation is configured a later
    // tick dispatches it.
    const context = withFederation(null);
    const build = await seedBuild(DEPOT_LOCATION);

    await dispatchBuild({ buildId: build.id, route: 'hosted' }, context);

    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(row?.status).toBe('PENDING');
  });

  test('tells an archive App to upload again rather than to redeploy', async () => {
    // Only a repo bundle can be staged again from the repository; an archive
    // has to be uploaded again.
    const context = withFederation(signable);
    const build = await seedBuild('upload://3f5cbbc2', 'archive');

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_BUILDABLE');
      expect(result.failure.message).toContain('upload');
      expect(result.failure.message).toContain('archive');
    }
    expect(route.built).toHaveLength(0);
  });

  test('refuses a location wearing no scheme at all', async () => {
    // Nothing stages a bundle without a scheme; only a hand-written row has
    // one.
    const context = withFederation(signable);
    const build = await seedBuild('bundles/site.zip');

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(route.built).toHaveLength(0);
  });

  test('refuses rather than dispatching a location no route could resolve', async () => {
    // Dispatching anyway would end at curl on the runner, blamed on the
    // developer.
    const context = withFederation(null);
    const build = await seedBuild(DEPOT_LOCATION);

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_BUILDABLE');
      expect(result.failure.message).toContain('no federation');
      expect(result.failure.message).toContain(DEPOT_LOCATION);
    }
    expect(route.built).toHaveLength(0);
  });
});
