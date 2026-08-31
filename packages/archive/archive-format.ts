/**
 * Normalizing an uploaded archive to the one container every route can open.
 *
 * §4 calls the upload "real bytes", and the creation flow's own tile offers a
 * "ZIP, artifact, or source archive" — but a staged bundle is fetched by three
 * different programs in three different runtimes, and every one of them opens
 * it the same way: `curl … | tar -xz` in the reusable workflow,
 * `wget -qO- … | tar -xz` in `adapters/build/buildkit.ts`, and `tar -xzf` in
 * the bosun build hull. A gzipped tar is therefore not a preference, it is the
 * wire format of a staged bundle, and `bundle.ts` beside this one reads a
 * `files` artifact back on the same assumption.
 *
 * Nothing enforced it. A ZIP was accepted, staged, signed for and dispatched,
 * and died in the builder at `tar: This does not look like a tar archive` —
 * surfacing four steps later as `ARTIFACT_UNAVAILABLE`, which names the
 * platform for what is a container-format mistake, and after a workflow run has
 * already been spent. So this module makes the invariant true at the one place
 * that sees the bytes: a ZIP is **transcoded** here, and anything that is
 * neither is **refused** here, with a sentence that says what arrived.
 *
 * **Why transcode rather than teach the fetchers.** Three programs would each
 * need a sniff and an unzip binary that two of their images do not carry, and
 * their silent divergence is what produced this defect in the first place. One
 * conversion at the boundary leaves all three unchanged and correct.
 *
 * **Why the digest is over the converted bytes.** §16 joins the source receipt
 * to the provenance document by a digest over exactly what was staged, and the
 * build hull re-checks it (`sha256sum` against `bundleDigest`, before it
 * extracts). A digest of the uploaded ZIP would name bytes no builder ever
 * holds. So conversion happens before staging, and the digest describes the
 * object in the depot — which is what every reader of it already assumes.
 *
 * The conversion is **deterministic**: entry order is the ZIP's own central
 * directory, and every field a tar header carries that is not in the ZIP is a
 * constant. The same upload therefore always yields the same digest, which is
 * what lets `uploadArchive`'s `onConflictDoNothing` mean "byte-identical input
 * lands on the Build row that already describes it".
 *
 * It is hand-written rather than a dependency for the reason `bundle.ts` gives
 * for its tar reader: §20's extraction contract wants a package that prunes to
 * something self-contained, and these are two fixed formats that have not moved
 * in thirty years.
 */
import { deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';

/** The containers an upload may arrive in. */
export type ArchiveFormat = 'gzip' | 'zip';

/** Why an upload could not be normalized. A closed set, so a caller can say which. */
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
 * What these bytes are, by their magic number rather than by their name.
 *
 * A filename is a caller's assertion and an upload may carry none at all — the
 * route defaults it to `upload.zip`, which is exactly the claim that must not
 * be trusted here.
 */
export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    return 'gzip';
  // Local file header, end of central directory (an empty archive), or a
  // spanned-archive marker. All three begin a file a ZIP reader will open.
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
  /** Named for what it now is, so the depot object is not called `.zip`. */
  readonly filename: string;
  readonly from: ArchiveFormat;
}

/**
 * The gzipped tar these bytes are, or the one they convert to.
 *
 * Throws {@link ArchiveFormatError} for anything else, which is the whole point
 * of the function: the refusal belongs here, in front of the depot, rather than
 * inside a runner log nobody is watching.
 *
 * `maxBytes` bounds what a ZIP declares it unpacks to; an untrusted upload is
 * refused as `TOO_LARGE` before any entry is inflated.
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
 * The same gzipped tar, wearing this module's own deterministic gzip framing.
 *
 * A repository host's tarball endpoint gives no promise about the *gzip* layer:
 * the compressor version, its settings, and the header's mtime/name fields are
 * the host's to change between any two fetches of the same commit. §16 digests
 * exactly what is staged, so an unstable wrapper mints a new depot object for
 * bytes whose tar content is identical — which is how the source bucket filled
 * with archives that are literally the same source. The tar inside *is* stable
 * per commit (`git archive` output), so stripping the wrapper and re-framing it
 * the way {@link gzip} frames a transcoded ZIP — no timestamp, no name, one
 * compressor at one setting — makes the digest a function of the commit again.
 *
 * The tar bytes themselves are untouched: symlinks, pax headers, and the
 * host's `owner-repo-sha/` prefix all pass through, so `tar -xz` extracts
 * exactly what the host archived and the §16 `sha256sum` check still describes
 * the staged object.
 */
