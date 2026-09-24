/**
 * The datastore reconcile loop. It writes `connection_ref` only when the far
 * side reports one: a null written over a pinned reference would drop the
 * App's `DATABASE_URL` behind a green rollout.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AdapterRegistry, Clock } from '../../src/commands/types.ts';
import {
  apps,
  datastores,
  type NewTarget,
  targets,
} from '../../src/db/schema.ts';
import { runDatastorePass } from '../../src/reconciler/datastore-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDatastoreAdapter } from '../harness/fakes/datastore-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { insertVessel, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const clock: Clock = { now: () => new Date('2024-06-01T00:00:00.000Z') };

function adaptersFor(datastore: FakeDatastoreAdapter | null): AdapterRegistry {
  const deploy = new FakeDeployAdapter();
  return {
    deploy: () => deploy,
    build: () => null,
    store: () => null,
    repository: () => null,
    supplyChain: () => {
      throw new Error('the datastore loop reached the supply chain');
    },
    ...(datastore === null ? {} : { datastore: () => datastore }),
  };
}

async function aTarget(overrides: Partial<NewTarget> = {}) {
  const vessel = await insertVessel(database().db, 'kubernetes');
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues({ vesselId: vessel.id, ...overrides }))
    .returning();
  return target!;
}

/** A managed PENDING row with a handle and no connection. */
async function aProvisionedRow(
  overrides: Partial<typeof datastores.$inferInsert> = {},
) {
  const target = await aTarget();
  const [row] = await database()
    .db.insert(datastores)
    .values({
      name: 'orders',
      engine: 'postgres',
      provenance: 'managed',
      vesselId: target.vesselId,
      ref: 'postgres/fixture/orders',
      phase: 'PENDING',
      ...overrides,
    })
    .returning();
  return row!;
}

async function anApp(name: string) {
  const [app] = await database()
    .db.insert(apps)
    .values({ name, sourceKind: 'archive' })
    .returning();
  return app!;
}

async function reread(id: string) {
  const [row] = await database()
    .db.select()
    .from(datastores)
    .where(eq(datastores.id, id));
  return row!;
}

describe('the connection reference', () => {
  test('a WAITING pass writes the phase and no connection; the LIVE pass writes it once', async () => {
    const row = await aProvisionedRow();
    const backend = new FakeDatastoreAdapter();
    backend.script(
      row.ref!,
      {
        ref: row.ref!,
        phase: 'WAITING',
        detail: 'waiting for the PVC to bind',
        connection: null,
      },
      {
        ref: row.ref!,
        phase: 'LIVE',
        connection: 'secret://spindrift-apps/orders-app',
      },
    );
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    const first = await runDatastorePass(context);
    const waiting = await reread(row.id);
    const second = await runDatastorePass(context);
    const live = await reread(row.id);

    // Mid-provision there is no credential yet, so the row must not claim one.
    expect(waiting.phase).toBe('WAITING');
    expect(waiting.detail).toBe('waiting for the PVC to bind');
    expect(waiting.connectionRef).toBeNull();
    expect(first[0]?.connected).toBe(false);

    expect(live.phase).toBe('LIVE');
    expect(live.connectionRef).toBe('secret://spindrift-apps/orders-app');
    expect(second[0]?.connected).toBe(true);
  });

  test('a settled row is not polled again', async () => {
    const row = await aProvisionedRow({
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-apps/orders-app',
    });
    const backend = new FakeDatastoreAdapter();
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    const reports = await runDatastorePass(context);

    // A LIVE, connected row has nothing left for a poll to learn.
    expect(reports).toEqual([]);
    expect(backend.observed).toEqual([]);
    expect((await reread(row.id)).connectionRef).toBe(
      'secret://spindrift-apps/orders-app',
    );
  });

  test('a LIVE row that never reported a connection is still polled', async () => {
    const row = await aProvisionedRow({ phase: 'LIVE' });
    const backend = new FakeDatastoreAdapter();
    backend.script(row.ref!, {
      ref: row.ref!,
      phase: 'LIVE',
      connection: 'secret://spindrift-apps/orders-app',
    });
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    await runDatastorePass(context);

    expect((await reread(row.id)).connectionRef).toBe(
      'secret://spindrift-apps/orders-app',
    );
  });

  test('a later null answer never clears a reference already written', async () => {
    const row = await aProvisionedRow({ phase: 'WAITING' });
    const backend = new FakeDatastoreAdapter();
    // CloudNativePG writes `<cluster>-app` before it reports Ready, so a
    // WAITING row can hold a connection and stay selected for the next pass.
    backend.script(
      row.ref!,
      {
        ref: row.ref!,
        phase: 'WAITING',
        connection: 'secret://spindrift-apps/orders-app',
      },
      // A status the CR has not refilled yet, or the operator mid-rotation.
      { ref: row.ref!, phase: 'WAITING', connection: null },
    );
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    await runDatastorePass(context);
    await runDatastorePass(context);

    const after = await reread(row.id);
    expect(after.phase).toBe('WAITING');
    expect(after.connectionRef).toBe('secret://spindrift-apps/orders-app');
  });
});

