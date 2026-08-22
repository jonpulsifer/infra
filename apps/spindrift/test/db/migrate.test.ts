import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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

/** The journal's entries, in the order the migrator would apply them. */
function journalEntries(): { tag: string }[] {
  return (
    JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] }
  ).entries;
}

/** Every `.sql` beside the journal, by the tag an entry would name it with. */
function committedMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.slice(0, -'.sql'.length))
    .sort();
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

  test('every committed migration is in the journal, and nothing else is', () => {
    // The migrator reads `meta/_journal.json` and never the directory, so a
    // `.sql` file committed without an entry is silently skipped — the migrate
    // Job completes, reports success, and the pods that follow it crash on a
    // column that was never added. Nothing failed when that happened, which is
    // what this test is.
    //
    // The reverse direction matters too: an entry naming a file that is not
    // there fails the migrator at run time, in the one place where the failure
    // costs a rollout rather than a test.
    const journalled = journalEntries().map((entry) => entry.tag);
    expect(journalled).toEqual(committedMigrations());
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
