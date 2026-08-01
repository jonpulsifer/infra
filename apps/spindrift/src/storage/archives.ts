/**
 * Durable archive staging storage.
 *
 * §4: "Archive upload accepts real bytes, stages them durably, and follows the
 * supplied-artifact or source-build path selected during creation."
 *
 * Compute SHA-256 digest over exact uploaded bytes (§16) and stage the bundle
 * to the installation's **source depot** — the GCS bucket the manifest names —
 * so that both builders §15 stages for can fetch it.
 *
 * **The pod's own disk is not a depot.** It used to be one, and it could not
 * work: a bundle written to `tmpdir()` is not shared with the reconciler, not
 * shared with a second replica, and gone on the next restart, so no builder
 * anywhere could fetch it under any scheme. The local directory survives here
 * only as the fallback for an installation with no depot configured — a
 * developer running the process on a laptop — and it announces itself as such
 * by keeping the `upload://` handle, which is deliberately not a URL. A
 * location that cannot be fetched should not be spelled like one that can.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FederationOptions } from '../adapters/deploy/cloud/federation.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import { uploadToGcsBucket } from './cloud.ts';

export interface StagedArchive {
  readonly digest: string;
  readonly location: string;
  /** Where the bytes landed on local disk, or `null` when they went to a depot. */
  readonly filepath: string | null;
  readonly filename: string;
  readonly size: number;
}

/**
 * The durable destination bundles are staged to.
 *
 * A bucket plus the federation that reaches it, because §13 allows no third
 * thing: there is no credential to carry alongside them.
 */
export interface SourceDepot {
  readonly bucket: string;
  readonly federation: FederationOptions;
}

/** Bucket override for an operator running the process outside its chart. */
export const ARTIFACTS_BUCKET_VAR = 'SPINDRIFT_ARTIFACTS_BUCKET';

/**
 * The depot this installation stages to, or `null` when it has none.
 *
 * `null` rather than a throw, the same way every adapter lookup answers: an
 * installation with no bucket or no federation is a configuration fact callers
 * report — as a refusal, or by falling back to local disk — rather than an
 * exception thrown from inside staging.
 */
export function sourceDepotFor(
  manifest: Pick<InstallationManifest, 'sources' | 'cloud'> | null | undefined,
  bucketOverride?: string | null,
): SourceDepot | null {
  const bucket =
    bucketOverride?.trim() ||
    process.env[ARTIFACTS_BUCKET_VAR]?.trim() ||
    manifest?.sources?.defaultBucket?.trim() ||
    manifest?.sources?.buckets?.[0]?.trim();
  const federation = manifest?.cloud?.federation ?? null;
  if (!bucket || federation === null) return null;
  return { bucket, federation };
}

/**
 * The schemes a bundle location may wear and still name something a builder
 * can end up holding.
 *
 * `gs://` is the depot's own address — unresolvable as written, but dispatch
 * exchanges it for a short-TTL signed URL, so a Build carrying one is a Build
 * that can be run. `https://` (and `http://`, for a depot an installation
 * fronts itself) is already what the reusable workflow's `curl` expects.
 *
 * Everything else — `upload://` above all — names bytes on one process's own
 * disk. That handle is deliberately not a URL, and the honest consequence of
 * that decision is this set: a location outside it is not a location a build
 * can be dispatched with, at any point, by any route.
 */
const FETCHABLE_SCHEMES: ReadonlySet<string> = new Set([
  'gs:',
  'https:',
  'http:',
]);

/**
 * Whether any builder could be handed this address and fetch what it names.
 *
 * The predicate both halves of the retirement read: a Build being created will
 * not inherit an address this rejects, and a Build being dispatched with one is
 * refused before a workflow is spent on it. One function so the two agree —
 * they disagreed once, and the disagreement was a `curl: (1) Protocol "upload"
 * not supported` inside a runner log nobody was watching.
 */
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

/** Compute SHA-256 digest in sha256:<hex> format over bytes. */
export function digestOfBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

/**
 * The object one bundle occupies, in the depot or on disk.
 *
 * Content-addressed, which is what makes the depot immutable in the sense §15
 * requires: the same bytes always name the same object, so staging them twice
 * writes the same object rather than replacing anything.
 */
export function depotObjectName(filename: string, digest: string): string {
  const hex = digest.replace('sha256:', '');
  const ext = filename.includes('.') ? filename.split('.').pop() : 'zip';
  return `${hex}.${ext}`;
}

/**
 * Stage archive bytes durably and return the digest and location.
 *
 * With a depot, the location is the `gs://` object address — durable, shared
 * between replicas, and the thing a signed URL is minted from at dispatch.
 * Without one, the bytes go to local disk under an `upload://` handle that no
 * builder can fetch, which is the honest answer for an installation that
 * configured no depot.
 */
export async function stageArchiveBytes(
  filename: string,
  bytes: Uint8Array,
  depot?: SourceDepot | null,
): Promise<StagedArchive> {
  const digest = digestOfBytes(bytes);
  const objectName = depotObjectName(filename, digest);

  if (depot !== undefined && depot !== null) {
    const stored = await uploadToGcsBucket({
      bucketName: depot.bucket,
      objectName,
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

/**
 * Read a locally staged archive by its sha256 digest or hex handle.
 *
 * Local only, and only meaningful for the no-depot fallback above: a depot
 * bundle is addressed by its `gs://` location and fetched by whoever holds a
 * signed URL for it, never read back through this process.
 */
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
