/**
 * What dispatch does with a held registry credential (§13's exception, §16).
 *
 * Two behaviours, and the second is the one that would be expensive to get
 * wrong.
 *
 * **It opens the credential for the destinations being pushed to**, and only
 * those. Nothing is handed over for a registry the route's own identity already
 * reaches, which is every registry in an installation that stores nothing.
 *
 * **It refuses a route that cannot carry one, before the claim.** The hosted
 * route is dispatched through `workflow_dispatch`, whose inputs GitHub renders
 * in the run header — so a credential travelling in that spec would be
 * published to everyone who can see the run, in a repository §15 deliberately
 * does not require the installation to own. The refusal `waits` rather than
 * closing the Build out, because admitting a different route is a thing an
 * operator can do that makes the next tick work.
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
  builds,
  components,
  componentTargetDesired,
  targets,
  users,
} from '../../src/db/schema.ts';
import type { RegistryFlavour } from '../../src/domain/artifact-name.ts';
import type {
  RegistryAuth,
  RegistryCredentialStore,
} from '../../src/storage/registry-credentials.ts';
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
const DEPOT_LOCATION = `https://depot.example.test/${BUNDLE_DIGEST.slice(7)}.tgz`;

/** The host the fixture manifest's one registry lives on. */
const HELD: RegistryAuth = {
  host: 'registry.example.test',
  username: 'an-owner',
  secret: 'a-token',
};

/** A credential store holding whatever a test says it holds. */
function credentialStore(held: readonly RegistryAuth[]): {
  store: RegistryCredentialStore;
  asked: string[][];
} {
  const asked: string[][] = [];
  return {
    asked,
    store: {
      put: async () => undefined,
      forget: async () => false,
      list: async () =>
        held.map((one) => ({
          host: one.host,
          username: one.username,
          updatedAt: new Date(0),
        })),
      authFor: async (hosts) => {
        asked.push([...hosts]);
        return held.filter((one) => hosts.includes(one.host));
      },
    },
  };
}

describe('a build whose destination needs a stored credential', () => {
  let ctx: CommandContext;
  let route: FakeBuildAdapter;
  let targetId: string;

  async function seedBuild() {
    const [app] = await ctx.db
      .insert(apps)
      .values({ name: 'shop', sourceKind: 'archive' })
      .returning();
    const [component] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId });
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: BUNDLE_DIGEST,
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: BUNDLE_DIGEST,
        bundleLocation: DEPOT_LOCATION,
      })
      .returning();
    return build!;
  }

  /**
   * The context, with a credential store and a route of a given disposition.
   *
   * `selfAuthorized` omits `other` — the flavour of the fixture's registry —
   * because that is what this whole block is about. A destination only *needs*
   * a stored credential where the route's own identity cannot reach it, so a
   * route that self-authorized this host would make every case below vacuous.
   * The `selfAuthorized` block at the end is the other half of that statement.
   */
  function withCredentials(
    held: readonly RegistryAuth[],
    carries = true,
    selfAuthorized: readonly RegistryFlavour[] = [
      'artifactRegistry',
      'dockerHub',
      'ghcr',
    ],
  ): { context: CommandContext; asked: string[][] } {
    const { store, asked } = credentialStore(held);
    route = new FakeBuildAdapter({
      carriesRegistryCredential: carries,
      selfAuthorizedRegistries: selfAuthorized,
    });
    return {
      asked,
      context: {
        ...ctx,
        adapters: {
          ...ctx.adapters,
          build: (name: string) => (name === 'hosted' ? route : null),
          registryCredentials: () => store,
        },
      } as CommandContext,
    };
  }

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
    const vessel = await insertVessel(db, 'kubernetes', { name: 'target-a' });
    const [target] = await db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id, rank: 1 }))
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
      clock: { now: () => new Date('2026-08-02T12:00:00.000Z') },
      manifest: baseManifest,
      operatorId: operator!.id,
      principal: {
        type: 'user',
        id: operator!.id,
        displayName: 'Operator',
      },
    } as CommandContext;
  });

  test('hands it to a route that can carry one', async () => {
    const { context, asked } = withCredentials([HELD]);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(true);
    // Asked about the destinations' hosts, deduplicated — not about every
    // registry the installation has ever heard of.
    expect(asked).toEqual([[HELD.host]]);
    expect(route.built[0]?.spec.registryAuth).toEqual([HELD]);
  });

  test('hands over nothing when none is held', async () => {
    // Self-authorized here, because with nothing held and nothing the route can
    // reach on its own there is no publishable registry at all — that is a
    // different refusal, tested elsewhere.
    const { context } = withCredentials([], true, [
      'artifactRegistry',
      'dockerHub',
      'ghcr',
      'other',
    ]);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(true);
    expect(route.built[0]?.spec.registryAuth).toEqual([]);
  });

  /**
   * The refusal that exists so a token is never published. It has to happen
   * before the claim, so the Build is still dispatchable once the operator
   * admits a route that can carry one.
   */
  test('refuses a route that cannot carry one, and never dispatches', async () => {
    const { context } = withCredentials([HELD], false);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain(HELD.host);
    expect(route.built).toEqual([]);

    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, build.id));
    // `waits`, not `closes`: the Build stays dispatchable, and what is being
    // waited on is written down where the operator reads it.
    expect(row?.status).toBe('PENDING');
    expect(row?.dispatchWaitingOn).toContain(HELD.host);
  });

  test('and the refusal never names the secret', async () => {
    const { context } = withCredentials([HELD], false);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).not.toContain(HELD.secret);

    const [row] = await context.db
      .select()
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(JSON.stringify(row)).not.toContain(HELD.secret);
  });

  /**
   * The regression that stopped every build on the hosted route.
   *
   * GHCR's credential is *minted per dispatch* from the GitHub OAuth the
   * installation already holds, so the store answers for `ghcr.io` whenever the
   * connector is authorized — there is no row to delete and no way to "not hold
   * one". Dispatch asked about every destination host, got that credential
   * back, and refused, on the one route whose own workflow logs into GHCR with
   * the run's token and needs nothing from here.
   *
   * The fix is that a host the route self-authorizes is never asked about, so
   * the store's willingness to answer stops being what decides.
   */
  test('never asks about a host the route authorizes itself', async () => {
    const { context, asked } = withCredentials([HELD], false, [
      'artifactRegistry',
      'dockerHub',
      'ghcr',
      'other',
    ]);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    // Dispatched, on a route that cannot carry a credential, while the store
    // holds one for exactly this host. Before the fix this was the refusal.
    expect(result.ok).toBe(true);
    expect(asked).toEqual([[]]);
    expect(route.built[0]?.spec.registryAuth).toEqual([]);
  });

  /** A route that self-authorizes *some* flavours still needs the others. */
  test('asks only about the hosts it cannot reach on its own', async () => {
    const { context, asked } = withCredentials([HELD], true, [
      'artifactRegistry',
      'ghcr',
    ]);
    const build = await seedBuild();

    const result = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      context,
    );

    expect(result.ok).toBe(true);
    expect(asked).toEqual([[HELD.host]]);
    expect(route.built[0]?.spec.registryAuth).toEqual([HELD]);
  });
});
