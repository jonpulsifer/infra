/**
 * Applies the committed migrations in `db/migrations/` to a database.
 *
 * Production never calls this at runtime: this repo is GitOps-first, and a
 * running process mutating its own schema on boot is the same shape of
 * mistake as a process mutating live infrastructure. Migrations are applied
 * as an out-of-band operator act. This runner exists so
 * `test/db/schema.test.ts` can stand up a clean, migrated schema before
 * asserting against it.
 */
import { join } from 'node:path';
import type { SQL } from 'bun';
import { migrate as runMigrations } from 'drizzle-orm/bun-sql/migrator';
import { createDb } from './client.ts';

const MIGRATIONS_FOLDER = join(import.meta.dir, 'migrations');

/** Apply every committed migration to `client`'s database, in order. */
export async function applyMigrations(client: SQL): Promise<void> {
  await runMigrations(createDb(client), {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}