describe('what the loop refuses to touch', () => {
  test('an adapter that throws leaves the row exactly as it was', async () => {
    const row = await aProvisionedRow({
      phase: 'WAITING',
      detail: 'still coming up',
    });
    const backend = new FakeDatastoreAdapter({
      observeThrows: 'dial tcp 10.0.0.1:6443: i/o timeout',
    });
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    const reports = await runDatastorePass(context);

    // A network error is no verdict on the database.
    expect(reports).toEqual([]);
    const after = await reread(row.id);
    expect(after.phase).toBe('WAITING');
    expect(after.detail).toBe('still coming up');
    expect(after.updatedAt).toEqual(row.updatedAt);
  });

  test('an object that is gone is FAILED, naming the Target', async () => {
    const row = await aProvisionedRow();
    // With nothing scripted the fake answers `null`: the object is gone.
    const backend = new FakeDatastoreAdapter();
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    await runDatastorePass(context);

    const after = await reread(row.id);
    expect(after.phase).toBe('FAILED');
    expect(after.detail).toContain('kubernetes');
  });

  test('an external Datastore is never observed', async () => {
    await aProvisionedRow({ provenance: 'external', ref: null });
    const backend = new FakeDatastoreAdapter();

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    });

    // A human authored its URL, and nothing was provisioned to poll.
    expect(reports).toEqual([]);
    expect(backend.observed).toEqual([]);
  });

  test('a managed row whose provision never returned a handle is skipped', async () => {
    await aProvisionedRow({ ref: null });
    const backend = new FakeDatastoreAdapter();

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    });

    expect(reports).toEqual([]);
    expect(backend.observed).toEqual([]);
  });

  test('an installation with no datastore adapter polls nothing and blames nobody', async () => {
    const row = await aProvisionedRow();

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(null),
      clock,
    });

    expect(reports).toEqual([]);
    expect((await reread(row.id)).phase).toBe('PENDING');
  });
});

/**
 * The loop admits the attached App's namespace from the row, because deleting
 * an App detaches its Datastore through `ON DELETE SET NULL` with no command.
 */
