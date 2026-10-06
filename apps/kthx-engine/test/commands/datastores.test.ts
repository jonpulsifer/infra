// The Datastore commands against a real Postgres: the unique key fires before
// the adapter, and `destroy` never reaches the adapter for an external row.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { attachDatastore } from '../../src/commands/datastores/attach.ts';
import { createDatastore } from '../../src/commands/datastores/create.ts';
import { destroyDatastore } from '../../src/commands/datastores/destroy.ts';
import { detachDatastore } from '../../src/commands/datastores/detach.ts';
import { getDatastore } from '../../src/commands/datastores/get.ts';
import { listDatastores } from '../../src/commands/datastores/list.ts';
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

/** `contextWith` at a given time. */
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

// A connected, capable cluster Target, on its own vessel since (vessel_id,
// adapter) is unique.
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
        vesselId: target.vesselId,
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
    // PENDING until the loop learns the object came up.
    expect(row?.phase).toBe('PENDING');
    expect(row?.connectionRef).toBeNull();
    expect(row?.appId).toBeNull();
  });

  test('a duplicate name in one Vessel is refused before the adapter is called', async () => {
    const target = await aTarget();
    const backend = new FakeDatastoreAdapter();
    const input = {
      name: 'orders',
      engine: 'postgres' as const,
      vesselId: target.vesselId,
      storageGiB: 10,
    };
    await createDatastore(input, contextWith(backend));

    const second = await createDatastore(input, contextWith(backend));

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.failure.code).toBe('NOT_DEPLOYABLE');
    // The row goes in first, so the second call created nothing on the far
    // side.
    expect(backend.provisioned).toHaveLength(1);
  });

  test('the same name in a second Vessel is two Datastores', async () => {
    const backend = new FakeDatastoreAdapter();
    const here = await aTarget();
    const there = await aTarget({ rank: 1 });

    const first = await createDatastore(
      {
        name: 'primary',
        engine: 'valkey',
        vesselId: here.vesselId,
        storageGiB: 1,
      },
      contextWith(backend),
    );
    const second = await createDatastore(
      {
        name: 'primary',
        engine: 'valkey',
        vesselId: there.vesselId,
        storageGiB: 1,
      },
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        { name, engine: 'postgres', vesselId: target.vesselId, storageGiB: 10 },
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
        vesselId: target.vesselId,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    const cache = await createDatastore(
      {
        name: 'sessions',
        engine: 'valkey',
        vesselId: target.vesselId,
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
      {
        name: 'orders',
        engine: 'postgres',
        vesselId: here.vesselId,
        storageGiB: 10,
      },
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
    // Placement's own words, so a developer meets one system.
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
        vesselId: target.vesselId,
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
      {
        name: 'cache',
        engine: 'valkey',
        vesselId: target.vesselId,
        storageGiB: 1,
      },
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
    expect(attached?.vesselId).toBe(target.vesselId);
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
      vesselId: target.vesselId,
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
    // The value must not appear anywhere in the payload.
    expect(JSON.stringify(row)).not.toContain('secret://elsewhere/analytics');
  });

  // The Create picker offers only what createDatastore would accept.
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
      result.value.vessels.map((row) => [row.vesselId, row.engines]),
    );
    expect(offered.get(both.vesselId)).toEqual(['postgres', 'valkey']);
    expect(offered.get(cacheOnly.vesselId)).toEqual(['valkey']);
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
      result.value.vessels.some((row) => row.vesselId === bare.vesselId),
    ).toBeFalse();
  });

  test('offers nothing when this installation ships no datastore adapter', async () => {
    await aTarget();

    const result = await listDatastores({}, contextWith(null));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vessels).toEqual([]);
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
      result.value.vessels.some((row) => row.vesselId === unconnected.vesselId),
    ).toBeFalse();
  });
});

// One Datastore, with the far side's object beside its stored facts. An
// unreachable Target still shows the facts.
describe('getDatastore', () => {
  async function aDatastore(backend: FakeDatastoreAdapter) {
    const target = await aTarget();
    const created = await createDatastore(
      {
        name: 'orders',
        engine: 'postgres',
        vesselId: target.vesselId,
        storageGiB: 10,
      },
      contextWith(backend),
    );
    if (!created.ok) throw new Error(created.failure.message);
    return created.value;
  }

  test('answers the backend’s object, verbatim', async () => {
    const object = {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      spec: { instances: 1, storage: { size: '10Gi' } },
      status: { readyInstances: 1 },
    };
    const backend = new FakeDatastoreAdapter({ describes: object });
    const created = await aDatastore(backend);

    const result = await getDatastore(
      { datastoreId: created.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Asked for by the handle `provision` returned, not by the name beside it.
    expect(backend.described).toEqual([created.ref]);
    expect(JSON.parse(result.value.datastore.object ?? 'null')).toEqual(object);
    expect(result.value.datastore.objectError).toBeUndefined();
    expect(result.value.datastore.name).toBe('orders');
    expect(result.value.datastore.provisioned).toBeTrue();
    // An external row's value is whatever a human pasted in, so it is never
    // shown.
    expect(result.value.datastore).not.toHaveProperty('connectionRef');
  });

  test('a Target that cannot be read keeps its facts and says why', async () => {
    const backend = new FakeDatastoreAdapter({
      describeThrows: 'connect ECONNREFUSED 10.0.0.1:6443',
    });
    const created = await aDatastore(backend);

    const result = await getDatastore(
      { datastoreId: created.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.datastore.object).toBeNull();
    expect(result.value.datastore.objectError).toBe(
      'connect ECONNREFUSED 10.0.0.1:6443',
    );
    expect(result.value.datastore.name).toBe('orders');
  });

  test('a row with no handle is never asked about', async () => {
    const backend = new FakeDatastoreAdapter();
    const target = await aTarget();
    const [row] = await database()
      .db.insert(datastores)
      .values({
        name: 'somebody-elses',
        engine: 'postgres',
        provenance: 'external',
        vesselId: target.vesselId,
        connectionRef: 'secret://apps/somebody-elses',
      })
      .returning();

    const result = await getDatastore(
      { datastoreId: row!.id },
      contextWith(backend),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.datastore.object).toBeNull();
    expect(result.value.datastore.objectError).toBeUndefined();
    expect(backend.described).toEqual([]);
  });

  test('an id that names nothing is NOT_FOUND', async () => {
    const result = await getDatastore(
      { datastoreId: crypto.randomUUID() },
      contextWith(new FakeDatastoreAdapter()),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOT_FOUND');
  });
});
