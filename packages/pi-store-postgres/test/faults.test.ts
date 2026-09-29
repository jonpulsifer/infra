import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendList,
  BACKGROUND_CONTEXT,
  deleteList,
  insertEntry,
  list,
  pendingAssistantFrames,
  type Storage,
  setValue,
  value,
  type Write,
} from '@earendil-works/pi-agent-core';
import { SQL } from 'bun';
import { CommitOutcomeUnknownError, postgresStorage } from '../src/index.ts';
import { isFrameOnly } from '../src/plan.ts';
import { isTransient, RETRY_WINDOW_MS } from '../src/retry.ts';
import { BEGIN, COMMIT, FaultProxy } from './proxy.ts';
import { sessionId, storageFor, withDatabase } from './support.ts';

const database = withDatabase();
const ctx = BACKGROUND_CONTEXT;

let proxy: FaultProxy;
let proxied: SQL;

beforeEach(() => {
  proxy = new FaultProxy(database().url);
  proxied = new SQL(proxy.url, { max: 1 });
});

afterEach(async () => {
  await proxied.close();
  proxy.stop();
});

function note(id: string, parentId: string | null = null): Write {
  return insertEntry({
    id,
    parentId,
    type: 'custom',
    customType: 'note',
    data: { id },
  });
}

async function proxiedStorage(label: string): Promise<Storage> {
  const id = sessionId(label);
  await storageFor(database().sql, id);
  return storageFor(proxied, id);
}

async function entryIds(storage: Storage): Promise<string[]> {
  const entries = await storage.scanEntries({ order: 'asc' }, ctx);
  return entries.map((entry) => entry.id);
}

