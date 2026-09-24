/** A missing DATABASE_URL fails boot: there is no default host to guess. */
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import * as schema from './schema.ts';

type Env = Record<string, string | undefined>;

export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

export function databaseUrl(env: Env = Bun.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new DatabaseConfigError(
      'DATABASE_URL is not set: Spindrift has no database to connect to',
    );
  }
  return url;
}

export function createClient(env: Env = Bun.env): SQL {
  return new SQL(databaseUrl(env));
}

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(client: SQL = createClient()): Database {
  return drizzle({ client, schema });
}
