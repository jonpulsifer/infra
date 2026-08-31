/**
 * Reading a `files` artifact back into the files it holds.
 *
 * §6's artifact is a digest and the addresses it can be pulled by, and for the
 * `files` shape what is at those addresses is **a gzipped tar**. That is not a
 * choice made here — `adapters/build/buildkit.ts` fetches a staged bundle with
 * `tar -xz`, so it is already the one format every route agrees on, and this is
 * the same format read from the other end.
 *
 * It is hand-written rather than a dependency, and the reason is §20: the
 * extraction contract wants a package that prunes to something self-contained,
 * and a tar reader is ninety lines of a format that has not changed since 1988.
 * What it deliberately does **not** do is anything a tar can do that a website
 * cannot contain — devices, hard links, symlinks — because a static host serves
 * bytes at paths and has no representation for any of them.
 *
 * **The bundle is untrusted input.** It arrives from a builder or from whoever
 * uploaded an archive, so {@link readBundle} refuses a path that escapes the
 * root rather than trusting that no `../` appears in one. A deploy that wrote
 * outside its own site would be the only path in this system by which one App
 * could reach another's.
 */
import { gunzipSync } from 'node:zlib';

/** One file the bundle holds, at the path it will be served from. */
export interface BundleFile {
  /** Rooted at the site, with a leading slash — the shape hosting wants. */
  readonly path: string;
  /**
   * Its contents, in a buffer this runtime's compression accepts.
   *
   * The explicit `ArrayBuffer` parameter is not decoration: a `Uint8Array` may
   * be backed by shared memory, which cannot be compressed in place, and the
   * type is what keeps a caller from discovering that at run time.
   */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Why a bundle could not be read. A closed set, so a caller can say which. */
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
/** Tar's fixed block size, which every field offset below is relative to. */
const BLOCK = 512;

/** Header field offsets, as the format defines them. */
const NAME = { at: 0, length: 100 };
const SIZE = { at: 124, length: 12 };
const TYPE_FLAG = 156;
const PREFIX = { at: 345, length: 155 };

/**
 * The type flags this reader understands.
 *
 * `\0` and `0` are both a regular file — the first is the original format, the
 * second is ustar, and archives in the wild carry both. `L` and `x` are the two
 * ways a long path arrives: GNU's own extension, and the pax record that
 * replaced it. Everything else is skipped with its data, which is what makes an
 * archive containing a symlink deploy the files around it rather than fail.
 */
const REGULAR = new Set(['\0', '0']);
const DIRECTORY = '5';
const GNU_LONG_NAME = 'L';
const PAX_HEADER = 'x';

/**
 * Read a gzipped tar into its files.
 *
 * Directories are dropped rather than represented: hosting has no directories,
 * only paths, and a bundle's empty directory has nothing to serve.
 *
 * `maxBytes` bounds the inflated tar, because the compressed size says nothing
 * about it: an untrusted upload is refused as `TOO_LARGE` before it is held.
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
    // Two consecutive zero blocks end an archive; one is enough to stop on,
    // because nothing valid follows a header with no name.
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
    // Entries are padded up to the next block boundary.
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
 * A bundle path as the path it is served at.
 *
 * Three normalizations, in order: the leading `./` every archiver writes is
 * dropped, the result is checked for anything that would leave the bundle, and
 * a leading slash is added because that is the form hosting addresses files by.
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

/** `prefix` and `name`, which is how ustar carries a path over 100 bytes. */
function joinedName(header: Uint8Array): string {
  const name = text(header, NAME);
  const prefix = text(header, PREFIX);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * The `path` record of a pax extended header.
 *
 * Records are `<length> <key>=<value>\n`, and the length counts itself — which
 * is why this reads keys rather than splitting on newlines: a value is allowed
 * to contain one.
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

/** A NUL-terminated ASCII field. */
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

/** A NUL- or space-padded octal field, which is how tar writes every number. */
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