describe('a commit whose connection fails', () => {
  test('is retried when the server never saw its writes', async () => {
    const storage = await proxiedStorage('before-writes');
    const cut = proxy.arm({ match: 'INSERT INTO pi_entries', when: 'before' });

    const result = await storage.commit([note('root')], ctx);
    await cut;

    expect(result.seqs).toEqual([1]);
    expect(await entryIds(storage)).toEqual(['root']);
    expect((await storage.commit([note('child', 'root')], ctx)).seqs).toEqual([
      2,
    ]);
  });

  test('is retried when COMMIT never reached the server', async () => {
    const storage = await proxiedStorage('before-commit');
    await storage.commit([note('root')], ctx);
    const cut = proxy.arm({ match: COMMIT, when: 'before' });

    const result = await storage.commit([note('child', 'root')], ctx);
    await cut;

    expect(result.seqs).toEqual([2]);
    expect(await entryIds(storage)).toEqual(['root', 'child']);
  });

  test('is not retried when COMMIT ran and only the reply was lost', async () => {
    const storage = await proxiedStorage('after-commit');
    await storage.commit([note('root')], ctx);
    const cut = proxy.arm({ match: COMMIT, when: 'after' });

    const failed = storage.commit([note('child', 'root')], ctx);
    await cut;

    const error = await failed.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect((error as CommitOutcomeUnknownError).firstSeq).toBe(2);
    expect(await entryIds(storage)).toEqual(['root', 'child']);
    expect((await storage.commit([note('next', 'child')], ctx)).seqs).toEqual([
      3,
    ]);
  });

  test('is not applied twice when a retry fails before it reads next_seq', async () => {
    const storage = await proxiedStorage('twice');
    const events = list<number>('test.list', 'events');
    await storage.commit([appendList(events, 0)], ctx);
    const cuts = proxy
      .arm({ match: COMMIT, when: 'after' })
      .then(() => proxy.arm({ match: 'FOR UPDATE', when: 'before' }));

    const failed = storage.commit([appendList(events, 1)], ctx);
    await cuts;

    expect(await failed.catch((reason: unknown) => reason)).toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
    const stored = await storage.readList(events, undefined, ctx);
    expect(stored.map((element) => element.value)).toEqual([0, 1]);
  });

  test('leaves the outcome unknown when the retries run out after COMMIT was sent', async () => {
    const id = sessionId('sent-then-down');
    await storageFor(database().sql, id);
    const storage = await storageFor(proxied, id);
    await storage.commit([note('root')], ctx);
    const down = proxy
      .arm({ match: COMMIT, when: 'after' })
      .then(() => proxy.stop());

    const failed = storage.commit([note('child', 'root')], ctx);
    await down;

    const error = await failed.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error).toMatchObject({ firstSeq: 2, foundSeq: undefined });
    expect(isTransient((error as Error).cause)).toBe(true);
    expect(await entryIds(postgresStorage(database().sql, id))).toEqual([
      'root',
      'child',
    ]);
  });

  test('keeps the connection error when the retries run out before COMMIT was sent', async () => {
    const id = sessionId('unsent-then-down');
    await storageFor(database().sql, id);
    const storage = await storageFor(proxied, id);
    const down = proxy
      .arm({ match: 'INSERT INTO pi_entries', when: 'before' })
      .then(() => proxy.stop());

    const failed = storage.commit([note('root')], ctx);
    await down;

    const error = await failed.catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(isTransient(error)).toBe(true);
    expect(await entryIds(postgresStorage(database().sql, id))).toEqual([]);
  });

  test('keeps the connection error when a retry proved COMMIT never ran', async () => {
    const id = sessionId('disproved-then-down');
    await storageFor(database().sql, id);
    const storage = await storageFor(proxied, id);
    const down = proxy
      .arm({ match: COMMIT, when: 'before' })
      .then(() =>
        proxy.arm({ match: 'INSERT INTO pi_entries', when: 'before' }),
      )
      .then(() => proxy.stop());

    const failed = storage.commit([note('root')], ctx);
    await down;

    const error = await failed.catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(isTransient(error)).toBe(true);
    expect(await entryIds(postgresStorage(database().sql, id))).toEqual([]);
  });

  test('is not retried when it breaks pi’s rules', async () => {
    const storage = await proxiedStorage('invalid');
    await storage.commit([note('root')], ctx);
    const before = proxy.sent.length;

    await expect(storage.commit([note('root')], ctx)).rejects.toThrow(
      'Duplicate entry or usage id: root',
    );

    const attempts = proxy.sent
      .slice(before)
      .filter((message) => message.includes(BEGIN));
    expect(attempts).toHaveLength(1);
  });
});

test('a read is retried when its connection drops', async () => {
  const storage = await proxiedStorage('read');
  const events = list<string>('test.list', 'events');
  await storage.commit([appendList(events, 'a'), appendList(events, 'b')], ctx);
  const cut = proxy.arm({ match: 'FROM pi_list_values', when: 'before' });

  const read = await storage.readList(events, { order: 'desc' }, ctx);
  await cut;

  expect(read.map((element) => element.value)).toEqual(['b', 'a']);
});

test('a commit refuses a session another writer moved', async () => {
  const id = sessionId('overtaken');
  const first = await storageFor(database().sql, id);
  await first.commit([note('root')], ctx);
  await postgresStorage(database().sql, id).commit(
    [note('other', 'root')],
    ctx,
  );

  const error = await first
    .commit([note('child', 'root')], ctx)
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
  expect(error).toMatchObject({ firstSeq: 2, foundSeq: 3 });
  expect(await entryIds(first)).toEqual(['root', 'other']);
});

