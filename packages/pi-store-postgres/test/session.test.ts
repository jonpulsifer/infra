import { describe, expect, test } from 'bun:test';
import {
  BACKGROUND_CONTEXT,
  insertEntry,
  setValue,
  value,
  type Write,
} from '@earendil-works/pi-agent-core';
import {
  deleteSession,
  migrate,
  openSession,
  POSTGRES_STORAGE_VERSION,
  sessionExists,
} from '../src/index.ts';
import { sessionId, storageFor, withDatabase } from './support.ts';

const database = withDatabase();
const ctx = BACKGROUND_CONTEXT;

describe('openSession', () => {
  test('creates a session once, then reopens what it holds', async () => {
    const { sql } = database();
    const id = sessionId('thread');
    expect(await sessionExists(sql, id)).toBe(false);

    const created = await openSession(sql, {
      id,
      metadata: { surface: 'discord' },
    });
    const main = await created.createBranch('main', null, ctx);
    await main.appendMessage(
      { role: 'user', content: 'hello', timestamp: 1 },
      ctx,
    );
    await main.appendCustomEntry('note', { seen: true }, ctx);
    await created.setName('first thread', ctx);
    await created.close(ctx);
    expect(await sessionExists(sql, id)).toBe(true);

    const reopened = await openSession(sql, {
      id,
      metadata: { surface: 'slack' },
    });
    expect(reopened.metadata).toEqual({
      id,
      createdAt: created.metadata.createdAt,
      storageVersion: POSTGRES_STORAGE_VERSION,
      metadata: { surface: 'discord' },
    });
    const branch = await reopened.branch('main', ctx);
    const entries = await branch!.findEntries({ order: 'oldestFirst' }, ctx);
    expect(entries.map((entry) => entry.type)).toEqual(['message', 'custom']);
    expect(await reopened.getName(ctx)).toBe('first thread');
    expect((await reopened.getStats(ctx)).messageCount).toBe(1);
    await reopened.close(ctx);
  });

  test('starts over after deleteSession, which tolerates a missing session', async () => {
    const { sql } = database();
    const id = sessionId('deleted');
    const session = await openSession(sql, { id });
    await session.createBranch('main', null, ctx);
    await session.close(ctx);

    await deleteSession(sql, id);
    await deleteSession(sql, id);

    expect(await sessionExists(sql, id)).toBe(false);
    const fresh = await openSession(sql, { id });
    expect(await fresh.branch('main', ctx)).toBeUndefined();
    expect((await fresh.getStats(ctx)).messageCount).toBe(0);
    await fresh.close(ctx);
  });
});

describe('the store', () => {
  test('keeps JSON as given, NUL characters and key order included', async () => {
    const { sql } = database();
    const storage = await storageFor(sql, sessionId('json'));
    const data = { zeta: 'a\u0000b', alpha: { y: 1, x: [2, '\u{10000}'] } };

    await storage.commit(
      [
        insertEntry({
          id: 'custom',
          parentId: null,
          type: 'custom',
          customType: 'note',
          data,
        }),
        setValue(value('test.value', 'nul'), data),
      ],
      ctx,
    );

    const entry = (await storage.getEntries(['custom'], ctx)).get('custom');
    const stored = await storage.getValue(value('test.value', 'nul'), ctx);
    expect(JSON.stringify(entry?.type === 'custom' && entry.data)).toBe(
      JSON.stringify(data),
    );
    expect(JSON.stringify(stored?.value)).toBe(JSON.stringify(data));
    await storage.close(ctx);
  });

  test('lets one writer at a time assign seqs across Storage instances', async () => {
    const { sql } = database();
    const id = sessionId('writers');
    const first = await storageFor(sql, id);
    const second = await storageFor(sql, id);
    const writes = (label: string, index: number): Write[] => [
      setValue(value('test.value', `${label}-${index}`), index),
    ];

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit(
          writes(index % 2 === 0 ? 'first' : 'second', index),
          ctx,
        ),
      ),
    );

    const seqs = results.flatMap((result) => result.seqs).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    await first.close(ctx);
    await second.close(ctx);
  });

  test('refuses a seq a JS number cannot hold', async () => {
    const { sql } = database();
    const id = sessionId('bigint');
    const storage = await storageFor(sql, id);
    await sql`UPDATE pi_sessions SET next_seq = ${'9007199254740993'}::bigint WHERE id = ${id}`;

    await expect(
      storage.commit([setValue(value('test.value', 'k'), 1)], ctx),
    ).rejects.toThrow('next_seq is not a safe integer');
    await storage.close(ctx);
  });
});

describe('migrate', () => {
  test('runs each migration once, even when callers race', async () => {
    const { sql } = database();
    await Promise.all([migrate(sql), migrate(sql), migrate(sql)]);

    const rows = await sql`SELECT version FROM pi_store_migrations`;
    expect(rows.map((row: { version: number }) => row.version)).toEqual([1]);
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
