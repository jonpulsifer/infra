import { afterAll, beforeAll } from 'bun:test';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type ConversationId,
  type EntryId,
  ROOT_CONVERSATION_ID,
  type Storage,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import { SQL } from 'bun';
import { migrate } from '../src/index.ts';

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

export const ctx = BACKGROUND_CONTEXT;

/** A root conversation entry the tests append to. */
export function note(
  id: number,
  data: JsonValue = { id },
  conversationId: number = ROOT_CONVERSATION_ID,
): StorageWrite {
  return {
    type: 'entry',
    value: {
      id: id as EntryId,
      conversationId: conversationId as ConversationId,
      kind: 'test.note',
      data,
    },
  };
}

export const createRoot: StorageWrite = {
  type: 'conversation',
  value: { id: ROOT_CONVERSATION_ID },
};

export async function entryIds(storage: Storage): Promise<number[]> {
  const page = await storage.scanEntries(
    { conversationId: ROOT_CONVERSATION_ID },
    1000,
    undefined,
    ctx,
  );
  return page.items.map((entry) => entry.id).reverse();
}
