import { describe, expect, test } from 'bun:test';
import {
  ROOT_CONVERSATION_ID,
  StorageRejected,
} from '@earendil-works/pi-durable';
import { SQL } from 'bun';
import {
  deleteStorage,
  migrate,
  openStorage,
  storageExists,
} from '../src/index.ts';
import {
  createDatabase,
  createRoot,
  ctx,
  entryIds,
  note,
  sessionId,
  withDatabase,
} from './support.ts';

const database = withDatabase();

const DATA_TABLES = [
  'pi_record_ids',
  'pi_conversations',
  'pi_entries',
  'pi_tasks',
  'pi_submissions',
  'pi_documents',
  'pi_document_revisions',
];

async function rowsOf(sql: SQL, id: string): Promise<number> {
  let total = 0;
  for (const table of [...DATA_TABLES, 'pi_sessions']) {
    const column = table === 'pi_sessions' ? 'id' : 'session_id';
    const [row] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
      [id],
    );
    total += row.n;
  }
  return total;
}

describe('openStorage', () => {
  test('creates a session once, then reopens what it holds', async () => {
    const { sql } = database();
    const id = sessionId('thread');
    expect(await storageExists(sql, id)).toBe(false);

    const created = await openStorage(sql, id);
    await created.commit([createRoot, note(2), note(3)], ctx);
    await created.close(ctx);
    expect(await storageExists(sql, id)).toBe(true);

    const reopened = await openStorage(sql, id);
    expect(await entryIds(reopened)).toEqual([2, 3]);
    expect<number>(await reopened.mintId()).toBe(4);
    await reopened.close(ctx);
  });

  test('starts over after deleteStorage, which tolerates a missing session', async () => {
    const { sql } = database();
    const id = sessionId('deleted');
    const session = await openStorage(sql, id);
    await session.commit([createRoot], ctx);
    await session.close(ctx);

    await deleteStorage(sql, id);
    await deleteStorage(sql, id);

    expect(await storageExists(sql, id)).toBe(false);
    const fresh = await openStorage(sql, id);
    expect(await fresh.conversation(ROOT_CONVERSATION_ID, ctx)).toBeUndefined();
    expect<number>(await fresh.mintId()).toBe(2);
    await fresh.close(ctx);
  });
});

describe('two sessions in one database', () => {
  test('share nothing, and deleting one leaves the other whole', async () => {
    const { sql } = database();
    const [a, b] = [sessionId('iso-a'), sessionId('iso-b')];
    const first = await openStorage(sql, a);
    const second = await openStorage(sql, b);
    const task = {
      id: 3,
      conversationId: ROOT_CONVERSATION_ID,
      kind: 'test.task',
      version: 1,
      input: null,
      background: false,
      abortRequested: false,
      state: { status: 'pending', checkpoint: { phase: 'ready' } },
    };
    const writes = (extra: number) =>
      [
        createRoot,
        note(2, { extra }),
        { type: 'task', value: task },
        {
          type: 'document.create',
          record: { id: 4, kind: 'doc', scope: { kind: 'session' } },
          content: { kind: 'base', version: 1, value: { extra } },
        },
      ] as never;
    await first.commit(writes(1), ctx);
    await second.commit(writes(2), ctx);

    expect<number>(await first.mintId()).toBe(5);
    expect(await entryIds(first)).toEqual([2]);
    const [entryA] = (
      await first.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        10,
        undefined,
        ctx,
      )
    ).items;
    const [entryB] = (
      await second.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        10,
        undefined,
        ctx,
      )
    ).items;
    expect(entryA?.data).toEqual({ extra: 1 });
    expect(entryB?.data).toEqual({ extra: 2 });
    expect((await first.document(4 as never, 'current', ctx))?.value).toEqual({
      extra: 1,
    });

    const before = await rowsOf(sql, b);
    expect(before).toBeGreaterThan(5);
    await first.close(ctx);
    await deleteStorage(sql, a);

    expect(await rowsOf(sql, a)).toBe(0);
    expect(await rowsOf(sql, b)).toBe(before);
    expect((await second.document(4 as never, 'current', ctx))?.value).toEqual({
      extra: 2,
    });
    expect(await entryIds(second)).toEqual([2]);
    await second.close(ctx);
  });
});