export function canonicalGzip(bytes: Uint8Array): Uint8Array {
  return gzip(new Uint8Array(gunzipSync(bytes)));
}

/** The first bytes, for a refusal that says what it saw rather than only what it wanted. */
function describe(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'empty';
  const head = [...bytes.subarray(0, 4)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  return `with ${head}`;
}

// ---------------------------------------------------------------------------
// ZIP, read far enough to get the files out of it
// ---------------------------------------------------------------------------

interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly directory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The largest an end-of-central-directory record can be: 22 bytes + a 64 KiB comment. */
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
  // Zip64 spends these fields as sentinels and puts the real values in a record
  // this reader does not parse. Refused by name rather than half-read: a
  // truncated bundle that builds is worse than one that never staged.
  if (count === 0xffff || start === 0xffffffff) {
    throw new ArchiveFormatError(
      'UNSUPPORTED_ZIP',
      `${filename} is a Zip64 archive, which this boundary does not read — upload it as a gzipped tar instead.`,
    );
  }

  // Declared sizes first, so a bomb is refused before a byte of it inflates;
  // `inflateEntry` holds each entry to its declaration.
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

/**
 * Scan back for the end-of-central-directory record.
 *
 * Backwards, because the record sits at the end and a ZIP comment of arbitrary
 * length sits after it — there is no other way to find it, which is also why a
 * ZIP cannot be read from a pipe and why the fetchers were never going to open
 * one by accident.
 */
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
  // The local header's extra field may be a different length than the central
  // directory's copy, so the data offset is only knowable from the local one.
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
 * The unix mode a ZIP recorded, or a sane constant.
 *
 * The executable bit is the reason this is read at all: a source bundle whose
 * `build.sh` arrives without `+x` builds differently than the tree it came
 * from. The high byte of `version made by` is the host system, and 3 is unix.
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

/**
 * Refuse a path that would write outside the extracted root.
 *
 * The same rule and the same reason as `bundle.ts`'s: this is untrusted input
 * from whoever uploaded it, and every consumer of the tar we are about to write
 * extracts it with `tar -x`, which will happily follow `../` out of the
 * workspace. Rejecting here means no route has to remember to.
 */
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

// ---------------------------------------------------------------------------
// tar, written the one way every extractor reads
// ---------------------------------------------------------------------------

const BLOCK = 512;
const REGULAR = '0';
const DIRECTORY = '5';
const GNU_LONG_NAME = 'L';
/** Long enough that the 100-byte name field cannot hold it. */
const NAME_LIMIT = 100;

function tarGzOf(entries: readonly ZipEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const name = entry.directory ? `${entry.path}/` : entry.path;
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > NAME_LIMIT) {
      // GNU's long-name entry: a pseudo-file whose *contents* are the real
      // name. `bundle.ts` reads this form, and so does every tar in the wild;
      // the ustar prefix field cannot express a long name with no `/` in the
      // right place, which is why this is the form written.
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
  // Two zero blocks end an archive, and tar warns about a short one.
  blocks.push(new Uint8Array(BLOCK * 2));

  return gzip(concat(blocks));
}

/** gzip framing around raw deflate, with no timestamp and no filename. */
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

/** A name the 100-byte field can hold; the long-name entry before it carries the rest. */
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
  octal(0, 136, 12); // mtime — a constant, so the digest is a function of content
  write(typeFlag, 156, 1);
  write('ustar', 257, 6);
  write('00', 263, 2);

  // The checksum is computed with its own field read as spaces, then written
  // back into it. Every tar does this, and getting it wrong is the one mistake
  // that produces an archive `tar` calls corrupt rather than merely odd.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(sum, 148, 7);
  block[155] = 0x20;
  return block;
}

/** Entry data, rounded up to the block size tar counts in. */
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
