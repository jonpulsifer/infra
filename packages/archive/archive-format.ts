/**
 * Normalizes an upload to a gzipped tar, the format every build route extracts
 * with `tar -xz`. A ZIP is transcoded deterministically, so one upload always
 * stages under one digest; anything else is refused. Digest the normalized
 * bytes: build routes check the staged object's sha256 before extracting.
 */
import { deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';

export type ArchiveFormat = 'gzip' | 'zip';

export type ArchiveFormatErrorCode =
  | 'UNKNOWN_FORMAT'
  | 'UNSUPPORTED_ZIP'
  | 'MALFORMED_ZIP'
  | 'PATH_ESCAPES_ARCHIVE'
  | 'TOO_LARGE';

export class ArchiveFormatError extends Error {
  constructor(
    readonly code: ArchiveFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/**
 * Sniffs the magic number, never the filename: an upload with no name is
 * called `upload.zip` whatever it holds.
 */
export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    return 'gzip';
  // PK\3\4 local header, PK\5\6 end of an empty archive, PK\7\8 spanned marker.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  ) {
    return 'zip';
  }
  return null;
}

export interface NormalizedArchive {
  readonly bytes: Uint8Array;
  /** Ends in `.tar.gz` after a transcode. */
  readonly filename: string;
  readonly from: ArchiveFormat;
}

/**
 * Passes a gzip through, transcodes a ZIP, and otherwise throws
 * {@link ArchiveFormatError}. `maxBytes` caps a ZIP's declared unpacked size.
 */
export function normalizeArchive(
  filename: string,
  bytes: Uint8Array,
  maxBytes = Number.POSITIVE_INFINITY,
): NormalizedArchive {
  const format = sniffArchiveFormat(bytes);
  if (format === null) {
    throw new ArchiveFormatError(
      'UNKNOWN_FORMAT',
      `${filename} is neither a gzipped tar nor a ZIP — a staged bundle has to be one of those, because every build route opens it with \`tar -xz\`. What arrived starts ${describe(bytes)}.`,
    );
  }
  if (format === 'gzip') return { bytes, filename, from: 'gzip' };
  return {
    bytes: tarGzOf(readZipEntries(bytes, filename, maxBytes)),
    filename: `${filename.replace(/\.zip$/i, '')}.tar.gz`,
    from: 'zip',
  };
}

/**
 * Re-frames a gzipped tar with fixed settings so its digest follows the tar: a
 * host may compress one commit's tarball differently on each fetch.
 */
export function canonicalGzip(bytes: Uint8Array): Uint8Array {
  return gzip(new Uint8Array(gunzipSync(bytes)));
}

function describe(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'empty';
  const head = [...bytes.subarray(0, 4)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  return `with ${head}`;
}

interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly directory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** A 22-byte record plus a comment of up to 64 KiB. */
const EOCD_MAX = 22 + 0xffff;
const STORED = 0;
const DEFLATED = 8;

function readZipEntries(
  zip: Uint8Array,
  filename: string,
  maxBytes: number,
): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEndOfCentralDirectory(view, zip.length, filename);

  const count = view.getUint16(eocd + 10, true);
  const start = view.getUint32(eocd + 16, true);
  // Zip64 sets these to sentinels and keeps the real values in a record this
  // reader does not parse, so it is refused instead of half-read.
  if (count === 0xffff || start === 0xffffffff) {
    throw new ArchiveFormatError(
      'UNSUPPORTED_ZIP',
      `${filename} is a Zip64 archive, which this boundary does not read — upload it as a gzipped tar instead.`,
    );
  }

  // Sum declared sizes first so a zip bomb is refused before anything inflates;
  // `inflateEntry` then holds each entry to its declared size.
  let declared = 0;
  for (let index = 0, scan = start; index < count; index += 1) {
    if (scan + 46 > zip.length) break;
    declared += view.getUint32(scan + 24, true);
    scan +=
      46 +
      view.getUint16(scan + 28, true) +
      view.getUint16(scan + 30, true) +
      view.getUint16(scan + 32, true);
  }
  if (declared > maxBytes) {
    throw new ArchiveFormatError(
      'TOO_LARGE',
      `${filename} declares ${declared} bytes unpacked, over the ${maxBytes} this boundary holds.`,
    );
  }

  const entries: ZipEntry[] = [];
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (
      at + 46 > zip.length ||
      view.getUint32(at, true) !== CENTRAL_SIGNATURE
    ) {
      throw new ArchiveFormatError(
        'MALFORMED_ZIP',
        `${filename} has a central directory this reader cannot follow at entry ${index + 1} of ${count}.`,
      );
    }
    const madeBy = view.getUint16(at + 4, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const externalAttributes = view.getUint32(at + 38, true);
    const localHeader = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLength),
    );

    const directory = path.endsWith('/');
    entries.push({
      path: safePath(directory ? path.slice(0, -1) : path, filename),
      bytes: directory
        ? new Uint8Array(0)
        : inflateEntry(
            zip,
            view,
            localHeader,
            method,
            compressedSize,
            uncompressedSize,
            path,
            filename,
          ),
      mode: modeOf(madeBy, externalAttributes, directory),
      directory,
    });

    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Scans backwards: a variable-length comment follows the record at the end.
function findEndOfCentralDirectory(
  view: DataView,
  length: number,
  filename: string,
): number {
  const floor = Math.max(0, length - EOCD_MAX);
  for (let at = length - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new ArchiveFormatError(
    'MALFORMED_ZIP',
    `${filename} starts like a ZIP but carries no end-of-central-directory record — it is truncated or only part of a multi-part archive.`,
  );
}

function inflateEntry(
  zip: Uint8Array,
  view: DataView,
  localHeader: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  path: string,
  filename: string,
): Uint8Array {
  if (method !== STORED && method !== DEFLATED) {
    throw new ArchiveFormatError(
      'UNSUPPORTED_ZIP',
      `${filename} compresses ${path} with method ${method}; this boundary reads stored and deflated entries only.`,
    );
  }
  // The local extra field can differ in length from the central copy, so the
  // data offset comes from the local header.
  const nameLength = view.getUint16(localHeader + 26, true);
  const extraLength = view.getUint16(localHeader + 28, true);
  const from = localHeader + 30 + nameLength + extraLength;
  const raw = zip.subarray(from, from + compressedSize);

  let bytes: Uint8Array;
  try {
    bytes =
      method === STORED
        ? new Uint8Array(raw)
        : new Uint8Array(
            inflateRawSync(raw, {
              maxOutputLength: Math.max(1, uncompressedSize),
            }),
          );
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    bytes = new Uint8Array(uncompressedSize + 1);
  }
  if (bytes.length !== uncompressedSize) {
    throw new ArchiveFormatError(
      'MALFORMED_ZIP',
      `${path} in ${filename} unpacked to ${bytes.length} bytes where its directory entry declares ${uncompressedSize}.`,
    );
  }
  return bytes;
}

/**
 * Read so executable bits survive the transcode. The high byte of
 * `version made by` is the host system, and 3 is unix.
 */
function modeOf(
  madeBy: number,
  externalAttributes: number,
  directory: boolean,
): number {
  const unix = madeBy >> 8 === 3;
  const recorded = (externalAttributes >>> 16) & 0o7777;
  if (unix && recorded !== 0) return recorded;
  return directory ? 0o755 : 0o644;
}

/** Uploads are untrusted: refuse an entry that extracts outside the root. */
function safePath(path: string, filename: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const escapes =
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..');
  if (escapes || normalized === '') {
    throw new ArchiveFormatError(
      'PATH_ESCAPES_ARCHIVE',
      `${filename} contains an entry named ${path}, which would write outside the bundle.`,
    );
  }
  return normalized;
}

const BLOCK = 512;
const REGULAR = '0';
const DIRECTORY = '5';
const GNU_LONG_NAME = 'L';
/** The ustar name field, in bytes. */
const NAME_LIMIT = 100;

function tarGzOf(entries: readonly ZipEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const name = entry.directory ? `${entry.path}/` : entry.path;
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > NAME_LIMIT) {
      // A GNU long-name entry, whose data is the full name. The ustar prefix
      // field cannot hold a long name that has no `/` in the right place.
      blocks.push(
        header(`${'././@LongLink'}`, bytes.length + 1, 0o644, GNU_LONG_NAME),
      );
      blocks.push(padded(new TextEncoder().encode(`${name}\0`)));
    }
    blocks.push(
      header(
        truncate(name),
        entry.directory ? 0 : entry.bytes.length,
        entry.mode,
        entry.directory ? DIRECTORY : REGULAR,
      ),
    );
    if (!entry.directory && entry.bytes.length > 0) {
      blocks.push(padded(entry.bytes));
    }
  }
  // Two zero blocks end an archive; tar warns when there is only one.
  blocks.push(new Uint8Array(BLOCK * 2));

  return gzip(concat(blocks));
}

