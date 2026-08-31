/**
 * A release on disk: what an upload may be, how it becomes a directory, and how
 * a directory that is gone comes back.
 *
 * v1 held a parsed bundle in memory and served files out of a 64 MiB cache,
 * which cost about seven times the unpacked size in resident memory on every
 * cold read. A release is unpacked to the volume once, at upload, and served
 * with `Bun.file` after that — so the read path costs a `stat` and a sendfile,
 * and the process holds an archive only while it is unpacking one.
 *
 * The directory is a cache of the depot object, never the record: the release
 * row names a `location`, and a directory that is missing is refilled from it.
 * That is what makes the volume disposable.
 */
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ArchiveFormatError,
  type NormalizedArchive,
  normalizeArchive,
} from '@repo/archive/archive-format';
import { BundleError, type BundleFile, readBundle } from '@repo/archive/bundle';
import type { Depot } from './depot.ts';
import type { Code } from './http.ts';

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

/**
 * What an archive may unpack to; the compressed size says nothing about it.
 *
 * A memory ceiling before it is a product one. The archive and its inflated tar
 * are both resident while a release is unpacked, and a rehydrate runs the same
 * code — so this, times {@link MAX_UNPACKS}, is what the pod has to hold.
 */
export const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 2000;

/**
 * How many archives may be unpacking at once, process-wide, uploads and
 * rehydrates together.
 *
 * The token bucket counts requests and says nothing about what one of them
 * costs. Two rather than one because the second is nearly free — it inflates
 * into pages the first already took from the kernel — and what buys the
 * headroom is {@link MAX_UNPACKED_BYTES}, not this number.
 */
export const MAX_UNPACKS = 2;

/** Release rows kept per site; older ones and their directories go. */
export const KEEP_RELEASES = 50;

/** Past this much of the volume, a directory nothing guarantees is evicted. */
const VOLUME_FULL = 0.8;

let unpacking = 0;

/** Whether every slot is held — a cheap probe that takes nothing. */
export function slotsFull(): boolean {
  return unpacking >= MAX_UNPACKS;
}

/** Take one of the process-wide unpack slots, or `null` when they are full. */
export function takeSlot(): (() => void) | null {
  if (unpacking >= MAX_UNPACKS) return null;
  unpacking += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unpacking -= 1;
  };
}

/** An upload this boundary will not take, in the contract's vocabulary. */
export class UploadRefused extends Error {
  constructor(
    readonly code: Code,
    readonly why: string,
  ) {
    super(why);
    this.name = 'UploadRefused';
  }
}

/** `readBundle`'s refusals, in the archive vocabulary the contract promises. */
const BUNDLE_CODES: Record<string, Code> = {
  NOT_GZIP: 'UNKNOWN_FORMAT',
  MALFORMED_TAR: 'MALFORMED_ZIP',
  PATH_ESCAPES_BUNDLE: 'PATH_ESCAPES_ARCHIVE',
  TOO_LARGE: 'TOO_LARGE',
};

export interface Release {
  readonly archive: NormalizedArchive;
  readonly files: readonly BundleFile[];
  /** Lowercase sha256 hex of the normalized bytes — the depot object's name. */
  readonly digest: string;
}

/**
 * What these uploaded bytes are, refused here or nowhere.
 *
 * The archive is normalized to the one container everything downstream opens,
 * read back once so a bundle with no entry page is refused *before* it is
 * stored, and digested over what will actually be in the depot.
 */
export function readRelease(filename: string, bytes: Uint8Array): Release {
  let archive: NormalizedArchive;
  try {
    archive = normalizeArchive(filename, bytes, MAX_UNPACKED_BYTES);
  } catch (cause) {
    if (cause instanceof ArchiveFormatError) {
      throw new UploadRefused(cause.code as Code, cause.message);
    }
    throw cause;
  }

  const files = readTree(archive.bytes);
  const entry = files.some(
    (file) => file.path === '/index.html' || file.path === '/200.html',
  );
  if (!entry) {
    throw new UploadRefused(
      'NO_INDEX',
      'no index.html or 200.html at the root',
    );
  }

  return {
    archive,
    files,
    digest: new Bun.CryptoHasher('sha256').update(archive.bytes).digest('hex'),
  };
}

/**
 * The one reader an upload and a rehydrate share: what a bundle unpacks to,
 * once every rule about it holds.
 *
 * Shared because a stored object is not automatically a trustworthy one — the
 * migration ticket carries in objects this boundary never wrote, and one of
 * those failing `mkdir` halfway through an unpack is a site that answers the
 * 503 page forever rather than an archive refused at the door.
 */
function readTree(bytes: Uint8Array): readonly BundleFile[] {
  const files = unwrap(readFiles(bytes));
  if (files.length > MAX_FILES) {
    throw new UploadRefused('TOO_LARGE', `${files.length} files`);
  }
  checkTree(files);
  return files;
}

function readFiles(bytes: Uint8Array): readonly BundleFile[] {
  try {
    return readBundle(bytes as Uint8Array<ArrayBuffer>, MAX_UNPACKED_BYTES);
  } catch (cause) {
    if (cause instanceof BundleError) {
      throw new UploadRefused(
        BUNDLE_CODES[cause.code] ?? 'MALFORMED_ZIP',
        cause.message,
      );
    }
    throw cause;
  }
}

/**
 * A lone top-level directory is the site, not a directory in it.
 *
 * A ZIP of a folder is the common case, and `notes/index.html` is not a site.
 */
function unwrap(files: readonly BundleFile[]): readonly BundleFile[] {
  if (files.length === 0) return files;
  const tops = new Set(files.map((file) => file.path.split('/')[1]));
  const wrapped =
    tops.size === 1 && files.every((file) => file.path.split('/').length > 2);
  if (!wrapped) return files;
  return files.map((file) => ({
    ...file,
    path: file.path.slice(file.path.indexOf('/', 1)),
  }));
}

