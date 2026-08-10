/**
 * The datastore reconcile loop (§11).
 *
 * One claim, and every test here is a way of falsifying it: **the loop writes
 * `connection_ref` when the far side has one, and at no other moment.**
 *
 * That is not fussiness. `DatastoreState.connection` is `null` for the whole
 * of a healthy provision — the contract says a caller treating it as failure
 * "would fail every healthy provision" — so a pass that copied it
 * unconditionally would write null over a reference the deploy path has
 * already pinned into a release, and the App would come up with no
 * `DATABASE_URL` and a green rollout. The failure is silent in exactly the way
 * §10 spends a whole section preventing for config, so it is asserted here
 * three ways: WAITING must not write, LIVE must write, and a Target that will
 * not answer must leave the row alone.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AdapterRegistry, Clock } from '../../src/commands/types.ts';
import { datastores, type NewTarget, targets } from '../../src/db/schema.ts';
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

/** A managed row mid-provision: a handle, no phase yet, no connection. */
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
      targetId: target.id,
      ref: 'postgres/fixture/orders',
      phase: 'PENDING',
      ...overrides,
    })
    .returning();
  return row!;
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

    // Mid-provision: the operator has not generated the credential, and the
    // row must not claim it has.
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

    // The selection is the whole cost control: LIVE *and* connected has
    // nothing left for a poll to learn.
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
    // CloudNativePG writes `<cluster>-app` during bootstrap and reports Ready
    // afterwards, so the credential genuinely exists while the phase is still
    // WAITING — which is what keeps this row in the loop's selection for a
    // second pass to be able to damage it.
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

    // An uplink blip is not a verdict. FAILED here would blame the database
    // for the network between this process and it.
    expect(reports).toEqual([]);
    const after = await reread(row.id);
    expect(after.phase).toBe('WAITING');
    expect(after.detail).toBe('still coming up');
    expect(after.updatedAt).toEqual(row.updatedAt);
  });

  test('an object that is gone is FAILED, naming the Target', async () => {
    const row = await aProvisionedRow();
    // Nothing scripted for this ref: the fake answers `null`, which is the far
    // side saying the object is not there.
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

    // Nothing was provisioned for it, so there is nothing to poll — and a
    // human authored its URL, which this loop has no business overwriting.
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
