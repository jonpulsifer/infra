/**
 * The Datastore lifecycle commands against a real Postgres (§11).
 *
 * Four verbs and one constraint. What is asserted here is the half a unit test
 * of each command could not see:
 *
 * - the **unique key** is what stops two Datastores of one name on one Target,
 *   and `createDatastore` is ordered so it fires before the adapter is ever
 *   called — the object is not created and then discovered to be somebody
 *   else's;
 * - a **refused provision leaves no row**, so a retry is an ordinary create
 *   rather than a collision with the wreckage of the last attempt;
 * - the **attach guards** refuse the states that would leave an App
 *   un-deployable, rather than letting a deploy discover them later;
 * - **`destroy` reaches the adapter for a managed row and never for an
 *   external one**, which is §13's "never destroy as a side effect" in the one
 *   place the side effect would be somebody else's database.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  attachDatastore,
  createDatastore,
  destroyDatastore,
  detachDatastore,
  listDatastores,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  components,
  datastores,
  type NewTarget,
  targets,
} from '../../src/db/schema.ts';
import { targetRowLabel } from '../../src/domain/target.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDatastoreAdapter } from '../harness/fakes/datastore-adapter.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const clock: Clock = { now: () => new Date('2024-06-01T00:00:00.000Z') };

/** `contextWith`, with the clock overridden — what {@link listDatastores}'s ordering test needs two rows apart in time to prove. */
function contextAt(
  datastore: FakeDatastoreAdapter | null,
  at: string,
): CommandContext {
  return { ...contextWith(datastore), clock: { now: () => new Date(at) } };
}

function contextWith(datastore: FakeDatastoreAdapter | null): CommandContext {
  const deploy = new FakeDeployAdapter();
  const adapters: AdapterRegistry = {
    deploy: () => deploy,
    build: () => null,
    store: () => null,
    repository: () => null,
    supplyChain: () => {
      throw new Error('a datastore command reached the supply chain');
    },
    ...(datastore === null ? {} : { datastore: () => datastore }),
  };
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/**
 * A connected, capable cluster Target — the one every case below sits on.
 *
 * Its own vessel each time, because (vessel_id, adapter) is unique and the
 * cases that need two Targets need two boundaries to hang them on.
 */
async function aTarget(overrides: Partial<NewTarget> = {}) {
  const vessel = await insertVessel(database().db, 'kubernetes');
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        vesselId: vessel.id,
        discovery: CAPABLE_DISCOVERY,
        ...overrides,
      }),
    )
    .returning();
  return target!;
}

async function anApp(name = `app-${crypto.randomUUID()}`) {
  const [app] = await database()
    .db.insert(apps)
    .values({ name, sourceKind: 'archive' })
    .returning();
  return app!;
}

describe('createDatastore', () => {
  test('provisions, and stores the adapter’s handle', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();

    const result = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    expect(backend.provisioned).toEqual([
      { name: 'orders', engine: 'postgres', storageGiB: 10 },
    ]);
    const [row] = await database()
      .db.select()
      .from(datastores)
      .where(eq(datastores.name, 'orders'));
    expect(row?.ref).toBe('postgres/fixture/orders');
    expect(row?.provenance).toBe('managed');
    // PENDING, not LIVE: the row records that an object was asked for, and the
    // loop is what learns whether it came up.
    expect(row?.phase).toBe('PENDING');
    expect(row?.connectionRef).toBeNull();
    expect(row?.appId).toBeNull();
  });

  test('a duplicate name on one Target is refused before the adapter is called', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const input = {
      name: 'orders',
      engine: 'postgres' as const,
      targetId: target.id,
      storageGiB: 10,
    };
    await createDatastore(input, contextWith(backend));

    const second = await createDatastore(input, contextWith(backend));

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.failure.code).toBe('NOT_DEPLOYABLE');
    // The whole reason the row is inserted first: the second call created
    // nothing on the far side to have to reclaim.
    expect(backend.provisioned).toHaveLength(1);
  });

  test('the same name on a second Target is two Datastores', async () => {
    const backend = new FakeDatastoreAdapter();
    const here = await aTarget();
    const there = await aTarget({ rank: 1 });

    const first = await createDatastore(
      { name: 'primary', engine: 'valkey', targetId: here.id, storageGiB: 1 },
      contextWith(backend),
    );
    const second = await createDatastore(
      { name: 'primary', engine: 'valkey', targetId: there.id, storageGiB: 1 },
      contextWith(backend),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  test('a refused provision leaves no row behind', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter({
      provisionThrows: 'a Vessel carries no network to place an endpoint in',
    });

    const result = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toBe(
      'a Vessel carries no network to place an endpoint in',
    );
    expect(await database().db.select().from(datastores)).toEqual([]);
  });

  test('refuses a Target that does not serve the engine', async () => {
    const target = await aTarget({
      discovery: { ...CAPABLE_DISCOVERY, postgres: false },
    });
    const backend = new FakeDatastoreAdapter();

    const result = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toContain(
      'does not serve postgres',
    );
    expect(backend.provisioned).toEqual([]);
  });

  test('refuses when this installation ships no datastore adapter', async () => {
    const target = await aTarget();

    const result = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(null),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOT_DEPLOYABLE');
  });
});