/**
 * The two things a tar can describe that a directory tree cannot hold: a
 * control byte in a name, and one entry that is a file where another needs a
 * directory. `readBundle` has already dropped every entry that is not a regular
 * file and refused every path that leaves the root.
 */
function checkTree(files: readonly BundleFile[]): void {
  const paths = new Set(files.map((file) => file.path));
  for (const path of paths) {
    for (const character of path) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw new UploadRefused(
          'MALFORMED_ZIP',
          'a name carries a control byte',
        );
      }
    }
    let at = path.indexOf('/', 1);
    while (at !== -1) {
      if (paths.has(path.slice(0, at))) {
        throw new UploadRefused(
          'MALFORMED_ZIP',
          `${path.slice(0, at)} is both a file and a directory`,
        );
      }
      at = path.indexOf('/', at + 1);
    }
  }
}

// --- the directory ----------------------------------------------------------

export function siteDir(sitesDir: string, name: string): string {
  return join(sitesDir, name);
}

export function releaseDir(sitesDir: string, name: string, n: number): string {
  return join(sitesDir, name, String(n));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Write the tree under a temp name, hand the temp path to `place`, and clean up
 * whatever is left.
 *
 * The rename `place` performs is what makes a release atomic: a reader either
 * finds the whole directory or finds none of it, and a crash mid-unpack leaves
 * a `.tmp-` directory the next prune sweeps rather than a site serving three of
 * its five files.
 */
export async function writeTree<T>(
  sitesDir: string,
  name: string,
  files: readonly BundleFile[],
  place: (temp: string) => Promise<T>,
): Promise<T> {
  const temp = join(sitesDir, name, `.tmp-${crypto.randomUUID()}`);
  await mkdir(temp, { recursive: true, mode: 0o755 });
  try {
    for (const file of files) {
      const path = join(temp, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      // Fixed modes regardless of what the archive recorded: a static host
      // serves bytes, and an upload does not get to choose a mode bit.
      await writeFile(path, file.bytes, { mode: 0o644 });
    }
    return await place(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Move a finished temp tree to the release number the row just took. */
export async function placeTree(temp: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await rename(temp, target);
}

// --- rehydrate --------------------------------------------------------------

/** Misses on the same release coalesce onto one fetch. */
const filling = new Map<string, Promise<boolean>>();

/**
 * Make sure a release's directory is on disk, refilling it from the depot when
 * it is not.
 *
 * `false` when the slots are full or the depot could not answer — both are the
 * 503 page, because the release exists and its bytes are merely not here yet.
 */
export async function ensureRelease(
  sitesDir: string,
  name: string,
  n: number,
  location: string,
  depot: Depot,
): Promise<boolean> {
  const dir = releaseDir(sitesDir, name, n);
  if (await isDirectory(dir)) return true;

  const key = `${name}/${n}`;
  const inFlight = filling.get(key);
  if (inFlight !== undefined) return inFlight;

  const fill = (async () => {
    const release = takeSlot();
    if (release === null) return false;
    try {
      const bytes = await depot.get(location, MAX_ARCHIVE_BYTES);
      if (bytes === null) return false;
      const files = readTree(bytes);
      await writeTree(sitesDir, name, files, (temp) => placeTree(temp, dir));
      return true;
    } finally {
      release();
    }
  })().finally(() => filling.delete(key));

  filling.set(key, fill);
  return fill;
}

// --- eviction ---------------------------------------------------------------

/**
 * Drop the directories this site no longer needs.
 *
 * Two rules: a directory no release row names is always gone (the newest
 * {@link KEEP_RELEASES} rows are what a site keeps), and once the volume is
 * past {@link VOLUME_FULL} everything but the serving and previous releases
 * goes too — those two are what the contract guarantees on disk, and anything
 * else rehydrates.
 *
 * ponytail: this site only, run on its own uploads. A site that never uploads
 * again keeps its two guaranteed directories, so the volume is still bounded by
 * live sites × 2; what is missing is a sweep across *other* sites when one
 * site's own prune cannot free enough. Add that when the volume fills with
 * nobody uploading.
 */
export async function pruneSite(
  sitesDir: string,
  name: string,
  known: ReadonlySet<number>,
  guaranteed: ReadonlySet<number>,
  /** The volume reading, for a caller — a test — that has its own. */
  volumeIsFull?: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(siteDir(sitesDir, name));
  } catch {
    return;
  }
  const full = volumeIsFull ?? (await volumeFull(sitesDir));
  for (const entry of entries) {
    const path = join(sitesDir, name, entry);
    if (entry.startsWith('.tmp-')) {
      // Only a tree nobody is still writing: an upload in flight owns its temp
      // directory, and sweeping that one would break a concurrent release.
      if (await abandoned(path))
        await rm(path, { recursive: true, force: true });
      continue;
    }
    const n = Number(entry);
    if (!Number.isInteger(n)) continue;
    if (known.has(n) && (!full || guaranteed.has(n))) continue;
    await rm(path, { recursive: true, force: true });
  }
}

/** Longer than any unpack this process permits: the writer is gone. */
const ABANDONED_MS = 60 * 60 * 1000;

async function abandoned(path: string): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs < Date.now() - ABANDONED_MS;
  } catch {
    return false;
  }
}

async function volumeFull(sitesDir: string): Promise<boolean> {
  try {
    const stats = await statfs(sitesDir);
    const blocks = Number(stats.blocks);
    if (blocks === 0) return false;
    return (blocks - Number(stats.bavail)) / blocks > VOLUME_FULL;
  } catch {
    return false;
  }
}
