/**
 * A directory as the gzipped tar a release is: the wire format every reader
 * of a staged bundle opens, written the one way (ustar, GNU long names, no
 * timestamps) so the same files always upload as the same bytes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What a site carries: no dotfiles, no `node_modules`, and never `kthx.json`. */
export function included(path: string): boolean {
  return (
    path !== 'kthx.json' &&
    !path
      .split('/')
      .some((part) => part.startsWith('.') || part === 'node_modules')
  );
}

export interface Packed {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly files: number;
  /** Bytes before compression. */
  readonly size: number;
}

/** The files under `dir` that a site carries, as one gzipped tar. */
export function pack(dir: string): Packed {
  const paths = [...new Bun.Glob('**/*').scanSync({ cwd: dir, dot: true })]
    .map((path) => path.replaceAll('\\', '/'))
    .filter(included)
    .sort();
  const entries = paths.map((path) => ({
    path,
    bytes: new Uint8Array(readFileSync(join(dir, path))),
  }));
  return {
    bytes: tarGz(entries),
    files: entries.length,
    size: entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
  };
}

export interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
/** The header's name field; a longer path rides in a GNU long-name entry before it. */
const NAME_LIMIT = 100;

export function tarGz(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    if (name.length > NAME_LIMIT) {
      blocks.push(header('././@LongLink', name.length + 1, 'L'));
      blocks.push(padded(concat([name, new Uint8Array(1)])));
    }
    blocks.push(header(entry.path, entry.bytes.length, '0'));
    if (entry.bytes.length > 0) blocks.push(padded(entry.bytes));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  return Bun.gzipSync(concat(blocks));
}

function header(name: string, size: number, typeFlag: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const write = (text: string, at: number, length: number) =>
    block.set(new TextEncoder().encode(text).subarray(0, length), at);
  const octal = (value: number, at: number, length: number) =>
    write(value.toString(8).padStart(length - 1, '0'), at, length);
  write(name, 0, NAME_LIMIT);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  write(typeFlag, 156, 1);
  write('ustar', 257, 6);
  write('00', 263, 2);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(sum, 148, 7);
  block[155] = 0x20;
  return block;
}

/** Entry data, rounded up to the block size tar counts in. */
function padded(bytes: Uint8Array): Uint8Array {
  const block = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  block.set(bytes, 0);
  return block;
}

function concat(blocks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(blocks.reduce((sum, b) => sum + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}
