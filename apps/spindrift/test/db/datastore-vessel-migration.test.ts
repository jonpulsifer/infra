/**
 * The datastore vessel-anchor migration against seeded pre-migration rows.
 *
 * The per-test harness can never exercise this: it applies every committed
 * migration onto an empty schema, so the backfill `UPDATE … SET vessel_id`
 * matches zero rows every time and a silent no-op reads as green. These tests
 * use `migrate.test.ts`'s pattern instead — a real throwaway database, the
 * journal sliced to stop just short of the vessel-anchor migration, rows
 * seeded under the old shape, and only then the pending migration applied.
 *
 * Two claims, one per test: a live installation's rows survive with their
 * `ref`, `connection_ref` and `phase` byte-identical (nothing re-provisions);
 * and the one state the new `(vessel_id, name)` key forbids — two Datastores
 * of one name on two surfaces of one vessel — fails the migration loudly and
 * atomically rather than silently dropping a row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { databaseUrl } from '../../src/db/client.ts';
import { applyMigrations } from '../../src/db/migrate.ts';

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations');
const VESSEL_ANCHOR = '0039_datastore_vessel_anchor';
const opened: { admin: SQL; client: SQL; database: string }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.client.close({ timeout: 0 });
    await item.admin.unsafe(`DROP DATABASE "${item.database}" WITH (FORCE)`);
    await item.admin.close({ timeout: 0 });
  }
}, 15_000);

async function cleanDatabase() {
  const database = `spindrift_datastore_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(databaseUrl());
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl());
  url.pathname = `/${database}`;
  const client = new SQL(url.toString());
  opened.push({ admin, client, database });
  return client;
}

/** A database migrated to the entry just before the vessel-anchor migration. */
async function databaseBeforeVesselAnchor() {
  const client = await cleanDatabase();
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string; when: number; breakpoints: boolean }[];
    [key: string]: unknown;
  };
  const at = journal.entries.findIndex((entry) => entry.tag === VESSEL_ANCHOR);
  expect(at).toBeGreaterThan(0);
  const previousEntries = journal.entries.slice(0, at);
  const folder = await mkdtemp(join(tmpdir(), 'spindrift-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: previousEntries }),
    );
    for (const entry of previousEntries) {
      await copyFile(
        join(MIGRATIONS, `${entry.tag}.sql`),
        join(folder, `${entry.tag}.sql`),
      );
    }
    await applyMigrations(client, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return client;
}

async function insertVessel(client: SQL, name: string, kind: string) {
  const [row] = await client<{ id: string }[]>`
    INSERT INTO vessels (name, kind) VALUES (${name}, ${kind}) RETURNING id`;
  return row!.id;
}

async function insertTarget(client: SQL, vesselId: string, adapter: string) {
  const [row] = await client<{ id: string }[]>`
    INSERT INTO targets (adapter, vessel_id, rank, health)
    VALUES (${adapter}::target_adapter, ${vesselId}, 0, 'healthy')
    RETURNING id`;
  return row!.id;
}

async function insertDatastore(
  client: SQL,
  targetId: string,
  name: string,
  ref: string,
  connectionRef: string,
) {
  const [row] = await client<{ id: string }[]>`
    INSERT INTO datastores (name, engine, provenance, target_id, ref, connection_ref, phase)
    VALUES (${name}, 'postgres', 'managed', ${targetId}, ${ref}, ${connectionRef}, 'LIVE')
    RETURNING id`;
  return row!.id;
}

async function columnExists(client: SQL, column: string) {
  const rows = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_name = 'datastores' AND column_name = ${column}`;
  return (rows[0]?.count ?? 0) > 0;
}

describe('the datastore vessel-anchor migration', () => {
  test('backfills each row to its Target’s vessel and re-provisions nothing', async () => {
    const client = await databaseBeforeVesselAnchor();
    // Two Datastores of one name on two *different* vessels — the case the
    // new key still allows, so both must come through.
    const hereVessel = await insertVessel(client, 'folly', 'cluster');
    const thereVessel = await insertVessel(client, 'offsite', 'cluster');
    const here = await insertTarget(client, hereVessel, 'kubernetes');
    const there = await insertTarget(client, thereVessel, 'kubernetes');
    const hereId = await insertDatastore(
      client,
      here,
      'orders',
      'postgres/fixture/orders',
      'secret://spindrift-apps/orders-app',
    );
    const thereId = await insertDatastore(
      client,
      there,
      'orders',
      'postgres/elsewhere/orders',
      'secret://spindrift-apps/orders-app-b',
    );

    await applyMigrations(client);

    // The identity moved and everything the reconcile loop reads survived
    // byte-identical: `ref` already encodes what observe and destroy address,
    // so an intact row is a row nothing re-provisions.
    const rows = await client<
      {
        id: string;
        vessel_id: string;
        ref: string;
        connection_ref: string;
        phase: string;
      }[]
    >`SELECT id, vessel_id, ref, connection_ref, phase FROM datastores ORDER BY ref`;
    expect(rows).toEqual([
      {
        id: thereId,
        vessel_id: thereVessel,
        ref: 'postgres/elsewhere/orders',
        connection_ref: 'secret://spindrift-apps/orders-app-b',
        phase: 'LIVE',
      },
      {
        id: hereId,
        vessel_id: hereVessel,
        ref: 'postgres/fixture/orders',
        connection_ref: 'secret://spindrift-apps/orders-app',
        phase: 'LIVE',
      },
    ]);
    expect(await columnExists(client, 'target_id')).toBe(false);
    const constraints = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.table_constraints
      WHERE table_name = 'datastores'
        AND constraint_name = 'datastores_vessel_name_unique'`;
    expect(constraints[0]?.count).toBe(1);
  });

  test('two same-named Datastores on two surfaces of one vessel fail it loudly and atomically', async () => {
    const client = await databaseBeforeVesselAnchor();
    // The state the new key exists to forbid: one boundary, two surfaces, one
    // name — two rows for one database on the far side.
    const vessel = await insertVessel(client, 'shared-project', 'gcp-project');
    const cloudrun = await insertTarget(client, vessel, 'cloudrun');
    const statics = await insertTarget(client, vessel, 'static');
    await insertDatastore(
      client,
      cloudrun,
      'orders',
      'postgres/shared/orders',
      'secret://shared/orders-a',
    );
    await insertDatastore(
      client,
      statics,
      'orders',
      'postgres/shared/orders-b',
      'secret://shared/orders-b',
    );

    await expect(applyMigrations(client)).rejects.toThrow(/vessel, name/);

    // Atomic: the failed migration rolled its DDL back whole, so the
    // pre-migration shape — and both rows — are exactly as seeded.
    expect(await columnExists(client, 'target_id')).toBe(true);
    expect(await columnExists(client, 'vessel_id')).toBe(false);
    const rows = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM datastores`;
    expect(rows[0]?.count).toBe(2);
  });
});
