/**
 * Paths that are not regular files. A FIFO opened for a blocking read or
 * write never returns, ignores cancel and holds a thread of the fs pool, so
 * the daemon refuses what the opened fd shows is not a regular file, and
 * `exists` and `fileInfo` answer as pi's `NodeExecutionEnv` does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { FileInfo, WireError } from '../src/protocol.ts';
import { Hands, removeScratch, scratch } from './support.ts';

let hands: Hands;
let cwd: string;
const fifos: string[] = [];

function fifo(name: string): string {
  const path = join(cwd, name);
  const made = Bun.spawnSync(['mkfifo', path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path} failed`);
  fifos.push(path);
  return path;
}

/** The bytes waiting in a nonblocking FIFO's read end. */
function pending(fd: number): number {
  try {
    return readSync(fd, Buffer.alloc(64));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return 0;
    throw error;
  }
}

function notRegular(path: string): WireError {
  return {
    kind: 'file',
    code: 'invalid',
    message: `${path} is not a regular file`,
    path,
  };
}

beforeAll(() => {
  cwd = scratch('types');
  hands = new Hands({ cwd });
});

// Opening each FIFO for both ends releases any open a regression left
// blocked, so the daemon can exit.
afterAll(async () => {
  for (const path of fifos.splice(0)) {
    try {
      closeSync(openSync(path, constants.O_RDWR | constants.O_NONBLOCK));
    } catch {}
  }
  hands.end();
  await Promise.race([hands.exited, Bun.sleep(3_000)]);
  hands.kill();
  removeScratch();
});

describe('reads', () => {
  test('a FIFO is refused by every read, without blocking', async () => {
    const path = fifo('read.fifo');
    for (const method of ['readTextFile', 'readBinaryFile', 'readTextLines']) {
      expect(await hands.error(method, { path: 'read.fifo' })).toEqual(
        notRegular(path),
      );
    }
    expect(await hands.error('reader.open', { path: 'read.fifo' })).toEqual(
      notRegular(path),
    );
  });

  test('a symlink to a FIFO is refused by the fd it opens', async () => {
    const target = fifo('target.fifo');
    symlinkSync(target, join(cwd, 'to-fifo'));
    expect(await hands.error('readTextFile', { path: 'to-fifo' })).toEqual(
      notRegular(join(cwd, 'to-fifo')),
    );
    expect(
      await hands.error('writeFile', { path: 'to-fifo', content: 'x' }),
    ).toEqual(notRegular(join(cwd, 'to-fifo')));
  });

  test('a device and a socket are refused', async () => {
    expect(await hands.error('readTextFile', { path: '/dev/null' })).toEqual(
      notRegular('/dev/null'),
    );
    const socket = join(cwd, 'sock');
    const server = Bun.listen({ unix: socket, socket: { data() {} } });
    try {
      expect(await hands.error('readBinaryFile', { path: 'sock' })).toEqual(
        notRegular(socket),
      );
    } finally {
      server.stop(true);
    }
  });

  test('a directory is still is_directory', async () => {
    mkdirSync(join(cwd, 'dir'), { recursive: true });
    for (const method of ['readTextFile', 'readTextLines', 'reader.open']) {
      expect(await hands.error(method, { path: 'dir' })).toMatchObject({
        kind: 'file',
        code: 'is_directory',
        path: join(cwd, 'dir'),
      });
    }
  });
});

