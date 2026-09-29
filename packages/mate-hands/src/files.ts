/**
 * The file methods, with pi's `NodeExecutionEnv` semantics and a cap on every
 * read, because a whole file crosses the exec stream as one message. Reads
 * and writes open only regular files: a FIFO opened for a blocking read or
 * write never returns, ignores cancel and holds a thread of the fs pool.
 */
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type FileErrorCode,
  type FileInfo,
  type FileWrite,
  fileError,
  HandsError,
  type Limits,
  protocolError,
  type TextLine,
} from './protocol.ts';

const CHUNK_BYTES = 64 * 1024;

const {
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_NOCTTY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_WRONLY,
} = constants;
const READ = O_RDONLY | O_NONBLOCK | O_NOCTTY;
const WRITE = O_WRONLY | O_CREAT | O_NONBLOCK | O_NOCTTY;
const TEMP = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

/** A file for `writeFiles`, its path resolved and its content decoded. */
export type ResolvedWrite = Omit<FileWrite, 'content' | 'encoding'> & {
  content: string | Buffer;
};

const ERRNO = new Map<string | undefined, FileErrorCode>([
  ['ABORT_ERR', 'aborted'],
  ['ENOENT', 'not_found'],
  ['EACCES', 'permission_denied'],
  ['EPERM', 'permission_denied'],
  ['ENOTDIR', 'not_directory'],
  ['EISDIR', 'is_directory'],
  ['EINVAL', 'invalid'],
]);

export function toFileError(error: unknown, path?: string): HandsError {
  if (error instanceof HandsError) return error;
  const errno = error as NodeJS.ErrnoException | undefined;
  const code = ERRNO.get(errno?.code) ?? 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  return fileError(code, message, errno?.path ?? path);
}

function aborted(signal: AbortSignal, path?: string): void {
  if (signal.aborted) throw fileError('aborted', 'aborted', path);
}