describe('the network exception', () => {
  test('an attached Datastore has its App namespace admitted, with no poll', async () => {
    const app = await anApp('storefront');
    const row = await aProvisionedRow({
      appId: app.id,
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-datastores/orders-app',
    });
    const backend = new FakeDatastoreAdapter();

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    });

    // `app-{app}` is `appNamespaceFor`'s default, where the release lands.
    expect(backend.permits).toEqual([
      { ref: row.ref!, namespaces: ['app-storefront'] },
    ]);
    // A settled row is still not polled; only the attachment changed.
    expect(backend.observed).toEqual([]);
    expect(reports[0]?.permitted).toBe(true);
    expect((await reread(row.id)).permittedNamespace).toBe('app-storefront');
  });

  test('a second pass with nothing changed says nothing', async () => {
    const app = await anApp('storefront');
    await aProvisionedRow({
      appId: app.id,
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-datastores/orders-app',
    });
    const backend = new FakeDatastoreAdapter();
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };

    await runDatastorePass(context);
    const second = await runDatastorePass(context);

    // `permittedNamespace` records what was written, so an unchanged pass
    // writes nothing.
    expect(backend.permits).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test('an App deleted out from under the row closes the path it opened', async () => {
    const app = await anApp('storefront');
    const row = await aProvisionedRow({
      appId: app.id,
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-datastores/orders-app',
    });
    const backend = new FakeDatastoreAdapter();
    const context = {
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    };
    await runDatastorePass(context);

    // Deleting the App detaches the row through `ON DELETE SET NULL`, with no
    // command in the path.
    await database().db.delete(apps).where(eq(apps.id, app.id));
    await runDatastorePass(context);

    expect(backend.permits).toEqual([
      { ref: row.ref!, namespaces: ['app-storefront'] },
      // The namespaces are the whole permitted set, so an empty one revokes.
      { ref: row.ref!, namespaces: [] },
    ]);
    expect((await reread(row.id)).permittedNamespace).toBeNull();
  });

  test('a Target that will not take the policy is retried, and still polled', async () => {
    const app = await anApp('storefront');
    const row = await aProvisionedRow({ appId: app.id });
    const backend = new FakeDatastoreAdapter({
      permitThrows: 'networkpolicies is forbidden: RBAC: no policy matched',
    });
    backend.script(row.ref!, {
      ref: row.ref!,
      phase: 'LIVE',
      connection: null,
    });

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    });

    // The column records what the cluster was last told, so a failed write
    // leaves it unset and the next pass tries again.
    expect((await reread(row.id)).permittedNamespace).toBeNull();
    // The poll still runs, or a Target refusing every policy write would hold
    // the Datastore in PENDING with no reason shown.
    expect(backend.observed).toEqual([row.ref!]);
    expect(reports[0]).toMatchObject({ phase: 'LIVE', permitted: false });
    expect((await reread(row.id)).phase).toBe('LIVE');
  });

  test('a written exception is said again once it is old enough', async () => {
    const app = await anApp('storefront');
    const row = await aProvisionedRow({
      appId: app.id,
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-datastores/orders-app',
    });
    const backend = new FakeDatastoreAdapter();
    const db = database().db;
    await runDatastorePass({ db, adapters: adaptersFor(backend), clock });

    // Past the one-hour reassert window with the row unchanged. A policy
    // deleted by hand leaves the row consistent, so only age re-sends it.
    const later: Clock = {
      now: () => new Date('2024-06-01T02:00:00.000Z'),
    };
    await runDatastorePass({
      db,
      adapters: adaptersFor(backend),
      clock: later,
    });

    expect(backend.permits).toEqual([
      { ref: row.ref!, namespaces: ['app-storefront'] },
      { ref: row.ref!, namespaces: ['app-storefront'] },
    ]);
    expect((await reread(row.id)).permittedAt).toEqual(later.now());
  });

  test('a backend with nothing to write records nothing', async () => {
    const app = await anApp('storefront');
    const row = await aProvisionedRow({
      appId: app.id,
      phase: 'LIVE',
      connectionRef: 'secret://spindrift-datastores/orders-app',
    });
    // `permit` answers `false` when it writes nothing, as for a ref outside
    // the datastore namespace.
    const backend = new FakeDatastoreAdapter({ permitNoops: true });

    const reports = await runDatastorePass({
      db: database().db,
      adapters: adaptersFor(backend),
      clock,
    });

    // Recording it would claim a cluster fact nobody established.
    expect((await reread(row.id)).permittedNamespace).toBeNull();
    expect((await reread(row.id)).permittedAt).toBeNull();
    expect(reports).toEqual([]);
  });
});
