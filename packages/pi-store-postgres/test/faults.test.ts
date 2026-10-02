import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Storage, StorageRejected } from '@earendil-works/pi-durable';
import { SQL } from 'bun';
import { CommitOutcomeUnknownError, openStorage } from '../src/index.ts';
import { isTransient, RETRY_WINDOW_MS } from '../src/retry.ts';
import { postgresStorage } from '../src/storage.ts';
import { BEGIN, COMMIT, FaultProxy } from './proxy.ts';
import {
  createRoot,
  ctx,
  entryIds,
  note,
  sessionId,
  withDatabase,
} from './support.ts';

const database = withDatabase();

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

/** A session over the proxied pool, its root conversation and entry 2 stored. */
async function proxiedStorage(label: string): Promise<{
  id: string;
  storage: Storage;
}> {
  const id = sessionId(label);
  const storage = await openStorage(proxied, id);
  await storage.commit([createRoot, note(2)], ctx);
  return { id, storage };
}

const failure = (promise: Promise<unknown>) =>
  promise.catch((reason: unknown) => reason);

describe('a commit whose connection fails', () => {
  test('is retried when the server never saw its writes', async () => {
    const { storage } = await proxiedStorage('before-writes');
    const cut = proxy.arm({ match: 'INSERT INTO pi_entries', when: 'before' });

    const seq = await storage.commit([note(3)], ctx);
    await cut;

    expect<number>(seq).toBe(2);
    expect(await entryIds(storage)).toEqual([2, 3]);
    expect<number>(await storage.commit([note(4)], ctx)).toBe(3);
  });

  test('is retried when COMMIT never reached the server', async () => {
    const { storage } = await proxiedStorage('before-commit');
    const cut = proxy.arm({ match: COMMIT, when: 'before' });

    const seq = await storage.commit([note(3)], ctx);
    await cut;

    expect<number>(seq).toBe(2);
    expect(await entryIds(storage)).toEqual([2, 3]);
  });

  test('is not retried when COMMIT ran and only the reply was lost', async () => {
    const { storage } = await proxiedStorage('after-commit');
    const cut = proxy.arm({ match: COMMIT, when: 'after' });

    const failed = storage.commit([note(3)], ctx);
    await cut;

    const error = await failure(failed);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error).not.toBeInstanceOf(StorageRejected);
    expect((error as CommitOutcomeUnknownError).firstSeq).toBe(2);
    expect(await entryIds(storage)).toEqual([2, 3]);
  });

  test('is not applied twice when a retry fails before it reads next_seq', async () => {
    const { id, storage } = await proxiedStorage('twice');
    const cuts = proxy
      .arm({ match: COMMIT, when: 'after' })
      .then(() => proxy.arm({ match: 'FOR UPDATE', when: 'before' }));

    const failed = storage.commit([note(3)], ctx);
    await cuts;

    expect(await failure(failed)).toBeInstanceOf(CommitOutcomeUnknownError);
    const reopened = await openStorage(database().sql, id);
    expect(await entryIds(reopened)).toEqual([2, 3]);
    expect<number>(await reopened.commit([note(4)], ctx)).toBe(3);
  });

  test('leaves the outcome unknown when the retries run out after COMMIT was sent', async () => {
    const { id, storage } = await proxiedStorage('sent-then-down');
    const down = proxy
      .arm({ match: COMMIT, when: 'after' })
      .then(() => proxy.stop());

    const failed = storage.commit([note(3)], ctx);
    await down;

    const error = await failure(failed);
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(error).toMatchObject({ firstSeq: 2, foundSeq: undefined });
    expect(isTransient((error as Error).cause)).toBe(true);
    expect(await entryIds(await openStorage(database().sql, id))).toEqual([
      2, 3,
    ]);
  });

  test('is rejected with the connection error when the retries run out before COMMIT was sent', async () => {
    const { id, storage } = await proxiedStorage('unsent-then-down');
    const down = proxy
      .arm({ match: 'INSERT INTO pi_entries', when: 'before' })
      .then(() => proxy.stop());

    const failed = storage.commit([note(3)], ctx);
    await down;

    const error = await failure(failed);
    expect(error).toBeInstanceOf(StorageRejected);
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(isTransient((error as Error).cause)).toBe(true);
    expect(await entryIds(await openStorage(database().sql, id))).toEqual([2]);
  });

  test('is rejected with the connection error when a retry proved COMMIT never ran', async () => {
    const { id, storage } = await proxiedStorage('disproved-then-down');
    const down = proxy
      .arm({ match: COMMIT, when: 'before' })
      .then(() =>
        proxy.arm({ match: 'INSERT INTO pi_entries', when: 'before' }),
      )
      .then(() => proxy.stop());

    const failed = storage.commit([note(3)], ctx);
    await down;

    const error = await failure(failed);
    expect(error).toBeInstanceOf(StorageRejected);
    expect(isTransient((error as Error).cause)).toBe(true);
    expect(await entryIds(await openStorage(database().sql, id))).toEqual([2]);
  });

  test('throws a plain error, not retried, when it breaks the contract', async () => {
    const { storage } = await proxiedStorage('invalid');
    const before = proxy.sent.length;

    const error = await failure(storage.commit([note(2)], ctx));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StorageRejected);
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect((error as Error).message).toContain('ID 2 already belongs to entry');
    const attempts = proxy.sent
      .slice(before)
      .filter((message) => message.includes(BEGIN));
    expect(attempts).toHaveLength(1);
  });
});