describe('attachDatastore', () => {
  test('attaches, and attaching again is not an error', async () => {
    const target = await aTarget();
    const app = await anApp();
    const backend = new FakeDatastoreAdapter();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;

    const first = await attachDatastore(
      { datastoreId, appId: app.id },
      contextWith(backend),
    );
    const again = await attachDatastore(
      { datastoreId, appId: app.id },
      contextWith(backend),
    );

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    const [row] = await database()
      .db.select()
      .from(datastores)
      .where(eq(datastores.id, datastoreId));
    expect(row?.appId).toBe(app.id);
  });

  test('refuses a Datastore already attached to another App', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const mine = await anApp();
    const theirs = await anApp();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;
    await attachDatastore(
      { datastoreId, appId: theirs.id },
      contextWith(backend),
    );

    const result = await attachDatastore(
      { datastoreId, appId: mine.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toContain(
      'detach it first',
    );
  });

  test('refuses a second store of the same engine — both would claim one variable', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    for (const name of ['orders', 'ledger']) {
      await createDatastore(
        { name, engine: 'postgres', targetId: target.id, storageGiB: 10 },
        contextWith(backend),
      );
    }
    const rows = await database().db.select().from(datastores);
    await attachDatastore(
      { datastoreId: rows[0]!.id, appId: app.id },
      contextWith(backend),
    );

    const result = await attachDatastore(
      { datastoreId: rows[1]!.id, appId: app.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toContain(
      'already has a postgres Datastore attached',
    );
  });

  test('a valkey store attaches beside a postgres one', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    const sql = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const cache = await createDatastore(
      {
        name: 'sessions',
        engine: 'valkey',
        targetId: target.id,
        storageGiB: 1,
      },
      contextWith(backend),
    );

    await attachDatastore(
      {
        datastoreId: (sql as { value: { id: string } }).value.id,
        appId: app.id,
      },
      contextWith(backend),
    );
    const result = await attachDatastore(
      {
        datastoreId: (cache as { value: { id: string } }).value.id,
        appId: app.id,
      },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
  });

  test('refuses a cluster-local store under an App placed elsewhere', async () => {
    const here = await aTarget();
    const elsewhere = await aTarget({ rank: 1 });
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    await database().db.insert(components).values({
      appId: app.id,
      name: 'web',
      kind: 'service',
      placedTargetId: elsewhere.id,
    });
    const created = await createDatastore(
      { name: 'orders', engine: 'postgres', targetId: here.id, storageGiB: 10 },
      contextWith(backend),
    );

    const result = await attachDatastore(
      {
        datastoreId: (created as { value: { id: string } }).value.id,
        appId: app.id,
      },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    // Placement's own words, so a developer meets one system rather than two.
    expect(result.ok === false && result.failure.message).toContain(
      'an attached datastore is cluster-local and lives elsewhere',
    );
  });
});

describe('detachDatastore', () => {
  test('clears the App and destroys nothing', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;
    await attachDatastore({ datastoreId, appId: app.id }, contextWith(backend));

    const result = await detachDatastore({ datastoreId }, contextWith(backend));

    expect(result.ok).toBe(true);
    const [row] = await database()
      .db.select()
      .from(datastores)
      .where(eq(datastores.id, datastoreId));
    expect(row?.appId).toBeNull();
    expect(row?.ref).toBe('postgres/fixture/orders');
    expect(backend.destroyed).toEqual([]);
  });
});

describe('destroyDatastore', () => {
  test('tears the object down and removes the row', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;

    const result = await destroyDatastore(
      { datastoreId },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    expect(backend.destroyed).toEqual(['postgres/fixture/orders']);
    expect(await database().db.select().from(datastores)).toEqual([]);
  });

  test('refuses while attached', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;
    await attachDatastore({ datastoreId, appId: app.id }, contextWith(backend));

    const result = await destroyDatastore(
      { datastoreId },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOT_REMOVABLE');
    expect(backend.destroyed).toEqual([]);
  });

  test('an external Datastore is forgotten, never destroyed', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const [row] = await database()
      .db.insert(datastores)
      .values({
        name: 'shared-analytics',
        engine: 'postgres',
        provenance: 'external',
        targetId: target.id,
        connectionRef: 'secret://elsewhere/analytics',
      })
      .returning();

    const result = await destroyDatastore(
      { datastoreId: row!.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.destroyed).toBe(false);
    // Somebody else authored that URL; the record goes, their database stays.
    expect(backend.destroyed).toEqual([]);
    expect(await database().db.select().from(datastores)).toEqual([]);
  });

  test('a refused teardown leaves the row exactly as it was', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter({
      destroyThrows: 'the finalizer will not release',
    });
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextWith(new FakeDatastoreAdapter()),
    );
    const datastoreId = (created as { value: { id: string } }).value.id;

    const result = await destroyDatastore(
      { datastoreId },
      contextWith(backend),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.message).toBe(
      'the finalizer will not release',
    );
    expect(await database().db.select().from(datastores)).toHaveLength(1);
  });
});

