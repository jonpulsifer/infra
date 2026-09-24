/**
 * Reads a `files` artifact, a gzipped tar, into the files a static host serves.
 * Devices, links and symlinks are skipped: a host serves bytes at paths only.
 */
import { gunzipSync } from 'node:zlib';

export interface BundleFile {
  /** Rooted at the site, with a leading slash. */
  readonly path: string;
  /** `ArrayBuffer`-backed, as `Bun.gzipSync` requires. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export type BundleErrorCode =
  | 'NOT_GZIP'
  | 'MALFORMED_TAR'
  | 'PATH_ESCAPES_BUNDLE'
  | 'TOO_LARGE';

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}
const BLOCK = 512;

const NAME = { at: 0, length: 100 };
const SIZE = { at: 124, length: 12 };
const TYPE_FLAG = 156;
const PREFIX = { at: 345, length: 155 };

/**
 * `\0` (old tar) and `0` (ustar) are both regular files; `L` (GNU) and `x`
 * (pax) carry long paths. Other types are skipped, so a symlink does not fail.
 */
const REGULAR = new Set(['\0', '0']);
const DIRECTORY = '5';
const GNU_LONG_NAME = 'L';
const PAX_HEADER = 'x';

/**
 * Drops directories, which a host has no use for. `maxBytes` caps the inflated
 * tar; the compressed size says nothing about it.
 */
export function readBundle(
  gzipped: Uint8Array<ArrayBuffer>,
  maxBytes = Number.POSITIVE_INFINITY,
): readonly BundleFile[] {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(gzipped, {
      maxOutputLength: Number.isFinite(maxBytes) ? maxBytes : undefined,
    });
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new BundleError(
        'TOO_LARGE',
        `the archive unpacks to more than ${maxBytes} bytes`,
      );
    }
    throw new BundleError(
      'NOT_GZIP',
      `the artifact is not a gzipped tar: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const files: BundleFile[] = [];
  /** Set by a long-name header, consumed by the entry that follows it. */
  let pendingName: string | null = null;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // tar ends with two zero blocks, but nothing valid follows even one.
    if (header.every((byte) => byte === 0)) break;

    const size = octal(header, SIZE);
    const flag = String.fromCharCode(header[TYPE_FLAG] ?? 0);
    const dataAt = offset + BLOCK;
    if (dataAt + size > tar.length) {
      throw new BundleError(
        'MALFORMED_TAR',
        'the archive ends inside an entry it declared',
      );
    }
    const data = tar.subarray(dataAt, dataAt + size);
    offset = dataAt + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === GNU_LONG_NAME) {
      pendingName = trimNul(new TextDecoder().decode(data));
      continue;
    }
    if (flag === PAX_HEADER) {
      pendingName = paxPath(data) ?? pendingName;
      continue;
    }

    const name = pendingName ?? joinedName(header);
    pendingName = null;
    if (flag === DIRECTORY || name === '' || name.endsWith('/')) continue;
    if (!REGULAR.has(flag)) continue;

    files.push({ path: servePath(name), bytes: Uint8Array.from(data) });
  }

  return files;
}

/**
 * A bundle comes from a builder or an upload and is untrusted: a `..` segment
 * would let one App write into another's site.
 */
function servePath(name: string): string {
  const cleaned = name.replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = cleaned.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new BundleError(
      'PATH_ESCAPES_BUNDLE',
      `the archive contains ${name}, which points outside itself`,
    );
  }
  return `/${segments.filter((segment) => segment !== '.').join('/')}`;
}

/** ustar splits a path over 100 bytes into `prefix` and `name`. */
function joinedName(header: Uint8Array): string {
  const name = text(header, NAME);
  const prefix = text(header, PREFIX);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * A pax record is `<length> <key>=<value>\n` and its length counts itself, so
 * records are walked by length: a value may contain a newline.
 */
function paxPath(data: Uint8Array): string | null {
  const text = new TextDecoder().decode(data);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(' ', at);
    if (space === -1) return null;
    const length = Number(text.slice(at, space));
    if (!Number.isFinite(length) || length <= 0) return null;
    const record = text.slice(space + 1, at + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') {
      return record.slice(equals + 1);
    }
    at += length;
  }
  return null;
}

function text(
  header: Uint8Array,
  field: { at: number; length: number },
): string {
  return trimNul(
    new TextDecoder().decode(
      header.subarray(field.at, field.at + field.length),
    ),
  );
}

/** tar writes every number as NUL- or space-padded octal. */
function octal(
  header: Uint8Array,
  field: { at: number; length: number },
): number {
  const raw = text(header, field).trim();
  if (raw === '') return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new BundleError('MALFORMED_TAR', `unreadable numeric field: ${raw}`);
  }
  return value;
}

function trimNul(value: string): string {
  const end = value.indexOf('\0');
  return end === -1 ? value : value.slice(0, end);
}