test('a read is retried when its connection drops', async () => {
  const { storage } = await proxiedStorage('read');
  const cut = proxy.arm({ match: 'FROM pi_entries', when: 'before' });

  const found = await storage.entry(2 as never, ctx);
  await cut;

  expect<number | undefined>(found?.entry.id).toBe(2);
});

test('a commit refuses a session another writer moved', async () => {
  const id = sessionId('overtaken');
  const first = await openStorage(database().sql, id);
  await first.commit([createRoot, note(2)], ctx);
  await (await openStorage(database().sql, id)).commit([note(3)], ctx);

  const error = await failure(first.commit([note(4)], ctx));

  expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
  expect(error).not.toBeInstanceOf(StorageRejected);
  expect(error).toMatchObject({ firstSeq: 2, foundSeq: 3 });
  expect(await entryIds(first)).toEqual([2, 3]);
});

test('a first commit refuses a session another writer moved after it opened', async () => {
  const id = sessionId('overtaken-first');
  const first = await openStorage(database().sql, id);
  const other = await openStorage(database().sql, id);
  await other.commit([createRoot, note(2)], ctx);

  const error = await failure(first.commit([createRoot], ctx));

  expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
  expect(error).toMatchObject({ firstSeq: 1, foundSeq: 2 });
  expect(await entryIds(first)).toEqual([2]);
});

test('a commit refuses a session whose seq went backwards', async () => {
  const { sql } = database();
  const id = sessionId('lost-commit');
  const storage = await openStorage(sql, id);
  await storage.commit([createRoot, note(2)], ctx);
  await storage.commit([note(3)], ctx);
  await sql`UPDATE pi_sessions SET next_seq = 2 WHERE id = ${id}`;

  const error = await failure(storage.commit([note(4)], ctx));

  expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
  expect(error).toMatchObject({ firstSeq: 3, foundSeq: 2 });
});

describe('a server that is down', () => {
  test('is tried again after it refuses a connection', async () => {
    const id = sessionId('refused');
    await openStorage(database().sql, id);
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
      const minted = failure(postgresStorage(sql, id).mintId());
      await Bun.sleep(250);
      back = new FaultProxy(database().url, port);

      expect<unknown>(await minted).toBe(2);
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
      const failed = await failure(
        postgresStorage(sql, sessionId('silent')).commit([createRoot], ctx),
      );

      expect(failed).toBeInstanceOf(StorageRejected);
      expect((failed as Error).cause).toMatchObject({
        code: 'ERR_POSTGRES_CONNECTION_TIMEOUT',
      });
      expect(connections).toBe(1);
    } finally {
      await sql.close();
      silent.stop(true);
    }
  }, 10_000);
});
