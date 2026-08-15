/**
 * Build secrets (story 112, §4, §10).
 *
 * The claims worth breaking, each asserted here because an implementation that
 * lost one would still look like it worked:
 *
 * - **A separate list.** A build secret never enters the pinned config
 *   document, so rotating one mints no Deploy and changes no `configVersion`;
 *   and one key cannot be both runtime config and a build secret — the
 *   conversion is refused in both directions rather than silently applied.
 * - **Core resolves, the builder never holds a store credential.** The value
 *   reaches the route on the spec, resolved; the store is read through the
 *   contract's one narrow verb, at dispatch and nowhere else.
 * - **The refusal direction.** A route that cannot carry a held secret is
 *   refused before anything runs, and so is a declaration whose pinned version
 *   is gone — a build that would have run without its secret is the failure
 *   mode this ticket exists to prevent.
 * - **Provenance records the names.** The Build row says which secrets the
 *   run could read — names only, never values.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  BUILD_SECRET_VAR_PREFIX,
  buildKitProgram,
  buildSecretEnvOf,
} from '../../src/adapters/build/buildkit.ts';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { dispatchBuild } from '../../src/commands/builds/dispatch.ts';
import { setBuildSecrets } from '../../src/commands/config/build-secrets.ts';
import { readPinnedConfig } from '../../src/commands/config/pinned.ts';
import { setConfig } from '../../src/commands/config/set.ts';
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
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const clock: Clock = { now: () => new Date('2024-06-01T00:00:00.000Z') };

let store: FakeSecretStore;
let route: FakeBuildAdapter;
let supplyChain: SupplyChainHarness;

beforeEach(() => {
  store = new FakeSecretStore({ adapter: manifest.secretStore.adapter });
  route = new FakeBuildAdapter({ name: 'hosted' });
  supplyChain = new SupplyChainHarness();
});

function registry(deployAdapter: DeployAdapter): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: (name) => (name === route.name ? route : null),
    store: (adapter) => (adapter === store.adapter ? store : null),
    repository: () => null,
    supplyChain: () => supplyChain,
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

async function fixture(kind: ComponentKind = 'service') {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind, expose: true })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        discovery: CAPABLE_DISCOVERY,
      }),
    )
    .returning();
  return { app: app!, component: component!, target: target! };
}

async function stagedBuild(componentId: string) {
  const digest = `sha256:${'1'.repeat(64)}`;
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest,
      targetShape: 'image',
      artifactType: 'image',
      bundleDigest: digest,
      bundleLocation: 'https://depot.lolwtf.ca/bundles/site.zip',
      status: 'PENDING',
    })
    .returning();
  return build!;
}

describe('a build secret is a separate list', () => {
  test('the value goes to the store and the row pins it as build_secret', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const result = await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.written).toEqual(['NPM_TOKEN']);
      expect(result.value.declared).toEqual(['NPM_TOKEN']);
    }
    expect(store.puts.map((put) => put.key)).toEqual(['NPM_TOKEN']);

    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(row?.kind).toBe('build_secret');
    expect(row?.plainValue).toBeNull();
    expect(row?.storeRef).not.toBeNull();
  });

  test('it never enters the pinned config document, so rotation mints no Deploy', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const before = await readPinnedConfig(
      database().db,
      component.id,
      target.id,
    );
    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );
    const after = await readPinnedConfig(
      database().db,
      component.id,
      target.id,
    );

    expect(after.version).toBe(before.version);
    expect(after.document).toEqual(before.document);
  });

  test('one key, one kind: neither call converts the other’s row', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );
    const asConfig = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'other' }],
      },
      ctx,
    );
    expect(asConfig.ok).toBe(false);
    if (!asConfig.ok) {
      expect(asConfig.failure.message).toContain('build secret');
    }

    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'DATABASE_URL', value: 'postgres://db' }],
      },
      ctx,
    );
    const asSecret = await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'DATABASE_URL', value: 'postgres://db' }],
      },
      ctx,
    );
    expect(asSecret.ok).toBe(false);
    if (!asSecret.ok) {
      expect(asSecret.failure.message).toContain('runtime config');
    }
  });

  test('a website can hold one — its build needs the token its runtime never sees', async () => {
    const { component, target } = await fixture('website');
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const result = await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(store.puts.map((put) => put.key)).toEqual(['NPM_TOKEN']);
  });

  test('removal deletes the declaration', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );
    const removed = await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        removals: ['NPM_TOKEN'],
      },
      ctx,
    );

    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.value.declared).toEqual([]);
    }
  });
});

describe('dispatch resolves, refuses, and records', () => {
  test('the resolved values arrive on the spec, and the names on the Build row', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(true);
    expect(route.built[0]?.spec.buildSecrets).toEqual([
      { name: 'NPM_TOKEN', value: 'hunter2' },
    ]);

    const [recorded] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, build.id));
    expect(recorded?.buildSecretNames).toEqual(['NPM_TOKEN']);
  });

  test('a route that cannot carry a held secret is refused before anything runs', async () => {
    const { component, target } = await fixture();
    route = new FakeBuildAdapter({ name: 'hosted', carriesHeldSecret: false });
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) {
      expect(dispatched.failure.message).toContain('NPM_TOKEN');
      expect(dispatched.failure.message).toContain('cannot carry');
    }
    expect(route.built).toHaveLength(0);
  });

  test('a pinned version that is gone refuses the build, naming the key', async () => {
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(
        and(
          eq(configItems.componentId, component.id),
          eq(configItems.key, 'NPM_TOKEN'),
        ),
      );
    await store.destroy({
      key: row!.storeRef as string,
      version: row!.storeVersion as string,
    });

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted', placementTargetId: target.id },
      ctx,
    );

    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) {
      expect(dispatched.failure.message).toContain('NPM_TOKEN');
      expect(dispatched.failure.message).toContain('no longer resolves');
    }
    expect(route.built).toHaveLength(0);
  });

  test('without a placement there are no secrets to resolve', async () => {
    // The same parity build arguments hold (§2, §10): a Build is keyed on
    // shape, declarations on (Component, Target), and inventing a Target
    // would hand the build some other Target's credentials.
    const { component, target } = await fixture();
    const ctx = await context(
      registry(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setBuildSecrets(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'NPM_TOKEN', value: 'hunter2' }],
      },
      ctx,
    );

    const build = await stagedBuild(component.id);
    const dispatched = await dispatchBuild(
      { buildId: build.id, route: 'hosted' },
      ctx,
    );

    expect(dispatched.ok).toBe(true);
    expect(route.built[0]?.spec.buildSecrets).toEqual([]);
  });
});

describe('the program takes them as mounts, never as text', () => {
  const input = {
    bundleUrl: 'https://depot.example.test/bundle.tgz',
    bundleDigest: 'sha256:bundle',
    subpath: '.',
    destinations: ['registry.example.test/app'],
    tags: ['latest'],
    zeroConfigFrontend: 'registry.example.test/zero-config',
    buildArgs: {},
    buildSecretNames: ['NPM_TOKEN'],
  };

  test('one --secret per name, sourced from the file the env var filled', () => {
    const program = buildKitProgram(input);
    expect(program).toContain(`--secret id='NPM_TOKEN'`);
    expect(program).toContain(`${BUILD_SECRET_VAR_PREFIX}NPM_TOKEN`);
    expect(program).toContain(`unset ${BUILD_SECRET_VAR_PREFIX}NPM_TOKEN`);
  });

  test('no names, no mechanism: the bare program mentions none of it', () => {
    const bare = buildKitProgram({ ...input, buildSecretNames: [] });
    expect(bare).not.toContain('--secret');
    expect(bare).not.toContain(BUILD_SECRET_VAR_PREFIX);
  });

  test('the env a route sets is one variable per secret, prefixed', () => {
    expect(buildSecretEnvOf([{ name: 'NPM_TOKEN', value: 'hunter2' }])).toEqual(
      {
        [`${BUILD_SECRET_VAR_PREFIX}NPM_TOKEN`]: 'hunter2',
      },
    );
  });
});
