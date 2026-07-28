/**
 * Config, and the three claims §10 makes that would still "work" if they were
 * false (Task 30).
 *
 * - **Values are write-only.** The store contract has no verb that returns one,
 *   so the way this fails is not a bad call — it is a value that gets *kept* on
 *   its way past. So the assertion is over the database itself: after a set,
 *   every column of every table in this test's schema is searched for the
 *   plaintext. A future `plainValue` shortcut, a debug column, an audit row
 *   that "helpfully" recorded the old value: all of them fail here.
 * - **A rollback comes up with the configuration it originally had.** Asserted
 *   by configuring, deploying, reconfiguring, deploying, and rolling back — the
 *   only arrangement where re-reading current config and re-delivering the
 *   recorded document give different answers.
 * - **A cross-store re-placement is blocked until the named keys are supplied.**
 *   Asserted in both directions: the move refuses naming the keys, and the
 *   deploy that would skip the move refuses with the same sentence.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import type { SecretStore } from '../../src/adapters/store/contract.ts';
import {
  createDeploy,
  placeComponent,
  replaceConfig,
  rollbackDeploy,
  setConfig,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import type { StoreAdapter } from '../../src/config/manifest.schema.ts';
import {
  apps,
  builds,
  components,
  configAuditEvents,
  configItems,
  deploys,
  targets,
  users,
} from '../../src/db/schema.ts';
import { runConfigPass } from '../../src/reconciler/config-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** A digest of the right shape, distinct per call. */
function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

let store: FakeSecretStore;
/** A second store of record, for the Targets that are in front of another vault. */
let elsewhere: FakeSecretStore;

beforeEach(() => {
  store = new FakeSecretStore({ adapter: manifest.secretStore.adapter });
  elsewhere = new FakeSecretStore({
    adapter: 'onepassword',
    pinning: 'IMMUTABLE_ITEM_PER_VERSION',
  });
});

/**
 * A registry with one store per adapter name.
 *
 * Two, in the tests that need a store boundary to exist. §10 makes the store a
 * Target property — an admin-chosen one on a cluster, the vessel's own in the
 * cloud — so "these two Targets are in front of different vaults" is a
 * configuration an installation can have, and it is the only arrangement in
 * which a key can fail to follow a move.
 */
function registryOf(
  deployAdapter: DeployAdapter,
  stores: Partial<Record<StoreAdapter, SecretStore>> = {
    [manifest.secretStore.adapter]: store,
  },
): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: () => null,
    store: (adapter) => stores[adapter] ?? null,
    // §15's repository host plays no part in config: a value reaches the store,
    // never a repository.
    repository: () => null,
  };
}

/**
 * A context whose principal is a real `users` row.
 *
 * The audit trail names who acted (§10) and the column is a foreign key, so a
 * principal nobody enrolled is not a principal a config act can be attributed
 * to — which is the point.
 */
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

/** An App, a Component, and a Target that can reach this installation's store. */
async function fixture(
  options: { reachableSecretStores?: readonly string[] } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const target = await connectedTarget(options);
  return { app: app!, component: component!, target };
}

async function connectedTarget(
  options: { name?: string; reachableSecretStores?: readonly string[] } = {},
) {
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        name: options.name ?? `cluster-${crypto.randomUUID()}`,
        adapter: 'kubernetes',
        discovery: {
          ...CAPABLE_DISCOVERY,
          reachableSecretStores: (options.reachableSecretStores ?? [
            manifest.secretStore.adapter,
          ]) as TargetStores,
        },
      }),
    )
    .returning();
  return target!;
}

type TargetStores = (typeof CAPABLE_DISCOVERY)['reachableSecretStores'];

async function succeededBuild(componentId: string, seed: number) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest(seed),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest(seed),
      bundleDigest: digest(seed),
      bundleLocation: `bundles/${seed}.zip`,
      status: 'SUCCEEDED',
    })
    .returning();
  return build!;
}

/** Every text-ish value in this test's schema, as one list of strings. */
async function everythingStored(): Promise<string[]> {
  const { client, schema } = database();
  const tables = await client`
    select table_name from information_schema.tables
    where table_schema = ${schema}`;
  const found: string[] = [];
  for (const { table_name } of tables as { table_name: string }[]) {
    const rows = await client.unsafe(
      `select * from "${schema}"."${table_name}"`,
    );
    for (const row of rows as Record<string, unknown>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && value !== undefined) {
          found.push(JSON.stringify(value));
        }
      }
    }
  }
  return found;
}

