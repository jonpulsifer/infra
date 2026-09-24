/**
 * Stages archive bytes, content-addressed, to the source depot bucket. With no
 * depot configured they go to local disk under an `upload://` handle, which no
 * builder can fetch.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FederationOptions } from '@repo/archive/federation';
import { uploadToGcsBucket } from '@repo/archive/gcs';
import { sharedServicesOf } from '../config/manifest.schema.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import type { BundleRetention } from '../domain/source-bundle.ts';

export interface StagedArchive {
  readonly digest: string;
  readonly location: string;
  /** Where the bytes were written on local disk, or `null` for a depot. */
  readonly filepath: string | null;
  readonly filename: string;
  readonly size: number;
}

export interface SourceDepot {
  readonly bucket: string;
  readonly federation: FederationOptions;
}

/** Bucket override for an operator running the process outside its chart. */
export const ARTIFACTS_BUCKET_VAR = 'SPINDRIFT_ARTIFACTS_BUCKET';

/**
 * `null` with no bucket or no federation. No per-request override: a caller may
 * not choose the bucket; `useSourceBucket` changes it.
 */
export function sourceDepotFor(
  manifest:
    | Pick<InstallationManifest, 'installation' | 'vessels' | 'cloud'>
    | null
    | undefined,
): SourceDepot | null {
  const bucket =
    process.env[ARTIFACTS_BUCKET_VAR]?.trim() ||
    (manifest == null ? undefined : sharedServicesOf(manifest).sourceBucket);
  const federation = manifest?.cloud?.federation ?? null;
  if (!bucket || federation === null) return null;
  return { bucket, federation };
}

/**
 * Dispatch exchanges `gs://` for a signed URL, and `http(s)://` is fetched as
 * is. Anything else, `upload://` above all, names one process's local disk.
 */
const FETCHABLE_SCHEMES: ReadonlySet<string> = new Set([
  'gs:',
  'https:',
  'http:',
]);

/** Build creation and dispatch share this, so they agree on what fetches. */
export function isFetchableBundleLocation(
  location: string | null | undefined,
): boolean {
  if (!location) return false;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(location)?.[0]?.toLowerCase();
  return scheme !== undefined && FETCHABLE_SCHEMES.has(scheme);
}

export function storageDir(): string {
  const custom = process.env.SPINDRIFT_STORAGE_DIR?.trim();
  if (custom) return custom;
  return join(tmpdir(), 'spindrift-archives');
}

export function digestOfBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

/** Content-addressed: the same bytes always write the same object. */
export function depotObjectName(filename: string, digest: string): string {
  const hex = digest.replace('sha256:', '');
  const ext = filename.includes('.') ? filename.split('.').pop() : 'zip';
  return `${hex}.${ext}`;
}

/**
 * The bucket's lifecycle rule expires objects under this prefix. Re-staging a
 * commit overwrites its object and resets the age, so a bundle in use survives.
 */
export const EPHEMERAL_PREFIX = 'ephemeral/';

/** The depot may expire it, so a later Build restages it, never inherits. */
export function isEphemeralBundleLocation(
  location: string | null | undefined,
): boolean {
  if (!location) return false;
  return /^gs:\/\/[^/]+\/ephemeral\//.test(location);
}

export async function stageArchiveBytes(
  filename: string,
  bytes: Uint8Array,
  depot?: SourceDepot | null,
  retention: BundleRetention = 'durable',
): Promise<StagedArchive> {
  const digest = digestOfBytes(bytes);
  const objectName = depotObjectName(filename, digest);

  if (depot !== undefined && depot !== null) {
    const stored = await uploadToGcsBucket({
      bucketName: depot.bucket,
      // Local disk skips the prefix: `readStagedArchive` scans one flat dir.
      objectName:
        (retention === 'ephemeral' ? EPHEMERAL_PREFIX : '') + objectName,
      bytes,
      federation: depot.federation,
    });
    return {
      digest,
      location: stored.location,
      filepath: null,
      filename,
      size: stored.size,
    };
  }

  const dir = storageDir();
  await mkdir(dir, { recursive: true });
  const filepath = join(dir, objectName);
  await writeFile(filepath, bytes);

  return {
    digest,
    location: `upload://${digest.replace('sha256:', '')}`,
    filepath,
    filename,
    size: bytes.byteLength,
  };
}

/** Local disk only; a depot bundle is never read back through this process. */
export async function readStagedArchive(
  digestOrHex: string,
): Promise<Uint8Array | null> {
  const hex = digestOrHex.replace('sha256:', '').replace('upload://', '');
  const dir = storageDir();
  try {
    const entries = await readdir(dir);
    const match = entries.find((entry) => entry.startsWith(hex));
    if (match) {
      return new Uint8Array(await readFile(join(dir, match)));
    }
    return null;
  } catch {
    return null;
  }
}
