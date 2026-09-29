/**
 * `writeFiles`, which writes credentials: modes the daemon's umask does not
 * narrow, a rename over the target that replaces a symlink and does not
 * follow it, and a failure that names its path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileWrite, Hello } from '../src/protocol.ts';
import { Hands, removeScratch, scratch } from './support.ts';

const started: Hands[] = [];

/** A daemon started under `umask`, which it inherits. */
function under(umask: number): { hands: Hands; cwd: string; home: string } {
  const cwd = scratch('stamp');
  const home = scratch('home');
  const before = process.umask(umask);
  try {
    const hands = new Hands({ cwd, env: { HOME: home } });
    started.push(hands);
    return { hands, cwd, home };
  } finally {
    process.umask(before);
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

afterAll(async () => {
  for (const hands of started.splice(0)) {
    hands.end();
    await hands.exited;
  }
  removeScratch();
});

describe('under a permissive umask', () => {
  let hands: Hands;
  let cwd: string;
  let home: string;

  beforeAll(() => {
    ({ hands, cwd, home } = under(0o000));
  });

  test('files get their mode and new parents get 0700', async () => {
    const files: FileWrite[] = [
      { path: 'creds/deep/token', content: 'ghs-a-token', mode: 0o600 },
      { path: '~/.kube/config', content: 'apiVersion: v1\n', mode: 0o600 },
    ];
    expect(await hands.result('writeFiles', { files })).toEqual({
      written: 2,
    });
    expect(readFileSync(join(cwd, 'creds/deep/token'), 'utf8')).toBe(
      'ghs-a-token',
    );
    expect(modeOf(join(cwd, 'creds/deep/token'))).toBe(0o600);
    expect(modeOf(join(cwd, 'creds'))).toBe(0o700);
    expect(modeOf(join(cwd, 'creds/deep'))).toBe(0o700);
    expect(modeOf(join(home, '.kube/config'))).toBe(0o600);
    expect(modeOf(join(home, '.kube'))).toBe(0o700);
  });

  test('an existing parent keeps its mode', async () => {
    mkdirSync(join(cwd, 'shared'));
    chmodSync(join(cwd, 'shared'), 0o755);
    await hands.result('writeFiles', {
      files: [{ path: 'shared/key', content: 'k', mode: 0o600 }],
    });
    expect(modeOf(join(cwd, 'shared'))).toBe(0o755);
  });

  test('an existing file is overwritten, and takes the new mode', async () => {
    writeFileSync(join(cwd, 'over'), 'a much longer old value');
    chmodSync(join(cwd, 'over'), 0o644);
    await hands.result('writeFiles', {
      files: [{ path: 'over', content: 'new', mode: 0o600 }],
    });
    expect(readFileSync(join(cwd, 'over'), 'utf8')).toBe('new');
    expect(modeOf(join(cwd, 'over'))).toBe(0o600);
  });

  test('a symlink at the path is replaced, not followed', async () => {
    writeFileSync(join(cwd, 'outside'), 'keep');
    symlinkSync(join(cwd, 'outside'), join(cwd, 'link'));
    await hands.result('writeFiles', {
      files: [{ path: 'link', content: 'secret', mode: 0o600 }],
    });
    expect(lstatSync(join(cwd, 'link')).isFile()).toBe(true);
    expect(readFileSync(join(cwd, 'link'), 'utf8')).toBe('secret');
    expect(readFileSync(join(cwd, 'outside'), 'utf8')).toBe('keep');
  });

  test('empty content retires a file', async () => {
    writeFileSync(join(cwd, 'retired'), 'ghs-a-token');
    await hands.result('writeFiles', {
      files: [{ path: 'retired', content: '', mode: 0o600 }],
    });
    expect(statSync(join(cwd, 'retired')).size).toBe(0);
    expect(modeOf(join(cwd, 'retired'))).toBe(0o600);
  });

  test('base64 content is written as bytes', async () => {
    const bytes = Buffer.from([0, 1, 10, 127, 128, 255]);
    await hands.result('writeFiles', {
      files: [
        {
          path: 'blob',
          content: bytes.toString('base64'),
          encoding: 'base64',
          mode: 0o600,
        },
      ],
    });
    expect([...readFileSync(join(cwd, 'blob'))]).toEqual([...bytes]);
  });

  test('a failure names its path, keeps the files before it and leaves no temp file', async () => {
    mkdirSync(join(cwd, 'fails/taken'), { recursive: true });
    const error = await hands.error('writeFiles', {
      files: [
        { path: 'fails/first', content: '1', mode: 0o600 },
        { path: 'fails/taken', content: '2', mode: 0o600 },
        { path: 'fails/third', content: '3', mode: 0o600 },
      ],
    });
    expect(error).toMatchObject({
      kind: 'file',
      path: join(cwd, 'fails/taken'),
      message: expect.stringContaining(join(cwd, 'fails/taken')),
    });
    expect(readdirSync(join(cwd, 'fails')).sort()).toEqual(['first', 'taken']);
  });

  test('a bad entry is refused before any file is written', async () => {
    for (const bad of [
      { path: 'x', content: 'x' },
      { path: 'x', content: 'x', mode: 0o1777 },
      { path: 'x', content: 'x', mode: -1 },
      { path: 'x', content: 'x', mode: 0o600, encoding: 'hex' },
      { path: 7, content: 'x', mode: 0o600 },
    ]) {
      expect(
        await hands.error('writeFiles', {
          files: [{ path: 'refused/first', content: '1', mode: 0o600 }, bad],
        }),
      ).toMatchObject({ kind: 'protocol', code: 'bad_request' });
    }
    expect(
      await hands.error('writeFiles', {
        files: [{ path: 'refused/first', content: '1', mode: 0o600 }],
        dirMode: 0o1000,
      }),
    ).toMatchObject({ kind: 'protocol', code: 'bad_request' });
    for (const files of [undefined, 'x', ['x']]) {
      expect(await hands.error('writeFiles', { files })).toMatchObject({
        kind: 'protocol',
        code: 'bad_request',
      });
    }
    expect(await hands.result('exists', { path: 'refused' })).toBe(false);
  });

  test('no files writes nothing', async () => {
    expect(await hands.result('writeFiles', { files: [] })).toEqual({
      written: 0,
    });
  });
});

describe('under a restrictive umask', () => {
  test('files and new parents still get their modes', async () => {
    const { hands, cwd } = under(0o077);
    await hands.result('writeFiles', {
      files: [{ path: 'wide/open', content: 'x', mode: 0o644 }],
      dirMode: 0o750,
    });
    expect(modeOf(join(cwd, 'wide/open'))).toBe(0o644);
    expect(modeOf(join(cwd, 'wide'))).toBe(0o750);
  });
});

describe('the request limit', () => {
  test('a writeFiles over the line limit is refused by id', async () => {
    const small = new Hands({
      cwd: scratch('small'),
      args: ['--max-read-bytes', '1024'],
    });
    started.push(small);
    const limit = (await small.result<Hello>('hello')).limits.maxRequestBytes;
    const answer = await small.callWith(77, 'writeFiles', {
      files: [{ path: 'big', content: 'c'.repeat(limit), mode: 0o600 }],
    });
    expect(answer).toMatchObject({
      error: { kind: 'protocol', code: 'too_large' },
    });
  });
});