describe('writes', () => {
  test('a FIFO with no reader is refused', async () => {
    const path = fifo('lonely.fifo');
    for (const method of ['writeFile', 'appendFile']) {
      expect(
        await hands.error(method, { path: 'lonely.fifo', content: 'x' }),
      ).toEqual(notRegular(path));
    }
  });

  test('a FIFO with a reader is refused, and gets no bytes', async () => {
    const path = fifo('read-end.fifo');
    const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      for (const method of ['writeFile', 'appendFile']) {
        expect(
          await hands.error(method, { path: 'read-end.fifo', content: 'x' }),
        ).toEqual(notRegular(path));
      }
      expect(pending(reader)).toBe(0);
    } finally {
      closeSync(reader);
    }
  });

  test('a device is refused', async () => {
    expect(
      await hands.error('writeFile', { path: '/dev/null', content: 'x' }),
    ).toEqual(notRegular('/dev/null'));
  });

  test('writing a directory is still is_directory', async () => {
    mkdirSync(join(cwd, 'wdir'), { recursive: true });
    expect(
      await hands.error('writeFile', { path: 'wdir', content: 'x' }),
    ).toMatchObject({ kind: 'file', code: 'is_directory' });
  });
});

describe('exists and fileInfo, as pi answers them', () => {
  test('a FIFO, a socket and a device are an Unsupported file type', async () => {
    const path = fifo('info.fifo');
    const socket = join(cwd, 'info.sock');
    const server = Bun.listen({ unix: socket, socket: { data() {} } });
    try {
      for (const target of [path, socket, '/dev/null']) {
        const unsupported: WireError = {
          kind: 'file',
          code: 'invalid',
          message: 'Unsupported file type',
          path: target,
        };
        expect(await hands.error('fileInfo', { path: target })).toEqual(
          unsupported,
        );
        expect(await hands.error('exists', { path: target })).toEqual(
          unsupported,
        );
      }
    } finally {
      server.stop(true);
    }
  });

  test('a symlink to a FIFO exists and is a symlink', async () => {
    const target = fifo('linked.fifo');
    symlinkSync(target, join(cwd, 'info-link'));
    expect(await hands.result('exists', { path: 'info-link' })).toBe(true);
    expect(
      await hands.result<FileInfo>('fileInfo', { path: 'info-link' }),
    ).toMatchObject({ kind: 'symlink', path: join(cwd, 'info-link') });
  });

  test('a missing path does not exist, and a path through a file is an error', async () => {
    writeFileSync(join(cwd, 'plain'), '');
    expect(await hands.result('exists', { path: 'missing' })).toBe(false);
    expect(await hands.error('exists', { path: 'plain/child' })).toMatchObject({
      code: 'not_directory',
    });
  });

  test('a listing leaves a FIFO out, and listing a FIFO is not_directory', async () => {
    mkdirSync(join(cwd, 'listed'));
    writeFileSync(join(cwd, 'listed', 'file'), '');
    fifo('listed/pipe');
    const listed = await hands.result<FileInfo[]>('listDir', {
      path: 'listed',
    });
    expect(listed.map((f) => f.name)).toEqual(['file']);
    expect(await hands.error('listDir', { path: 'listed/pipe' })).toMatchObject(
      { code: 'not_directory' },
    );
  });
});

describe('the fs pool', () => {
  // More FIFO calls than the host has CPUs, enough to fill Bun's fs pool if
  // the opens blocked, and within the daemon's in-flight budget.
  const count = Math.min(availableParallelism() + 4, 48);

  test(`${count} FIFO calls do not block unrelated file calls`, async () => {
    const methods = ['readBinaryFile', 'writeFile', 'readTextLines'];
    const calls = Array.from({ length: count }, (_, i) => {
      const name = `pool-${i}.fifo`;
      fifo(name);
      const method = methods[i % methods.length] as string;
      return hands.start(method, { path: name, content: 'x' }).answer;
    });
    writeFileSync(join(cwd, 'unrelated.txt'), 'still here');
    expect(await hands.result('readTextFile', { path: 'unrelated.txt' })).toBe(
      'still here',
    );
    expect(
      await hands.result<FileInfo>('fileInfo', { path: 'unrelated.txt' }),
    ).toMatchObject({ kind: 'file' });
    for (const answer of await Promise.all(calls)) {
      expect(answer).toMatchObject({ error: { code: 'invalid' } });
    }
  });
});