describe('listDatastores', () => {
  test('lists every Datastore, newest first, with the App and Target joined', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const app = await anApp();
    const first = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        targetId: target.id,
        storageGiB: 10,
      },
      contextAt(backend, '2024-06-01T00:00:00.000Z'),
    );
    const firstId = (first as { value: { id: string } }).value.id;
    await attachDatastore(
      { datastoreId: firstId, appId: app.id },
      contextAt(backend, '2024-06-01T00:01:00.000Z'),
    );
    const second = await createDatastore(
      { name: 'cache', engine: 'valkey', targetId: target.id, storageGiB: 1 },
      contextAt(backend, '2024-06-01T00:05:00.000Z'),
    );
    const secondId = (second as { value: { id: string } }).value.id;

    const result = await listDatastores(
      {},
      contextAt(backend, '2024-06-01T00:10:00.000Z'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Newest first: 'cache' was created after 'orders'.
    expect(result.value.datastores.map((row) => row.id)).toEqual([
      secondId,
      firstId,
    ]);

    const targetWithVessel = await database().db.query.targets.findFirst({
      where: (rows, { eq: matches }) => matches(rows.id, target.id),
      with: { vessel: true },
    });

    const attached = result.value.datastores.find((row) => row.id === firstId);
    expect(attached?.attachedTo).toBe(app.name);
    expect(attached?.appId).toBe(app.id);
    expect(attached?.targetId).toBe(target.id);
    expect(attached?.target).toBe(targetRowLabel(targetWithVessel!));
    expect(attached?.phase).toBe('PENDING');
    expect(attached?.provisioned).toBe(true);
    expect(attached?.when).toBe('10m ago');

    const unattached = result.value.datastores.find(
      (row) => row.id === secondId,
    );
    expect(unattached?.attachedTo).toBeNull();
    expect(unattached?.appId).toBeNull();
  });

  test('never returns connection_ref, even for an external Datastore', async () => {
    const target = await aTarget();
    await database().db.insert(datastores).values({
      name: 'shared-analytics',
      engine: 'postgres',
      provenance: 'external',
      targetId: target.id,
      connectionRef: 'secret://elsewhere/analytics',
    });

    const result = await listDatastores(
      {},
      contextWith(new FakeDatastoreAdapter()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.datastores.find(
      (one) => one.name === 'shared-analytics',
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('connectionRef');
    // Belt and braces: the credential-adjacent value itself must not appear
    // anywhere in the payload, not just under its own field name.
    expect(JSON.stringify(row)).not.toContain('secret://elsewhere/analytics');
  });

  /*
    The ledger's Create picker. Every case here is a Target `createDatastore`
    would refuse, offered or not offered accordingly — the picker and the
    command have to agree, because a Target on the list whose only answer is a
    refusal is the bug this list exists to avoid.
  */
  test('offers only the engines the Target serves', async () => {
    const both = await aTarget();
    const cacheOnly = await aTarget({
      discovery: { ...CAPABLE_DISCOVERY, postgres: false },
    });

    const result = await listDatastores(
      {},
      contextWith(new FakeDatastoreAdapter()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const offered = new Map(
      result.value.targets.map((row) => [row.targetId, row.engines]),
    );
    expect(offered.get(both.id)).toEqual(['postgres', 'valkey']);
    expect(offered.get(cacheOnly.id)).toEqual(['valkey']);
  });

  test('offers no Target serving neither engine', async () => {
    const bare = await aTarget({
      discovery: { ...CAPABLE_DISCOVERY, postgres: false, valkey: false },
    });

    const result = await listDatastores(
      {},
      contextWith(new FakeDatastoreAdapter()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.targets.some((row) => row.targetId === bare.id),
    ).toBeFalse();
  });

  test('offers nothing when this installation ships no datastore adapter', async () => {
    await aTarget();

    const result = await listDatastores({}, contextWith(null));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets).toEqual([]);
  });

  test('offers no unconnected Target', async () => {
    const unconnected = await aTarget({ connection: null });

    const result = await listDatastores(
      {},
      contextWith(new FakeDatastoreAdapter()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.targets.some((row) => row.targetId === unconnected.id),
    ).toBeFalse();
  });
});