/** No mtime, no filename and a fixed level: equal input gives equal bytes. */
function gzip(tar: Uint8Array): Uint8Array {
  const body = new Uint8Array(deflateRawSync(tar, { level: 9 }));
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff], 0);
  out.set(body, 10);
  const trailer = new DataView(out.buffer, 10 + body.length, 8);
  trailer.setUint32(0, crc32(tar), true);
  trailer.setUint32(4, tar.length >>> 0, true);
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Safe to cut: the long-name entry before this header has the full name. */
function truncate(name: string): string {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= NAME_LIMIT) return name;
  return new TextDecoder().decode(bytes.subarray(0, NAME_LIMIT));
}

function header(
  name: string,
  size: number,
  mode: number,
  typeFlag: string,
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const write = (text: string, at: number, length: number) => {
    const bytes = new TextEncoder().encode(text);
    block.set(bytes.subarray(0, length), at);
  };
  const octal = (value: number, at: number, length: number) => {
    write(value.toString(8).padStart(length - 1, '0'), at, length);
  };

  write(name, 0, 100);
  octal(mode & 0o7777, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(0, 136, 12); // mtime, constant so the digest depends only on content
  write(typeFlag, 156, 1);
  write('ustar', 257, 6);
  write('00', 263, 2);

  // tar sums the header with its own checksum field read as spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(sum, 148, 7);
  block[155] = 0x20;
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const size = Math.ceil(bytes.length / BLOCK) * BLOCK;
  const block = new Uint8Array(size);
  block.set(bytes, 0);
  return block;
}

function concat(blocks: readonly Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}
