/**
 * A website's build-time configuration (Task 31, §4, §10).
 *
 * §10 allows exactly one exception to "everything goes to the store", and §4
 * says why it is safe: "whatever a website bakes becomes public anyway, so **no
 * builder ever holds a store credential**." Both halves are asserted here,
 * because an implementation that got either one wrong would still look like it
 * worked:
 *
 * - A website's value must **not** reach the store. A version put there and
 *   never read would pass every other test in the suite while quietly requiring
 *   the builder to be able to read it back.
 * - A service's value must **still** reach the store. An exception that widened
 *   to every kind is the failure this exception is worth being narrow about.
 *
 * And the mechanical half: the arguments have to actually arrive at the route,
 * because build arguments core computed and never handed over are configuration
 * that silently does nothing.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { CONCURRENT_BUILDS_PER_APP } from '../../src/commands/builds/dispatch.ts';
import { dispatchBuild, setConfig } from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  configItems,
  targets,
  users,
} from '../../src/db/schema.ts';
import type { ComponentKind } from '../../src/domain/desired-state.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const clock: Clock = { now: () => new Date('2024-06-01T00:00:00.000Z') };

let store: FakeSecretStore;
let route: FakeBuildAdapter;

beforeEach(() => {
  store = new FakeSecretStore({ adapter: manifest.secretStore.adapter });
  route = new FakeBuildAdapter({ name: 'hosted' });
});

function registry(
  deployAdapter: DeployAdapter,
  options: { store?: boolean } = {},
): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: (name) => (name === route.name ? route : null),
    store: (adapter) =>
      options.store === false || adapter !== store.adapter ? null : store,
    repository: () => null,
  };
}

async function context(adapters: AdapterRegistry): Promise<CommandContext> {
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return {
    principal: { id: user!.id, displayName: user!.displayName },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** An App, one Component of the given kind, and a Target to configure it on. */