describe('setConfig writes a reference, never a value', () => {
  test('the value reaches the store and nothing else', async () => {
    const { component, target } = await fixture();
    const secret = 'hunter2-abcdef-not-in-the-database';

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: secret }],
      },
      await context(
        registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written).toEqual(['TOKEN']);

    // The one place it is: the store, which is the far side.
    expect(store.puts.map((put) => put.key)).toEqual(['TOKEN']);

    // And nowhere else. Not in `config_items`, not in the audit trail, not in
    // the Deploy's document, not in an attempt event.
    const stored = await everythingStored();
    expect(stored.some((value) => value.includes(secret))).toBe(false);

    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(row?.storeRef).not.toBeNull();
    expect(row?.storeVersion).not.toBeNull();
    expect(row?.plainValue).toBeNull();
  });

  test('the audit trail is who changed which key when — and no more', async () => {
    const { component, target } = await fixture();
    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'one' }],
      },
      await context(
        registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
      ),
    );

    const [event] = await database()
      .db.select()
      .from(configAuditEvents)
      .where(eq(configAuditEvents.componentId, component.id));
    expect(event?.key).toBe('TOKEN');
    expect(event?.action).toBe('set');
    expect(event?.displayName).toBe('Operator');
    expect(Object.keys(event ?? {})).not.toContain('value');
  });

  test('a Target that cannot reach the store is refused', async () => {
    const { component } = await fixture();
    const unreachable = await connectedTarget({ reachableSecretStores: [] });

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: unreachable.id,
        entries: [{ key: 'TOKEN', value: 'one' }],
      },
      await context(
        registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('reaches no secret store');
  });
});

describe('a config change produces a new Deploy', () => {
  test('the pair redeploys what is live, under a new configVersion', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 1);
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );

    const first = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      commands,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const changed = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'one' }],
      },
      commands,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    expect(changed.value.deployId).not.toBeNull();
    expect(changed.value.notDeployed).toBeNull();
    expect(changed.value.configVersion).not.toBe(first.value.configVersion);

    // The same artifact: a config change redeploys what is running, never
    // something else.
    const [deploy] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, changed.value.deployId!));
    expect(deploy?.buildId).toBe(build.id);
    const document = deploy?.configDocument ?? [];
    expect(document).toHaveLength(1);
    expect(document[0]?.name).toBe('TOKEN');
    // Pinned, not floating: the entry names a version the store minted.
    expect(document[0]?.secret.version).toBeTruthy();
  });

  test('nothing deployed here yet is a sentence, not a Deploy', async () => {
    const { component, target } = await fixture();

    const result = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'one' }],
      },
      await context(
        registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deployId).toBeNull();
    expect(result.value.notDeployed).toContain('first deploy');
  });
});

describe('a rollback comes up with the configuration it originally had', () => {
  test('the older release delivers the document it was deployed with', async () => {
    const { component, target } = await fixture();
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    const older = await succeededBuild(component.id, 1);
    const newer = await succeededBuild(component.id, 2);

    // Configure, then ship both Builds with that configuration.
    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'first' }],
      },
      commands,
    );
    const first = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      commands,
    );
    const second = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      commands,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Reconfigure. This redeploys the *newer* Build — the one that is live —
    // under a new version, and leaves the older release's document alone.
    const changed = await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'second' }],
      },
      commands,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.configVersion).not.toBe(first.value.configVersion);

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      commands,
    );
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    // The claim: the rollback comes up with the configuration that release
    // had, not the configuration set since.
    expect(rolled.value.configVersion).toBe(first.value.configVersion);
    expect(rolled.value.configVersion).not.toBe(changed.value.configVersion);

    const [restored] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, rolled.value.deployId));
    const [original] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, first.value.deployId));
    expect(restored?.configDocument).toEqual(original!.configDocument!);
    expect(restored?.configDocument).not.toEqual([]);
  });
});

