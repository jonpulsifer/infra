/**
 * The database connection (§12 State: "One Postgres, Spindrift's own
 * cluster of the in-cluster operator's kind").
 *
 * Reached over Bun's native SQL client, wrapped by Drizzle's `bun-sql`
 * driver — there is no `pg` or `postgres.js` dependency here on purpose
 * (the driver decision this task follows, not one it makes).
 *
 * There is no default connection string. A missing `DATABASE_URL` is a boot
 * failure, never a fallback to a guessed host — the same discipline
 * `src/config/manifest.ts` applies to the installation manifest.
 */
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import * as schema from './schema.ts';

type Env = Record<string, string | undefined>;

/** Raised when `DATABASE_URL` is absent or blank. */
export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

/** Read and validate the connection string. Never guesses at a default. */
export function databaseUrl(env: Env = Bun.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new DatabaseConfigError(
      'DATABASE_URL is not set: Spindrift has no database to connect to',
    );
  }
  return url;
}

/**
 * A native Bun SQL client against `DATABASE_URL`. Callers that need a
 * second, independent connection (a locking read held open while another
 * transaction is attempted, for instance) construct their own with `new
 * SQL(...)` rather than sharing this one's pool.
 */
export function createClient(env: Env = Bun.env): SQL {
  return new SQL(databaseUrl(env));
}

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/** Wrap a client — or a fresh one built from `DATABASE_URL` — in Drizzle. */
export function createDb(client: SQL = createClient()): Database {
  return drizzle({ client, schema });
}
