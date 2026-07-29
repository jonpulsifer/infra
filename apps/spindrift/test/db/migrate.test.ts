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
import {
  expectedMigrationAt,
  schemaReady,
} from '../../src/db/schema-readiness.ts';

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations');
const opened: { admin: SQL; client: SQL; database: string }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.client.close({ timeout: 0 });
    await item.admin.unsafe(`DROP DATABASE "${item.database}" WITH (FORCE)`);
    await item.admin.close({ timeout: 0 });
  }
}, 15_000);

async function cleanDatabase() {
  const database = `spindrift_migrate_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(databaseUrl());
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl());
  url.pathname = `/${database}`;
  const client = new SQL(url.toString());
  opened.push({ admin, client, database });
  return client;
}

describe('committed migrations', () => {
  test('install a clean database and are idempotent on reinstall', async () => {
    const client = await cleanDatabase();
    expect(await schemaReady(client)).toBe(false);

    await applyMigrations(client);
    expect(await schemaReady(client)).toBe(true);
    const before = await client<
      { count: number; latest: number }[]
    >`SELECT count(*)::int AS count, max(created_at)::bigint AS latest
      FROM drizzle.__drizzle_migrations`;

    await applyMigrations(client);
    const after = await client<
      { count: number; latest: number }[]
    >`SELECT count(*)::int AS count, max(created_at)::bigint AS latest
      FROM drizzle.__drizzle_migrations`;
    expect(after).toEqual(before);
    expect(Number(after[0]?.latest)).toBe(expectedMigrationAt());
  });

  test('an upgrade from the previous journal applies only the pending migration', async () => {
    const client = await cleanDatabase();
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: { tag: string; when: number; breakpoints: boolean }[];
      [key: string]: unknown;
    };
    const previousEntries = journal.entries.slice(0, -1);
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
      expect(await schemaReady(client)).toBe(false);
      const before = await client<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;

      await applyMigrations(client);
      expect(await schemaReady(client)).toBe(true);
      const after = await client<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(after[0]?.count).toBe((before[0]?.count ?? 0) + 1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
