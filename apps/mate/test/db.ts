/**
 * A Postgres database of its own for one test file, migrated like mate-db and
 * dropped after. Without a server the suite fails: skipped, it would pass CI
 * while testing nothing.
 */
import { afterAll, beforeAll } from 'bun:test';
import { migrate } from '@repo/pi-store-postgres';
import { SQL } from 'bun';
import { migrateThreads } from '../src/store.ts';

export function serverUrl(): string {
  const url =
    Bun.env.MATE_TEST_DATABASE_URL?.trim() || Bun.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'mate tests need Postgres: set MATE_TEST_DATABASE_URL (or DATABASE_URL) to a server URL; the suite creates and drops its own database there',
    );
  }
  return url;
}

export interface TestDatabase {
  readonly url: string;
  readonly sql: SQL;
}

export function withDatabase(): () => TestDatabase {
  const server = serverUrl();
  const name = `mate_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(server, { max: 1 });
  let current: TestDatabase | undefined;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(server);
    url.pathname = `/${name}`;
    current = { url: url.toString(), sql: new SQL(url.toString(), { max: 8 }) };
    await migrate(current.sql);
    await migrateThreads(current.sql);
  });

  afterAll(async () => {
    await current?.sql.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  });

  return () => {
    if (!current) throw new Error('the test database is read outside a test');
    return current;
  };
}