describe('the store', () => {
  test('keeps JSON as given, NUL, lone surrogates and key order included', async () => {
    const { sql } = database();
    const storage = await openStorage(sql, sessionId('json'));
    const data = {
      zeta: 'a\u0000b',
      alpha: { y: 1, x: [2, '\u{10000}', '\ud800'] },
    };
    await storage.commit([createRoot, note(2, data)], ctx);

    const found = await storage.entry(2 as never, ctx);

    expect(JSON.stringify(found?.entry.data)).toBe(JSON.stringify(data));
    await storage.close(ctx);
  });

  test('mints unique ids across Storage instances and seqs one commit at a time', async () => {
    const { sql } = database();
    const id = sessionId('writers');
    await (await openStorage(sql, id)).commit([createRoot], ctx);
    const writers = await Promise.all(
      Array.from({ length: 20 }, () => openStorage(sql, id)),
    );

    const ids = await Promise.all(writers.map((writer) => writer.mintId()));
    const seqs: number[] = [];
    for (const [index] of writers.entries()) {
      const fresh = await openStorage(sql, id);
      seqs.push(Number(await fresh.commit([note(ids[index]!)], ctx)));
      await fresh.close(ctx);
    }

    expect(new Set(ids).size).toBe(20);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
    await Promise.all(writers.map((writer) => writer.close(ctx)));
  });

  test('refuses a seq a JS number cannot hold', async () => {
    const { sql } = database();
    const id = sessionId('bigint');
    const storage = await openStorage(sql, id);
    await sql`UPDATE pi_sessions SET next_seq = ${'9007199254740993'}::bigint WHERE id = ${id}`;

    await expect(storage.commit([createRoot], ctx)).rejects.toThrow(
      'next_seq is not a safe integer',
    );
    await storage.close(ctx);
  });

  test('close waits for admitted commits, refuses later work, and leaves the pool open', async () => {
    const { sql } = database();
    const id = sessionId('close');
    const storage = await openStorage(sql, id);
    const admitted = storage.commit([createRoot, note(2)], ctx);

    const closed = storage.close(ctx);
    await expect(storage.commit([note(3)], ctx)).rejects.toThrow('closed');
    await expect(
      storage.conversation(ROOT_CONVERSATION_ID, ctx),
    ).rejects.toThrow('closed');
    await closed;

    await admitted;
    expect(await storageExists(sql, id)).toBe(true);
    expect(await entryIds(await openStorage(sql, id))).toEqual([2]);
  });

  test('throws a plain error for a commit that breaks the contract', async () => {
    const { sql } = database();
    const storage = await openStorage(sql, sessionId('rejected'));
    await storage.commit([createRoot, note(2)], ctx);

    const error = await storage
      .commit([note(3), note(2)], ctx)
      .catch((reason: unknown) => reason);

    expect(error).not.toBeInstanceOf(StorageRejected);
    expect((error as Error).message).toContain('ID 2 already belongs to entry');
    expect(await storage.commit([note(3)], ctx)).toBeGreaterThan(1);
    expect(await entryIds(storage)).toEqual([2, 3]);
    await storage.close(ctx);
  });
});

describe('migrate', () => {
  test('runs each migration once, even when callers race on a new database', async () => {
    const fresh = await createDatabase();
    const sql = new SQL(fresh.url, { max: 1 });
    const clients = [
      sql,
      ...Array.from({ length: 3 }, () => new SQL(fresh.url, { max: 1 })),
    ];
    try {
      await Promise.all(clients.map((client) => migrate(client)));

      const rows =
        await sql`SELECT version FROM pi_store_migrations ORDER BY version`;
      expect(rows.map((row: { version: number }) => row.version)).toEqual([
        1, 2,
      ]);
      const [tables] =
        await sql`SELECT to_regclass('pi_documents') AS documents`;
      expect(tables.documents).toBe('pi_documents');
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await fresh.drop();
    }
  });

  test('replaces the first schema without converting its rows', async () => {
    const fresh = await createDatabase();
    const sql = new SQL(fresh.url, { max: 1 });
    try {
      await sql.unsafe(`
        CREATE TABLE pi_store_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO pi_store_migrations (version, name) VALUES (1, 'initial');
        CREATE TABLE pi_sessions (id text PRIMARY KEY, next_seq bigint);
        CREATE TABLE pi_entries (session_id text, id text);
        INSERT INTO pi_sessions VALUES ('old', 7);
      `);

      await migrate(sql);

      expect(await storageExists(sql, 'old')).toBe(false);
      const [gone] = await sql`SELECT to_regclass('pi_entries') AS entries`;
      expect(gone.entries).toBe('pi_entries');
      const columns = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pi_entries' AND column_name = 'conversation_id'
      `;
      expect(columns).toHaveLength(1);
    } finally {
      await sql.close();
      await fresh.drop();
    }
  });

  test('refuses a schema newer than the code', async () => {
    const { sql } = database();
    await sql`INSERT INTO pi_store_migrations (version, name) VALUES (99, 'future')`;
    try {
      await expect(migrate(sql)).rejects.toThrow('schema version 99 is newer');
    } finally {
      await sql`DELETE FROM pi_store_migrations WHERE version = 99`;
    }
  });
});
