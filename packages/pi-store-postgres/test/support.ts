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

/** A migrated database of its own for one test file, dropped after it. */
export function withDatabase(): () => TestDatabase {
  const name = `pi_store_test_${crypto.randomUUID().replaceAll('-', '')}`;
  let admin: SQL | undefined;
  let current: TestDatabase | undefined;

  beforeAll(async () => {
    const server = serverUrl();
    admin = new SQL(server, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(server);
    url.pathname = `/${name}`;
    const sql = new SQL(url.toString(), { max: 4 });
    await migrate(sql);
    current = { url: url.toString(), sql };
  });

  afterAll(async () => {
    await current?.sql.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.close();
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