async function fixture(
  kind: ComponentKind,
  options: { reachesStore?: boolean; minBuildLevel?: number } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind, expose: true })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cluster-${crypto.randomUUID()}`,
        adapter: 'kubernetes',
        ...(options.minBuildLevel === undefined
          ? {}
          : { minBuildLevel: options.minBuildLevel }),
        discovery: {
          ...CAPABLE_DISCOVERY,
          reachableSecretStores:
            options.reachesStore === false
              ? []
              : CAPABLE_DISCOVERY.reachableSecretStores,
        },
      }),
    )
    .returning();
  return { app: app!, component: component!, target: target! };
}

/** A Build with a staged bundle, ready for a route to be handed it. */
async function stagedBuild(componentId: string) {
  const digest = `sha256:${'1'.repeat(64)}`;
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest,
      targetShape: 'files',
      artifactType: 'files',
      bundleDigest: digest,
      bundleLocation: 'bundles/site.zip',
      status: 'PENDING',
    })
    .returning();
  return build!;
}

describe('a website’s configuration is baked, not delivered', () => {
  test('the value is an ordinary row and the store is never touched', async () => {
    // §4: "no builder ever holds a store credential" — which is only true if
    // there is nothing in the store for a builder to need one for.
    const { component, target } = await fixture('website');

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'PUBLIC_API', value: 'https://api.example.test' }],
      },
      await context(registry(new FakeDeployAdapter({ adapter: 'kubernetes' }))),
    );

    expect(result.ok).toBe(true);
    expect(store.puts).toEqual([]);

    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(row?.kind).toBe('plain');
    expect(row?.plainValue).toBe('https://api.example.test');
    expect(row?.storeRef).toBeNull();
  });

  test('a website cannot reference a stored secret, on any Target', async () => {
    // The reach rule is about delivery, and nothing here is delivered. A
    // website on a Target in front of no vault is a supported arrangement.
    const { component, target } = await fixture('website', {
      reachesStore: false,
    });

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'PUBLIC_API', value: 'https://api.example.test' }],
      },
      await context(
        registry(new FakeDeployAdapter({ adapter: 'kubernetes' }), {
          store: false,
        }),
      ),
    );

    expect(result.ok).toBe(true);
    expect(store.puts).toEqual([]);
  });

  test('the change produces no Deploy, and says why', async () => {
    // Re-applying the artifact that is already serving would deliver the old
    // value with a new `configVersion` beside it — green, and wrong.
    const { component, target } = await fixture('website');

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'PUBLIC_API', value: 'https://api.example.test' }],
      },
      await context(registry(new FakeDeployAdapter({ adapter: 'kubernetes' }))),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deployId).toBeNull();
      expect(result.value.notDeployed).toContain('next build');
    }
  });

  test('the pinned document stays empty, because there is nothing pinned', async () => {
    // `configVersion` is a hash over *pinned references* (§10). A plain row has
    // none, so a website's delivery document is empty — which is what keeps a
    // build argument out of a delivery CR.
    const { component, target } = await fixture('website');
    const registered = registry(
      new FakeDeployAdapter({ adapter: 'kubernetes' }),
    );

    const first = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'A', value: 'one' }],
      },
      await context(registered),
    );
    const second = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'B', value: 'two' }],
      },
      await context(registered),
    );

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.configVersion).toBe(first.value.configVersion);
    }
  });
});

describe('the route receives them as build arguments', () => {
  test('a website’s rows arrive on the build spec', async () => {
    const { component, target } = await fixture('website');
    const registered = registry(
      new FakeDeployAdapter({ adapter: 'kubernetes' }),
    );
    const ctx = await context(registered);

    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [
          { key: 'PUBLIC_API', value: 'https://api.example.test' },
          { key: 'SITE_NAME', value: 'shop' },
        ],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(true);
    expect(route.built[0]?.spec.buildArgs).toEqual({
      PUBLIC_API: 'https://api.example.test',
      SITE_NAME: 'shop',
    });
  });

  test('without a placement there are no arguments to derive', async () => {
    // A Build is keyed on shape and configuration is keyed on Target (§2, §10),
    // so a dispatch that names no placement has no Target to read rows for —
    // and inventing one would bake some other Target's values.
    const { component, target } = await fixture('website');
    const registered = registry(
      new FakeDeployAdapter({ adapter: 'kubernetes' }),
    );
    const ctx = await context(registered);

    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'PUBLIC_API', value: 'https://api.example.test' }],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    await dispatchBuild({ buildId: build.id, route: 'hosted' }, ctx);

    expect(route.built[0]?.spec.buildArgs).toEqual({});
  });
});

describe('a Target’s minimum build level is a threshold', () => {
  test('a Target refuses a route below its minimum, before anything runs', async () => {
    // §16: "the level is a threshold, then admin rank wins." Refusing at
    // dispatch costs nothing; an artifact built below the minimum is a green
    // build followed by an admission failure nobody reading the build log can
    // explain.
    const { component, target } = await fixture('service', {
      minBuildLevel: 3,
    });
    route = new FakeBuildAdapter({ name: 'hosted', buildLevel: 1 });
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) {
      expect(dispatched.failure.message).toContain('L3');
    }
    expect(route.built).toHaveLength(0);
  });

  test('a route at or above the minimum runs', async () => {
    const { component, target } = await fixture('service', {
      minBuildLevel: 2,
    });
    route = new FakeBuildAdapter({ name: 'hosted', buildLevel: 2 });
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(true);
    expect(route.built).toHaveLength(1);
  });

  test('a dispatch naming no placement has no threshold to clear', async () => {
    // A Build is keyed on a shape and not on a Target (§2), so a build with no
    // placement is legitimate — there is simply no Target whose minimum applies.
    const { component } = await fixture('service', { minBuildLevel: 3 });
    route = new FakeBuildAdapter({ name: 'hosted', buildLevel: 1 });
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      ctx,
    );

    expect(dispatched.ok).toBe(true);
  });
});

describe('builds run concurrently up to a per-App limit', () => {
  test('the limit is refused rather than queued', async () => {
    // §4 removes the ordinal, so nothing is waiting on a slot: a build records
    // an artifact rather than deploying one, and a queue position would mean
    // nothing. Refusing is the honest answer.
    const { app, component } = await fixture('service');
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    for (let n = 0; n < CONCURRENT_BUILDS_PER_APP; n += 1) {
      await database()
        .db.insert(builds)
        .values({
          componentId: component.id,
          commit: `sha256:${String(n).repeat(64).slice(0, 64)}`,
          targetShape: 'image',
          artifactType: 'image',
          bundleDigest: `sha256:${'2'.repeat(64)}`,
          bundleLocation: 'bundles/site.zip',
          status: 'RUNNING',
        });
    }

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      ctx,
    );

    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) {
      expect(dispatched.failure.message).toContain(app.name);
    }
    expect(route.built).toHaveLength(0);
  });
});

describe('the exception stays narrow', () => {
  test('a service’s value still goes to the store, unread', async () => {
    const { component, target } = await fixture('service');

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'hunter2' }],
      },
      await context(registry(new FakeDeployAdapter({ adapter: 'kubernetes' }))),
    );

    expect(result.ok).toBe(true);
    expect(store.puts.map((put) => put.key)).toEqual(['TOKEN']);

    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(
        and(
          eq(configItems.componentId, component.id),
          eq(configItems.key, 'TOKEN'),
        ),
      );
    expect(row?.kind).toBe('secret_ref');
    expect(row?.plainValue).toBeNull();
  });

  test('a service gets no build arguments, whatever it is configured with', async () => {
    // Derived mechanically from kind (§10) and from nothing else: there is no
    // input a developer could use to opt a credential into a build argument.
    const { component, target } = await fixture('service');
    const registered = registry(
      new FakeDeployAdapter({ adapter: 'kubernetes' }),
    );
    const ctx = await context(registered);

    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(route.built[0]?.spec.buildArgs).toEqual({});
  });
});
