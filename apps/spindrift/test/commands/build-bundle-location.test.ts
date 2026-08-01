/**
 * What a build route is handed as its bundle location (ticket 23).
 *
 * §15 stages one immutable bundle "for either builder", and the durable address
 * of that bundle is a `gs://` object nothing without a Google credential can
 * resolve. Turning it into something the builder can fetch is `dispatchBuild`'s
 * job, and getting it wrong is what produced a build that died at `curl` and
 * blamed the developer for it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
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
import { fixtureManifest, targetValues } from '../harness/installation.ts';

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
    await db
      .insert(targets)
      .values(targetValues({ name: 'target-a', rank: 1 }));

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
    // The defect verbatim: the route used to receive the stored location, and
    // the stored location was not a URL. `curl` answered
    // "Protocol upload not supported or disabled in libcurl" and the build died
    // before it read a line of the App's code.
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
    // Build 9 was `origin.type = repo` and still carried an `upload://`
    // location, because §15 stages one bundle for either builder. Both arms
    // read the same column, so both arms have to be resolved here.
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
    // It is a bearer capability with a short TTL. The log records the object,
    // which is the thing an operator actually wants to look up anyway.
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

  test('refuses rather than dispatching a location no route could resolve', async () => {
    // Dispatching anyway is exactly what produced build 9: a green runner, a
    // dead `curl`, and a developer sent to debug a Dockerfile that never ran.
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
