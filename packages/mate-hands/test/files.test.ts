/**
 * The file methods, each through a real daemon over pipes: round trips, the
 * error codes pi's `FileError` uses, and the read limit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileInfo, Hello, TextLine } from '../src/protocol.ts';
import { Hands, removeScratch, scratch } from './support.ts';

let hands: Hands;
let cwd: string;
let home: string;
let tmp: string;

beforeAll(() => {
  cwd = scratch('cwd');
  home = scratch('home');
  tmp = scratch('tmp');
  hands = new Hands({ cwd, env: { HOME: home, TMPDIR: tmp } });
});

afterAll(async () => {
  hands.end();
  await hands.exited;
  removeScratch();
});

describe('hello and ping', () => {
  test('hello names the workspace, home, epoch and limits', async () => {
    const hello = await hands.result<Hello>('hello');
    expect(hello).toMatchObject({
      protocol: 1,
      version: '0.1.0',
      epoch: 1,
      pid: hands.pid,
      cwd,
      home,
      tmp,
      watchdogMs: 60_000,
    });
    expect(hello.limits.maxReadBytes).toBe(8 * 1024 * 1024);
  });

  test('ping answers null', async () => {
    expect(await hands.result('ping')).toBeNull();
  });
});

describe('reads and writes', () => {
  test('writes create parents, relative to the workspace', async () => {
    await hands.result('writeFile', { path: 'a/b/c.txt', content: 'one\n' });
    await hands.result('appendFile', { path: 'a/b/c.txt', content: 'two' });
    expect(readFileSync(join(cwd, 'a/b/c.txt'), 'utf8')).toBe('one\ntwo');
    expect(await hands.result('readTextFile', { path: 'a/b/c.txt' })).toBe(
      'one\ntwo',
    );
  });

  test('a path under ~ is under home', async () => {
    await hands.result('writeFile', { path: '~/notes.md', content: 'hi' });
    expect(readFileSync(join(home, 'notes.md'), 'utf8')).toBe('hi');
    expect(
      await hands.result('readTextFile', { path: `file://${home}/notes.md` }),
    ).toBe('hi');
  });

  test('binary content crosses as base64', async () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    await hands.result('writeFile', {
      path: 'blob.bin',
      content: bytes.toString('base64'),
      encoding: 'base64',
    });
    const read = await hands.result<string>('readBinaryFile', {
      path: 'blob.bin',
    });
    expect([...Buffer.from(read, 'base64')]).toEqual([...bytes]);
  });

  test('readTextLines stops at maxLines', async () => {
    writeFileSync(join(cwd, 'lines.txt'), 'a\nb\nc\nd\n');
    expect(
      await hands.result('readTextLines', { path: 'lines.txt', maxLines: 2 }),
    ).toEqual(['a', 'b']);
    expect(await hands.result('readTextLines', { path: 'lines.txt' })).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(
      await hands.result('readTextLines', { path: 'lines.txt', maxLines: 0 }),
    ).toEqual([]);
  });

  test('a line reader marks a final line with no newline', async () => {
    writeFileSync(join(cwd, 'torn.jsonl'), '{"a":1}\n{"b":');
    const { reader } = await hands.result<{ reader: number }>('reader.open', {
      path: 'torn.jsonl',
    });
    const lines: (TextLine | null)[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(
        await hands.result<TextLine | null>('reader.readLine', { reader }),
      );
    }
    expect(lines).toEqual([
      { text: '{"a":1}', terminated: true },
      { text: '{"b":', terminated: false },
      null,
    ]);
    await hands.result('reader.close', { reader });
    expect(await hands.error('reader.readLine', { reader })).toMatchObject({
      kind: 'file',
      code: 'invalid',
    });
  });

  test('cleanup closes open readers', async () => {
    writeFileSync(join(cwd, 'open.txt'), 'x\n');
    const { reader } = await hands.result<{ reader: number }>('reader.open', {
      path: 'open.txt',
    });
    await hands.result('cleanup');
    expect((await hands.error('reader.readLine', { reader })).code).toBe(
      'invalid',
    );
  });
});

describe('the tree', () => {
  test('rename, info, listing and canonical paths', async () => {
    const dir = join(cwd, 'tree');
    mkdirSync(dir);
    writeFileSync(join(dir, 'old.txt'), '12345');
    await hands.result('renameFile', {
      from: 'tree/old.txt',
      to: 'tree/new.txt',
    });
    symlinkSync(join(dir, 'new.txt'), join(dir, 'link'));
    await hands.result('createDir', { path: 'tree/sub/deeper' });

    const info = await hands.result<FileInfo>('fileInfo', {
      path: 'tree/new.txt',
    });
    expect(info).toEqual({
      name: 'new.txt',
      path: join(dir, 'new.txt'),
      kind: 'file',
      size: 5,
      mtimeMs: statSync(join(dir, 'new.txt')).mtimeMs,
    });
    const listed = await hands.result<FileInfo[]>('listDir', { path: 'tree' });
    const byName = listed.sort((a, b) => a.name.localeCompare(b.name));
    expect(byName.map((f) => [f.name, f.kind])).toEqual([
      ['link', 'symlink'],
      ['new.txt', 'file'],
      ['sub', 'directory'],
    ]);
    expect(
      await hands.result('canonicalPath', { path: 'tree/sub/../link' }),
    ).toBe(join(dir, 'new.txt'));
  });

  test('exists, and remove with and without recursion', async () => {
    await hands.result('createDir', { path: 'gone/inner' });
    expect(await hands.result('exists', { path: 'gone/inner' })).toBe(true);
    await hands.result('remove', { path: 'gone', recursive: true });
    expect(await hands.result('exists', { path: 'gone' })).toBe(false);
    expect(
      await hands.result('remove', { path: 'gone', force: true }),
    ).toBeNull();
    expect((await hands.error('remove', { path: 'gone' })).code).toBe(
      'not_found',
    );
  });

  test('temp directories and files are under the temp root', async () => {
    const dir = await hands.result<string>('createTempDir', { prefix: 'x-' });
    expect(dir.startsWith(join(tmp, 'x-'))).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    const file = await hands.result<string>('createTempFile', {
      prefix: 'out-',
      suffix: '.log',
    });
    expect(file.startsWith(tmp)).toBe(true);
    expect(file.endsWith('.log')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});

describe('errors', () => {
  test('a missing file is not_found, with its absolute path', async () => {
    expect(await hands.error('readTextFile', { path: 'nope.txt' })).toEqual({
      kind: 'file',
      code: 'not_found',
      message: expect.stringContaining('nope.txt'),
      path: join(cwd, 'nope.txt'),
    });
  });

  test('reading a directory is is_directory', async () => {
    mkdirSync(join(cwd, 'adir'), { recursive: true });
    expect((await hands.error('readTextFile', { path: 'adir' })).code).toBe(
      'is_directory',
    );
  });

  test('a path through a file is not_directory', async () => {
    writeFileSync(join(cwd, 'plain'), '');
    expect((await hands.error('listDir', { path: 'plain' })).code).toBe(
      'not_directory',
    );
  });

  test.skipIf(process.getuid?.() === 0)(
    'an unreadable file is permission_denied',
    async () => {
      writeFileSync(join(cwd, 'secret'), 'x');
      chmodSync(join(cwd, 'secret'), 0);
      expect((await hands.error('readTextFile', { path: 'secret' })).code).toBe(
        'permission_denied',
      );
    },
  );

  test('an unknown method and a bad parameter are protocol errors', async () => {
    expect(await hands.error('format')).toMatchObject({
      kind: 'protocol',
      code: 'unknown_method',
    });
    expect(await hands.error('readTextFile', { path: 7 })).toMatchObject({
      kind: 'protocol',
      code: 'bad_request',
      message: 'path must be a string',
    });
  });

  test('a message that is not JSON is dropped and the stream goes on', async () => {
    hands.raw('not json\n');
    expect(await hands.result('ping')).toBeNull();
  });
});

describe('the read limit', () => {
  let small: Hands;
  let dir: string;

  beforeAll(() => {
    dir = scratch('small');
    small = new Hands({ cwd: dir, args: ['--max-read-bytes', '1024'] });
    writeFileSync(join(dir, 'fits.txt'), 'a'.repeat(1024));
    writeFileSync(join(dir, 'over.txt'), 'a'.repeat(1025));
  });

  afterAll(async () => {
    small.end();
    await small.exited;
  });

  test('a file at the limit reads, and one byte over does not', async () => {
    expect(
      await small.result<string>('readTextFile', { path: 'fits.txt' }),
    ).toHaveLength(1024);
    for (const method of ['readTextFile', 'readBinaryFile', 'readTextLines']) {
      expect(await small.error(method, { path: 'over.txt' })).toMatchObject({
        kind: 'file',
        code: 'invalid',
        message: expect.stringContaining('1024-byte read limit'),
      });
    }
  });

  test('a file that reports no size is still held to the limit', async () => {
    const big = '/proc/self/smaps';
    expect((await small.error('readTextFile', { path: big })).code).toBe(
      'invalid',
    );
  });

  test('a line reader refuses a line longer than the limit', async () => {
    writeFileSync(join(dir, 'long.txt'), `${'b'.repeat(200_000)}\nshort\n`);
    const { reader } = await small.result<{ reader: number }>('reader.open', {
      path: 'long.txt',
    });
    expect((await small.error('reader.readLine', { reader })).code).toBe(
      'invalid',
    );
  });

  test('a request over the line limit is refused by id', async () => {
    const limit = (await small.result<Hello>('hello')).limits.maxRequestBytes;
    const answer = await small.callWith(9_000, 'writeFile', {
      path: 'huge.txt',
      content: 'c'.repeat(limit + 1),
    });
    expect(answer).toMatchObject({
      error: { kind: 'protocol', code: 'too_large' },
    });
    expect(await small.result('ping')).toBeNull();
  });
});
