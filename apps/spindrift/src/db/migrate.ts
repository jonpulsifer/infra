/** Applies the committed migrations in `db/migrations/` to a database. */
import { join } from 'node:path';
import type { SQL } from 'bun';
import { migrate as runMigrations } from 'drizzle-orm/bun-sql/migrator';
import { createClient, createDb } from './client.ts';

const MIGRATIONS_FOLDER = join(import.meta.dir, 'migrations');

export type MigrationOptions = {
  migrationsFolder?: string;
};

/** Apply every committed migration to `client`'s database, in order. */
export async function applyMigrations(
  client: SQL,
  options: MigrationOptions = {},
): Promise<void> {
  await runMigrations(createDb(client), {
    migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
  });
}

if (import.meta.main) {
  const client = createClient();
  try {
    await applyMigrations(client);
  } finally {
    await client.close();
  }
}