describe('a server that is down', () => {
  test('is tried again after it refuses a connection', async () => {
    const id = sessionId('refused');
    await storageFor(database().sql, id);
    const idle = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    const { port } = idle;
    idle.stop(true);
    const url = new URL(database().url);
    url.hostname = '127.0.0.1';
    url.port = String(port);
    const sql = new SQL(url.toString(), { max: 1 });
    let back: FaultProxy | undefined;
    try {
      const stats = postgresStorage(sql, id)
        .getStats(ctx)
        .catch((reason: unknown) => reason);
      await Bun.sleep(250);
      back = new FaultProxy(database().url, port);

      expect(await stats).toMatchObject({ messageCount: 0 });
      expect(back.sent.length).toBeGreaterThan(0);
    } finally {
      await sql.close();
      back?.stop();
    }
  });

  test('is not tried again after a failure slower than the retry window', async () => {
    let connections = 0;
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {
          connections++;
        },
        data() {},
      },
    });
    const sql = new SQL(
      `postgres://postgres@127.0.0.1:${silent.port}/postgres`,
      { max: 1, connectionTimeout: RETRY_WINDOW_MS / 1000 },
    );
    try {
      const failed = await postgresStorage(sql, sessionId('silent'))
        .commit([note('root')], ctx)
        .catch((reason: unknown) => reason);

      expect(failed).toMatchObject({ code: 'ERR_POSTGRES_CONNECTION_TIMEOUT' });
      expect(connections).toBe(1);
    } finally {
      await sql.close();
      silent.stop(true);
    }
  }, 10_000);
});

describe('frame commits', () => {
  const frames = pendingAssistantFrames('operation', 'response');
  const delta = (text: string) => ({
    type: 'text_delta' as const,
    contentIndex: 0,
    delta: text,
  });
  const frame = (text: string) => appendList(frames, delta(text));

  test('are told apart from every other commit', () => {
    expect(isFrameOnly([frame('a'), frame('b')])).toBe(true);
    expect(isFrameOnly([])).toBe(false);
    expect(
      isFrameOnly([frame('a'), setValue(value('test.value', 'k'), 'v')]),
    ).toBe(false);
    expect(isFrameOnly([deleteList(frames)])).toBe(false);
    expect(isFrameOnly([appendList(list('test.list', 'k'), 1)])).toBe(false);
  });

  test('skip the WAL flush only when they hold nothing but frames', async () => {
    const id = sessionId('frames');
    await storageFor(database().sql, id);
    // Each commit gets a fresh connection: a reused one names a statement
    // it prepared before instead of sending its text again.
    const asynchronous = async (writes: Write[]): Promise<boolean> => {
      const sql = new SQL(proxy.url, { max: 1 });
      const before = proxy.sent.length;
      try {
        await postgresStorage(sql, id).commit(writes, ctx);
      } finally {
        await sql.close();
      }
      return proxy.sent
        .slice(before)
        .some((message) => message.includes('synchronous_commit'));
    };

    expect(await asynchronous([frame('a')])).toBe(true);
    expect(
      await asynchronous([
        frame('b'),
        setValue(value<string>('test.value', 'k'), 'v'),
      ]),
    ).toBe(false);
    expect(await asynchronous([note('root')])).toBe(false);
    expect(await asynchronous([frame('c')])).toBe(true);

    const stored = await postgresStorage(database().sql, id).readList(
      frames,
      undefined,
      ctx,
    );
    expect(stored.map((element) => element.value)).toEqual([
      delta('a'),
      delta('b'),
      delta('c'),
    ]);
  });

  test('make the next commit throw when a crash lost one that returned', async () => {
    const { sql } = database();
    const id = sessionId('lost-frame');
    const storage = await storageFor(sql, id);
    await storage.commit([frame('a')], ctx);
    await storage.commit([frame('b')], ctx);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM pi_list_values WHERE session_id = ${id} AND seq = 2`;
      await tx`UPDATE pi_sessions SET next_seq = 2 WHERE id = ${id}`;
    });

    const error = await storage
      .commit([frame('c')], ctx)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error).toMatchObject({ firstSeq: 3, foundSeq: 2 });
    const reopened = postgresStorage(sql, id);
    expect((await reopened.commit([frame('c')], ctx)).seqs).toEqual([2]);
    const stored = await reopened.readList(frames, undefined, ctx);
    expect(stored.map((element) => element.value)).toEqual([
      delta('a'),
      delta('c'),
    ]);
  });
});
