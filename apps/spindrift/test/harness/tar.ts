/**
 * A tar writer, so a test can hand the static adapter a real bundle.
 *
 * The adapter reads a gzipped tar because that is the format every build route
 * already agrees on (`adapters/build/buildkit.ts` unpacks one), and a reader is
 * only worth having if something independent produced what it reads. So this
 * writes the bytes rather than the reader's own output being fed back to it —
 * a round trip through one implementation proves that implementation
 * self-consistent and nothing else.
 *
 * It writes plain ustar with no extensions, which is the case the reader must
 * get right; the long-name and pax paths are exercised by hand-built headers in
 * `test/adapters/static.test.ts`, where the point is the header rather than the
 * archive around it.
 */

const BLOCK = 512;

/** One entry to put in the archive. */
export interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** `0` for a regular file, `5` for a directory. Defaults to a file. */
  readonly type?: string;
}

/** A gzipped tar holding these entries, as the adapter will receive it. */
export function tarball(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(tar(entries));
}

/** An uncompressed tar holding these entries. */
export function tar(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    const padded = Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
    const data = new Uint8Array(padded);
    data.set(entry.bytes);
    blocks.push(data);
  }
  // Two zero blocks end an archive.
  blocks.push(new Uint8Array(BLOCK * 2));
  return concat(blocks);
}

/** One 512-byte ustar header, checksum included. */
export function header(entry: TarEntry): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK);
  write(block, entry.name, 0, 100);
  write(block, '000644 ', 100, 8);
  write(block, '000000 ', 108, 8);
  write(block, '000000 ', 116, 8);
  write(block, `${entry.bytes.length.toString(8).padStart(11, '0')} `, 124, 12);
  write(block, '00000000000 ', 136, 12);
  // The checksum field is treated as spaces while the checksum is computed.
  write(block, '        ', 148, 8);
  write(block, entry.type ?? '0', 156, 1);
  write(block, 'ustar\0', 257, 6);
  write(block, '00', 263, 2);

  let sum = 0;
  for (const byte of block) sum += byte;
  write(block, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function write(
  block: Uint8Array,
  value: string,
  at: number,
  length: number,
): void {
  const bytes = new TextEncoder().encode(value);
  block.set(bytes.subarray(0, length), at);
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Some bytes, as a `Uint8Array` the writer and the adapter both accept. */
export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
