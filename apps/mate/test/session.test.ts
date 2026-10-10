import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '@discordjs/ws';
import { memorySessionStore, postgresSessionStore } from '../src/session.ts';
import { withDatabase } from './db.ts';
import { RecordingLog } from './support.ts';

const info: SessionInfo = {
  sessionId: 'abc',
  resumeURL: 'wss://resume.example',
  sequence: 7,
  shardId: 0,
  shardCount: 1,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the Postgres gateway session store', () => {
  const db = withDatabase();
  const open = (debounceMs = 20) =>
    postgresSessionStore(
      { sql: db().sql, up: () => true, ready: Promise.resolve() },
      new RecordingLog(),
      { debounceMs },
    );

  test('round-trips a session through a new store, as a replaced pod reads it', async () => {
    const first = open();
    expect(await first.retrieve(0)).toBeNull();
    await first.update(0, info);
    await sleep(150);
    expect(await open().retrieve(0)).toEqual(info);
  });

  test('keeps only the latest sequence of a burst', async () => {
    const store = open();
    for (const sequence of [1, 2, 3]) {
      await store.update(0, { ...info, sequence });
    }
    await sleep(150);
    expect((await open().retrieve(0))?.sequence).toBe(3);
  });

  test('flushes within the default debounce of one second', async () => {
    const store = open(1_000);
    await store.update(0, { ...info, sequence: 11 });
    await sleep(1_300);
    expect((await open().retrieve(0))?.sequence).toBe(11);
  });

  test('deletes the row on update(null)', async () => {
    const store = open();
    await store.update(0, info);
    await sleep(100);
    await store.update(0, null);
    expect(await open().retrieve(0)).toBeNull();
  });

  test('freezes at the sequence seal saw: a later dispatch or wipe moves nothing, and flush writes it', async () => {
    const store = open(5_000);
    await store.update(0, { ...info, sequence: 21 });
    store.seal();
    await store.update(0, { ...info, sequence: 22 });
    await store.update(0, null);
    await store.flush();
    expect((await open().retrieve(0))?.sequence).toBe(21);
  });
});

describe('a gateway session store with the database down', () => {
  test('retrieve is null and nothing throws', async () => {
    const log = new RecordingLog();
    const store = postgresSessionStore(
      { sql: null, up: () => false, ready: new Promise(() => {}) },
      log,
      { readyWaitMs: 10 },
    );
    expect(await store.retrieve(0)).toBeNull();
    await store.update(0, info);
    await store.update(0, null);
    store.seal();
    await store.flush();
  });

  test('a failing database is survived on every call', async () => {
    const sql = (() => Promise.reject(new Error('boom'))) as never;
    const store = postgresSessionStore(
      { sql, up: () => true, ready: Promise.resolve() },
      new RecordingLog(),
      { debounceMs: 5 },
    );
    expect(await store.retrieve(0)).toBeNull();
    await store.update(0, info);
    await sleep(50);
    await store.update(0, null);
    store.seal();
    await store.flush();
  });
});

describe('the memory gateway session store', () => {
  test('holds a session and ignores every update after seal', async () => {
    const store = memorySessionStore();
    await store.update(0, info);
    store.seal();
    await store.flush();
    await store.update(0, { ...info, sequence: info.sequence + 1 });
    await store.update(0, null);
    expect(await store.retrieve(0)).toEqual(info);
  });
});

describe('a gateway session store on the hot path', () => {
  test('reads Postgres once and serves later reads from memory', async () => {
    let reads = 0;
    const sql = (() => {
      reads += 1;
      return Promise.resolve([{ info }]);
    }) as never;
    const store = postgresSessionStore(
      { sql, up: () => true, ready: Promise.resolve() },
      new RecordingLog(),
      { debounceMs: 5_000 },
    );
    expect(await store.retrieve(0)).toEqual(info);
    await store.update(0, { ...info, sequence: 99 });
    expect((await store.retrieve(0))?.sequence).toBe(99);
    expect(reads).toBe(1);
  });

  test('never waits on the database after the first read', async () => {
    const store = postgresSessionStore(
      { sql: null, up: () => false, ready: new Promise(() => {}) },
      new RecordingLog(),
      { readyWaitMs: 10 },
    );
    expect(await store.retrieve(0)).toBeNull();
    const started = Date.now();
    await store.retrieve(0);
    expect(Date.now() - started).toBeLessThan(8);
  });
});