function info(path: string, stats: Stats): FileInfo | null {
  const kind = stats.isFile()
    ? 'file'
    : stats.isDirectory()
      ? 'directory'
      : stats.isSymbolicLink()
        ? 'symlink'
        : null;
  if (!kind) return null;
  return {
    name: basename(path),
    path,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function notRegular(path: string): HandsError {
  return fileError('invalid', `${path} is not a regular file`, path);
}

/**
 * Opens `path` without blocking, and closes and refuses it unless the opened
 * fd is a regular file. The fd is checked, not the path, so a symlink to a
 * FIFO is refused too.
 */
async function openRegular(path: string, flags: number): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags, 0o666);
  } catch (error) {
    // What a FIFO with no reader, or a socket, answers a nonblocking open.
    if ((error as NodeJS.ErrnoException)?.code === 'ENXIO') {
      throw notRegular(path);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) {
      throw fileError('is_directory', `${path} is a directory`, path);
    }
    if (!stats.isFile()) throw notRegular(path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** `mkdir -p`, giving each directory it makes `mode` whatever the umask. */
async function makeParents(dir: string, mode: number): Promise<void> {
  const first = await mkdir(dir, { recursive: true, mode });
  if (first === undefined) return;
  // mkdir's mode passes through the umask, and chmod's does not.
  for (let at = dir; at.length >= first.length; at = dirname(at)) {
    await chmod(at, mode);
    if (at === dirname(at)) return;
  }
}

/** Writes a temp file beside `path` and renames it over `path`. */
async function replace(file: ResolvedWrite, dirMode: number): Promise<void> {
  const dir = dirname(file.path);
  await makeParents(dir, dirMode);
  const temp = join(dir, `.mate-hands-${randomUUID()}`);
  const handle = await open(temp, TEMP, file.mode);
  try {
    await handle.chmod(file.mode);
    await handle.writeFile(file.content);
    await handle.sync();
    await handle.close();
    await rename(temp, file.path);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
}

function tooLarge(path: string, max: number, what = path): HandsError {
  return fileError(
    'invalid',
    `${what} is over the ${max}-byte read limit; read part of it with a command`,
    path,
  );
}

/**
 * Reads LF-terminated lines from one open file. A line longer than the read
 * limit is an error, so the pending bytes stay bounded.
 */
class LineReader {
  private pending: Buffer = Buffer.alloc(0);
  private position = 0;
  private ended = false;

  constructor(
    private readonly handle: FileHandle,
    readonly path: string,
    private readonly maxBytes: number,
  ) {}

  async next(signal: AbortSignal): Promise<TextLine | null> {
    for (;;) {
      aborted(signal, this.path);
      const newline = this.pending.indexOf(10);
      if (newline !== -1) {
        const text = this.pending.subarray(0, newline).toString('utf8');
        this.pending = this.pending.subarray(newline + 1);
        return { text, terminated: true };
      }
      if (this.ended) {
        if (this.pending.length === 0) return null;
        const text = this.pending.toString('utf8');
        this.pending = Buffer.alloc(0);
        return { text, terminated: false };
      }
      if (this.pending.length > this.maxBytes) {
        throw tooLarge(this.path, this.maxBytes, `a line of ${this.path}`);
      }
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await this.handle.read(
        chunk,
        0,
        chunk.length,
        this.position,
      );
      this.position += bytesRead;
      if (bytesRead === 0) {
        this.ended = true;
      } else {
        const read = chunk.subarray(0, bytesRead);
        this.pending = Buffer.concat([this.pending, read]);
      }
    }
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }
}

export class Files {
  private readonly readers = new Map<number, LineReader>();
  private nextReader = 1;

  constructor(
    private readonly tmp: string,
    private readonly limits: Limits,
  ) {}

  /** Reads a whole file, refusing one over the limit, `/proc` files included. */
  async read(path: string, signal: AbortSignal): Promise<Buffer> {
    aborted(signal, path);
    const max = this.limits.maxReadBytes;
    const handle = await openRegular(path, READ);
    try {
      if ((await handle.stat()).size > max) throw tooLarge(path, max);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        aborted(signal, path);
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, max + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > max) throw tooLarge(path, max);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async readTextLines(
    path: string,
    maxLines: number | undefined,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (maxLines !== undefined && maxLines <= 0) return [];
    const reader = new LineReader(
      await openRegular(path, READ),
      path,
      this.limits.maxReadBytes,
    );
    try {
      const lines: string[] = [];
      let bytes = 0;
      while (maxLines === undefined || lines.length < maxLines) {
        const line = await reader.next(signal);
        if (!line) break;
        bytes += Buffer.byteLength(line.text) + 1;
        if (bytes > this.limits.maxReadBytes) {
          throw tooLarge(path, this.limits.maxReadBytes);
        }
        lines.push(line.text);
      }
      return lines;
    } finally {
      await reader.close();
    }
  }

  async write(
    path: string,
    content: Buffer | string,
    append: boolean,
    signal: AbortSignal,
  ): Promise<null> {
    aborted(signal, path);
    await mkdir(dirname(path), { recursive: true });
    aborted(signal, path);
    const handle = await openRegular(path, append ? WRITE | O_APPEND : WRITE);
    try {
      if (!append) {
        // A cancel is honoured only before the truncate, so it never leaves
        // the file empty.
        aborted(signal, path);
        await handle.truncate(0);
      }
      await handle.writeFile(content);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    await handle.close();
    return null;
  }

  async writeFiles(
    files: ResolvedWrite[],
    dirMode: number,
    signal: AbortSignal,
  ): Promise<{ written: number }> {
    let written = 0;
    for (const file of files) {
      aborted(signal, file.path);
      try {
        await replace(file, dirMode);
      } catch (error) {
        const { detail } = toFileError(error);
        const code = detail.kind === 'file' ? detail.code : 'unknown';
        throw fileError(
          code,
          `could not write ${file.path}: ${detail.message}`,
          file.path,
        );
      }
      written++;
    }
    return { written };
  }

  async rename(from: string, to: string): Promise<null> {
    try {
      await rename(from, to);
    } catch (error) {
      throw toFileError(error, from);
    }
    return null;
  }

  async fileInfo(path: string): Promise<FileInfo> {
    const found = info(path, await lstat(path));
    if (!found) throw fileError('invalid', 'Unsupported file type', path);
    return found;
  }

  async listDir(path: string, signal: AbortSignal): Promise<FileInfo[]> {
    const max = this.limits.maxListEntries;
    const entries: FileInfo[] = [];
    const dir = await opendir(path);
    try {
      for await (const entry of dir) {
        aborted(signal, path);
        if (entries.length >= max) {
          throw fileError(
            'invalid',
            `${path} has more than ${max} entries; list it with a command`,
            path,
          );
        }
        const child = join(path, entry.name);
        try {
          const found = info(child, await lstat(child));
          if (found) entries.push(found);
        } catch (error) {
          throw toFileError(error, child);
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
    return entries;
  }

  async canonicalPath(path: string): Promise<string> {
    return realpath(path);
  }

  /** pi's answer: an unsupported file type is an error, not a yes. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.fileInfo(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async createDir(path: string, recursive: boolean): Promise<null> {
    await mkdir(path, { recursive });
    return null;
  }

  async remove(
    path: string,
    recursive: boolean,
    force: boolean,
  ): Promise<null> {
    await rm(path, { recursive, force });
    return null;
  }

  async createTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(this.tmp, prefix));
  }

  async createTempFile(prefix: string, suffix: string): Promise<string> {
    const dir = await this.createTempDir('tmp-');
    const path = join(dir, `${prefix}${randomUUID()}${suffix}`);
    await writeFile(path, '', { flag: 'wx' });
    return path;
  }

  async openReader(path: string): Promise<{ reader: number }> {
    if (this.readers.size >= this.limits.maxReaders) {
      throw protocolError(
        'busy',
        `${this.limits.maxReaders} line readers are already open`,
      );
    }
    const handle = await openRegular(path, READ);
    const id = this.nextReader++;
    this.readers.set(
      id,
      new LineReader(handle, path, this.limits.maxReadBytes),
    );
    return { reader: id };
  }

  async readLine(id: number, signal: AbortSignal): Promise<TextLine | null> {
    const reader = this.readers.get(id);
    if (!reader) throw fileError('invalid', 'Text line reader is closed');
    try {
      return await reader.next(signal);
    } catch (error) {
      throw toFileError(error, reader.path);
    }
  }

  async closeReader(id: number): Promise<null> {
    const reader = this.readers.get(id);
    this.readers.delete(id);
    await reader?.close();
    return null;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.readers.keys()].map((id) => this.closeReader(id)),
    );
  }
}
