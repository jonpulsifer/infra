/**
 * The file methods, with pi's `NodeExecutionEnv` semantics and a cap on every
 * read, because a whole file crosses the exec stream as one message.
 */
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  appendFile,
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
  fileError,
  HandsError,
  type Limits,
  protocolError,
  type TextLine,
} from './protocol.ts';

const CHUNK_BYTES = 64 * 1024;

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
    const handle = await open(path, 'r');
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
      await open(path, 'r'),
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
    if (append) await appendFile(path, content);
    else await writeFile(path, content, { signal });
    return null;
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

  async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
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
    const handle = await open(path, 'r');
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
