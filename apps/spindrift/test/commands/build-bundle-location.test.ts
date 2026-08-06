/**
 * What a build route is handed as its bundle location (ticket 23).
 *
 * §15 stages one immutable bundle "for either builder", and the durable address
 * of that bundle is a `gs://` object nothing without a Google credential can
 * resolve. Turning it into something the builder can fetch is `dispatchBuild`'s
 * job; getting it wrong is a build that dies at `curl` and blames the developer
 * for it.
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
    // Handing the route the stored location verbatim is what this rules out: it
    // is not always a URL, and `curl` answers "Protocol upload not supported or
    // disabled in libcurl" before the build reads a line of the App's code.
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

  test('refuses a pre-depot handle instead of handing it to curl', async () => {
    // Build 10, verbatim. `upload://` names the web pod's own disk and is
    // deliberately not a URL, which makes it precisely what this function exists
    // to catch — and it was the one scheme it let through, so the refusal
    // arrived as `curl: (1) Protocol "upload" not supported or disabled in
    // libcurl` on a hosted runner instead of as a sentence before dispatch.
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
    // `runBuildPass` keeps the successes and drops everything else, so a
    // refusal that is only returned is a Build stuck PENDING with nobody told
    // why, retried every second. This one is written to the attempt log and
    // closes the Build out, because the location is a column on the row and no
    // later tick will make it fetchable.
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
    // §6: nothing the developer wrote caused this. Spindrift held the location.
    expect(terminal?.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(terminal?.blame).toBe('platform');

    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(row?.status).toBe('FAILED');
  });

  test('a federation gap leaves the Build for the next tick', async () => {
    // The mirror of the case above: nothing is wrong with this row, so the
    // Build stays PENDING and an operator who configures federation gets it
    // dispatched rather than having to press anything again.
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
    // §15: "repo bundles are ephemeral, archives durable." Only one of the two
    // can be produced a second time from something Spindrift holds, so only one
    // of them is told to deploy again.
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
    // Nothing stages one — a bundle is a `gs://` object or an `upload://`
    // handle — so this only ever arrives from a row somebody wrote by hand, and
    // `curl bundles/site.zip` is not a fetch either.
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
