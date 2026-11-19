/**
 * The migration that moves the pinned zone from the App onto each of its
 * Components, and the vanity label onto its one network-serving Component,
 * against rows seeded before it.
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
import { heldNames } from '../../src/domain/naming.ts';

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations');
const COMPONENT_NAMES = '0061_component_names';
const opened: { admin: SQL; client: SQL; database: string }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.client.close({ timeout: 0 });
    await item.admin.unsafe(`DROP DATABASE "${item.database}" WITH (FORCE)`);
    await item.admin.close({ timeout: 0 });
  }
}, 15_000);

async function databaseBeforeComponentNames(): Promise<SQL> {
  const database = `kthx_engine_names_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(databaseUrl());
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl());
  url.pathname = `/${database}`;
  const client = new SQL(url.toString());
  opened.push({ admin, client, database });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[]; [key: string]: unknown };
  const at = journal.entries.findIndex(
    (entry) => entry.tag === COMPONENT_NAMES,
  );
  expect(at).toBeGreaterThan(0);
  const previousEntries = journal.entries.slice(0, at);
  const folder = await mkdtemp(join(tmpdir(), 'kthx-engine-migrations-'));
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

async function insertApp(
  client: SQL,
  name: string,
  vanity: string | null,
  zone: string | null,
): Promise<string> {
  const [row] = await client<{ id: string }[]>`
    INSERT INTO apps (name, source_kind, vanity_domain, zone)
    VALUES (${name}, 'archive', ${vanity}, ${zone})
    RETURNING id`;
  return row!.id;
}

async function insertComponent(
  client: SQL,
  appId: string,
  name: string,
  kind: 'service' | 'website' | 'job',
  expose: boolean | null,
): Promise<void> {
  await client`
    INSERT INTO components (app_id, name, kind, expose)
    VALUES (${appId}, ${name}, ${kind}::component_kind, ${expose})`;
}

async function namesOf(client: SQL, app: string) {
  return client<
    { name: string; vanity_label: string | null; zone: string | null }[]
  >`
    SELECT component.name, component.vanity_label, component.zone
    FROM components AS component
    JOIN apps AS app ON app.id = component.app_id
    WHERE app.name = ${app}
    ORDER BY component.name`;
}

describe('the component names migration', () => {
  test('copies the label onto the one serving Component, and the zone onto every Component', async () => {
    const client = await databaseBeforeComponentNames();
    const shop = await insertApp(client, 'shop', 'shop', 'apps.example.test');
    await insertComponent(client, shop, 'web', 'website', true);
    await insertComponent(client, shop, 'worker', 'service', false);
    await insertComponent(client, shop, 'nightly', 'job', null);
    const api = await insertApp(client, 'api', '@', null);
    await insertComponent(client, api, 'server', 'service', true);

    await applyMigrations(client);

    expect(await namesOf(client, 'shop')).toEqual([
      { name: 'nightly', vanity_label: null, zone: 'apps.example.test' },
      { name: 'web', vanity_label: 'shop', zone: 'apps.example.test' },
      { name: 'worker', vanity_label: null, zone: 'apps.example.test' },
    ]);
    expect(await namesOf(client, 'api')).toEqual([
      { name: 'server', vanity_label: '@', zone: null },
    ]);
  });

  test('copies no label onto an App with several serving Components, or none', async () => {
    const client = await databaseBeforeComponentNames();
    const wishlist = await insertApp(client, 'wishlist', 'wish', null);
    await insertComponent(client, wishlist, 'next', 'website', true);
    await insertComponent(client, wishlist, 'offsite', 'service', true);
    const batch = await insertApp(client, 'batch', 'batch', null);
    await insertComponent(client, batch, 'worker', 'service', false);

    await applyMigrations(client);

    expect(await namesOf(client, 'wishlist')).toEqual([
      { name: 'next', vanity_label: null, zone: null },
      { name: 'offsite', vanity_label: null, zone: null },
    ]);
    expect(await namesOf(client, 'batch')).toEqual([
      { name: 'worker', vanity_label: null, zone: null },
    ]);
  });

  test("keeps every Component's canonical name in the App's pinned zone", async () => {
    // The pinned zone is not the default, so a Component that lost the pin
    // would mint its canonical name in `default.example.test` instead.
    const zones = [
      { name: 'default.example.test', reaches: ['private', 'public'] },
      { name: 'pinned.example.test', reaches: ['private', 'public'] },
    ] as const;
    const client = await databaseBeforeComponentNames();
    const shop = await insertApp(client, 'shop', 'shop', 'pinned.example.test');
    await insertComponent(client, shop, 'web', 'website', true);
    await insertComponent(client, shop, 'admin', 'service', true);
    await insertComponent(client, shop, 'worker', 'service', false);

    await applyMigrations(client);

    const canonical = (await namesOf(client, 'shop')).map(
      (row) =>
        heldNames({
          app: 'shop',
          component: row.name,
          reach: 'private',
          zones,
          zone: row.zone,
          vanityLabel: null,
        })[0],
    );
    expect(canonical).toEqual([
      'shop-admin.pinned.example.test',
      'shop-web.pinned.example.test',
      'shop-worker.pinned.example.test',
    ]);
  });

  test('drops the App columns', async () => {
    const client = await databaseBeforeComponentNames();

    await applyMigrations(client);

    const columns = await client<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'apps' AND column_name IN ('vanity_domain', 'zone')`;
    expect(columns).toEqual([]);
  });
});