describe('a cross-store re-placement is blocked until the keys are supplied', () => {
  /**
   * One Component configured on a Target, and a second Target to move to.
   *
   * Both stores are writable by this installation, so a Target that reaches
   * only the second is a Target with a real store of record — just not the one
   * the configuration is in. That is the boundary §10 names, and the only
   * arrangement where a key cannot follow.
   */
  async function configuredElsewhere(destinationStores: readonly string[]) {
    const { component, target } = await fixture();
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' }), {
        [manifest.secretStore.adapter]: store,
        onepassword: elsewhere,
      }),
    );
    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [
          { key: 'TOKEN', value: 'one' },
          { key: 'DSN', value: 'two' },
        ],
      },
      commands,
    );
    const destination = await connectedTarget({
      name: `elsewhere-${crypto.randomUUID()}`,
      reachableSecretStores: destinationStores,
    });
    return { component, target, destination, commands };
  }

  test('Place names the keys and refuses', async () => {
    const { component, destination, commands } = await configuredElsewhere([
      'onepassword',
    ]);

    const moved = await placeComponent(
      { componentId: component.id, targetId: destination.id, supply: [] },
      commands,
    );

    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.failure.code).toBe('NOT_DEPLOYABLE');
    expect(moved.failure.message).toContain('DSN');
    expect(moved.failure.message).toContain('TOKEN');
  });

  test('and the deploy that would skip Place refuses too', async () => {
    const { component, destination, commands } = await configuredElsewhere([
      'onepassword',
    ]);
    const build = await succeededBuild(component.id, 1);

    const deployed = await createDeploy(
      {
        componentId: component.id,
        targetId: destination.id,
        buildId: build.id,
      },
      commands,
    );

    expect(deployed.ok).toBe(false);
    if (deployed.ok) return;
    expect(deployed.failure.message).toContain('supply');
  });

  test('supplying them commits the move', async () => {
    const { component, destination, commands } = await configuredElsewhere([
      'onepassword',
    ]);

    const moved = await placeComponent(
      {
        componentId: component.id,
        targetId: destination.id,
        supply: [
          { key: 'TOKEN', value: 'again' },
          { key: 'DSN', value: 'again' },
        ],
      },
      commands,
    );

    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.written).toEqual(['DSN', 'TOKEN']);
    // Nothing was carried: there was no shared store to carry a reference over.
    expect(moved.value.carried).toEqual([]);

    const rows = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.targetId, destination.id));
    expect(rows.map((row) => row.key).sort()).toEqual(['DSN', 'TOKEN']);
  });

  test('a move within one store carries the references, writing no value', async () => {
    const { component, destination, commands } = await configuredElsewhere([
      manifest.secretStore.adapter,
    ]);
    const putsBefore = store.puts.length;

    const moved = await placeComponent(
      { componentId: component.id, targetId: destination.id, supply: [] },
      commands,
    );

    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect([...moved.value.carried].sort()).toEqual(['DSN', 'TOKEN']);
    // §10: "cluster-to-cluster re-placement is free." Free means the store was
    // not written to at all.
    expect(store.puts.length).toBe(putsBefore);

    const rows = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.targetId, destination.id));
    expect(rows.map((row) => row.key).sort()).toEqual(['DSN', 'TOKEN']);
  });
});

describe('replaceConfig is replace-with-diff', () => {
  test('the review writes nothing and names what would change', async () => {
    const { component, target } = await fixture();
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [
          { key: 'TOKEN', value: 'one' },
          { key: 'GONE', value: 'two' },
        ],
      },
      commands,
    );
    const putsBefore = store.puts.length;

    const review = await replaceConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [
          { key: 'TOKEN', value: 'rewritten' },
          { key: 'FRESH', value: 'new' },
        ],
        confirm: false,
      },
      commands,
    );

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value).toEqual({
      applied: false,
      added: ['FRESH'],
      rewritten: ['TOKEN'],
      removed: ['GONE'],
    });
    expect(store.puts.length).toBe(putsBefore);
  });

  test('confirming applies the whole upload, removals included', async () => {
    const { component, target } = await fixture();
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    await setConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [
          { key: 'TOKEN', value: 'one' },
          { key: 'GONE', value: 'two' },
        ],
      },
      commands,
    );

    const applied = await replaceConfig(
      {
        componentId: component.id,
        targetId: target.id,
        entries: [{ key: 'TOKEN', value: 'rewritten' }],
        confirm: true,
      },
      commands,
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.applied).toBe(true);

    const rows = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(rows.map((row) => row.key)).toEqual(['TOKEN']);

    const [removal] = await database()
      .db.select()
      .from(configAuditEvents)
      .where(
        and(
          eq(configAuditEvents.key, 'GONE'),
          eq(configAuditEvents.action, 'removed'),
        ),
      );
    expect(removal).toBeDefined();
  });
});

describe('retention is core’s, at a depth a rollback can reach', () => {
  test('the loop destroys what is past the depth and nothing else', async () => {
    const { component, target } = await fixture();
    const commands = await context(
      registryOf(new FakeDeployAdapter({ adapter: 'kubernetes' })),
    );
    for (const value of ['one', 'two', 'three', 'four']) {
      await setConfig(
        {
          componentId: component.id,
          targetId: target.id,
          entries: [{ key: 'TOKEN', value }],
        },
        commands,
      );
    }

    const reports = await runConfigPass({
      db: database().db,
      store,
      retention: 2,
    });

    expect(reports).toEqual([
      {
        componentId: component.id,
        targetId: target.id,
        key: 'TOKEN',
        destroyed: 2,
      },
    ]);
    const left = await store.versions(
      { app: 'shop', component: 'web', target: target.name },
      'TOKEN',
    );
    expect(left).toHaveLength(2);

    // The newest is still the one the current pin names, so what is deployed
    // still resolves.
    const [row] = await database()
      .db.select()
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(
      await store.describe({
        key: row!.storeRef!,
        version: row!.storeVersion!,
      }),
    ).not.toBeNull();
  });
});
