import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendList,
  BACKGROUND_CONTEXT,
  insertEntry,
  list,
  type Storage,
  setValue,
  value,
  type Write,
} from '@earendil-works/pi-agent-core';
import { SQL } from 'bun';
import { CommitOutcomeUnknownError } from '../src/index.ts';
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

describe('frame commits', () => {
  const frames = list<unknown>('pi.pending.assistant_frame', 'op:response');

  test('skip the WAL flush only when they hold nothing but frames', async () => {
    const storage = await proxiedStorage('frames');
    const asynchronous = () =>
      proxy.sent.filter((message) => message.includes('synchronous_commit'))
        .length;

    await storage.commit([appendList(frames, { delta: 'a' })], ctx);
    const afterFrames = asynchronous();
    expect(afterFrames).toBeGreaterThan(0);

    await storage.commit(
      [
        appendList(frames, { delta: 'b' }),
        setValue(value<string>('test.value', 'k'), 'v'),
      ],
      ctx,
    );
    await storage.commit([note('root')], ctx);
    expect(asynchronous()).toBe(afterFrames);

    expect(
      (await storage.readList(frames, undefined, ctx)).map(
        (element) => element.value,
      ),
    ).toEqual([{ delta: 'a' }, { delta: 'b' }]);
  });
});
