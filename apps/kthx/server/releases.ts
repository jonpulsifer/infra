/**
 * A release on disk: upload checks, unpacking and rehydration. A directory only
 * caches the depot object its row's `location` names, so the volume is
 * disposable.
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
 * A memory ceiling: the archive and its inflated tar are both resident while
 * unpacking, so this times {@link MAX_UNPACKS} is what the pod must hold.
 */
export const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 2000;

/**
 * Process-wide, uploads and rehydrates together: a token bucket counts
 * requests, not what each one costs. Two: a second unpack reuses pages the
 * first took; {@link MAX_UNPACKED_BYTES} buys the headroom.
 */
export const MAX_UNPACKS = 2;

/** Release rows kept per site besides the serving one. */
export const KEEP_RELEASES = 50;

/** Past this fraction of the volume, unguaranteed directories are evicted. */
const VOLUME_FULL = 0.8;

let unpacking = 0;

export function slotsFull(): boolean {
  return unpacking >= MAX_UNPACKS;
}

/** Returns the slot's release, or `null` when every slot is held. */
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

export class UploadRefused extends Error {
  constructor(
    readonly code: Code,
    readonly why: string,
  ) {
    super(why);
    this.name = 'UploadRefused';
  }
}

/** `readBundle` codes as the API's public archive error codes. */
const BUNDLE_CODES: Record<string, Code> = {
  NOT_GZIP: 'UNKNOWN_FORMAT',
  MALFORMED_TAR: 'MALFORMED_ZIP',
  PATH_ESCAPES_BUNDLE: 'PATH_ESCAPES_ARCHIVE',
  TOO_LARGE: 'TOO_LARGE',
};

export interface Release {
  readonly archive: NormalizedArchive;
  readonly files: readonly BundleFile[];
  /** sha256 hex of the normalized bytes; it names the depot object. */
  readonly digest: string;
}

/**
 * Normalizes the archive, refuses one without an entry page before it is
 * stored, and digests the bytes the depot will hold.
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
 * Shared with rehydrate: a depot object may not have passed these checks, and
 * one failing halfway through an unpack serves the 503 page forever.
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

/** A lone top-level directory is the site: zipping a folder is common. */
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
 * What a tar can describe and a directory cannot hold. `readBundle` has already
 * dropped non-regular entries and refused paths that leave the root.
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
 * The rename in `place` makes a release atomic. A crash leaves a `.tmp-`
 * directory for {@link pruneSite} to sweep.
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
      // Fixed modes: an upload does not choose its mode bits.
      await writeFile(path, file.bytes, { mode: 0o644 });
    }
    return await place(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function placeTree(temp: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await rename(temp, target);
}

/** Misses on the same release coalesce onto one fetch. */
const filling = new Map<string, Promise<boolean>>();

/**
 * Refills a missing release directory from the depot. `false` when the slots
 * are full or the depot has nothing: the caller answers 503.
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

/**
 * Removes directories no release row names and, past {@link VOLUME_FULL}, all
 * but the guaranteed ones; anything evicted rehydrates.
 *
 * ponytail: this site only, on its own uploads. Add a sweep across other sites
 * if the volume fills while nobody uploads.
 */
export async function pruneSite(
  sitesDir: string,
  name: string,
  known: ReadonlySet<number>,
  guaranteed: ReadonlySet<number>,
  /** Overrides the volume reading, for tests. */
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
      // An upload in flight still owns its temp directory.
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

/** Far longer than any unpack, so the writer is gone. */
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
