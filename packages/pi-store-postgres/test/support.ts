import { afterAll, beforeAll } from 'bun:test';
import {
  BACKGROUND_CONTEXT,
  type Storage,
} from '@earendil-works/pi-agent-core';
import { SQL } from 'bun';
import { migrate, openSession, postgresStorage } from '../src/index.ts';

/**
 * The server the suite builds its database on. A run without one fails: a
 * skipped suite would pass CI while testing nothing.
 */
export function serverUrl(): string {
  const url =
    Bun.env.PI_STORE_TEST_DATABASE_URL?.trim() || Bun.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'pi-store tests need Postgres: set PI_STORE_TEST_DATABASE_URL (or DATABASE_URL) to a server URL; the suite creates and drops its own database there',
    );
  }
  return url;
}

export interface TestDatabase {
  readonly url: string;
  readonly sql: SQL;
}

export interface EmptyDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/** A new database on the test server, with no schema in it. */
export async function createDatabase(): Promise<EmptyDatabase> {
  const server = serverUrl();
  const name = `pi_store_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(server, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.close();
    throw error;
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    },
  };
}

/** A migrated database of its own for one test file, dropped after it. */
export function withDatabase(): () => TestDatabase {
  let empty: EmptyDatabase | undefined;
  let current: TestDatabase | undefined;

  beforeAll(async () => {
    empty = await createDatabase();
    current = { url: empty.url, sql: new SQL(empty.url, { max: 4 }) };
    await migrate(current.sql);
  });

  afterAll(async () => {
    await current?.sql.close();
    await empty?.drop();
  });

  return () => {
    if (current === undefined) {
      throw new Error('the test database is read outside a test');
    }
    return current;
  };
}

export function sessionId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

/** A session row and a bare Storage over it, as pi's conformance suite takes. */
export async function storageFor(sql: SQL, id: string): Promise<Storage> {
  const session = await openSession(sql, { id });
  await session.close(BACKGROUND_CONTEXT);
  return postgresStorage(sql, id);
}
