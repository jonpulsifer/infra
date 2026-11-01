/**
 * The sites bucket: a site is the folder `<name>/`, and it exists while its
 * marker `<name>/.kthx` does. The marker carries the owner's email and the last
 * deploy's time. A claim writes it only if absent; a deploy rewrites it only if
 * it is the generation the deploy read, so a racing deploy fails loudly. Shared
 * by the CLI, the server and the move script.
 */
import { crc32c } from '@repo/archive/crc32c';
import {
  deleteGcsPrefix,
  type GcsAuth,
  GcsError,
  type GcsObjectInfo,
  isPreconditionFailure,
  listGcsObjects,
  removeGcsObject,
  statGcsObject,
  writeGcsObject,
} from '@repo/archive/gcs';
import { contentType } from './mime.ts';

export const MARKER = '.kthx';
export const OWNER_KEY = 'kthx-owner';
export const DEPLOYED_KEY = 'kthx-deployed';

/** Every file `kthx deploy` and the builder write. nginx revalidates each read. */
export const FILE_CACHE_CONTROL = 'no-cache';

/** Uploads in flight during a deploy. */
const UPLOAD_WIDTH = 8;

export interface Bucket {
  readonly bucketName: string;
  readonly auth: GcsAuth;
}

export interface Marker {
  readonly name: string;
  /** Lower case; empty when the marker names nobody. */
  readonly owner: string;
  /** ISO-8601 UTC, or `null` when the marker carries none. */
  readonly deployed: string | null;
  /** When this generation of the marker was written. */
  readonly written: string | null;
  readonly generation: string;
}

export const markerName = (name: string): string => `${name}/${MARKER}`;

export function markerOf(name: string, object: GcsObjectInfo): Marker {
  return {
    name,
    owner: (object.metadata[OWNER_KEY] ?? '').trim().toLowerCase(),
    deployed: object.metadata[DEPLOYED_KEY] ?? null,
    written: object.timeCreated ?? object.updated,
    generation: object.generation,
  };
}

export async function readMarker(
  bucket: Bucket,
  name: string,
): Promise<Marker | null> {
  const object = await statGcsObject({
    bucketName: bucket.bucketName,
    objectName: markerName(name),
    auth: bucket.auth,
  });
  return object === null ? null : markerOf(name, object);
}

/** Every marker at the bucket's root, in name order. */
export async function listMarkers(bucket: Bucket): Promise<Marker[]> {
  const objects = await listGcsObjects({
    bucketName: bucket.bucketName,
    auth: bucket.auth,
    matchGlob: `*/${MARKER}`,
  });
  return objects.map((object) =>
    markerOf(object.name.slice(0, -MARKER.length - 1), object),
  );
}

/**
 * `ifGenerationMatch` of `0` is a claim. A lost race is
 * {@link isPreconditionFailure}.
 */
export async function writeMarker(
  bucket: Bucket,
  name: string,
  owner: string,
  ifGenerationMatch: string | number,
  deployed = new Date(),
): Promise<Marker> {
  const object = await writeGcsObject({
    bucketName: bucket.bucketName,
    objectName: markerName(name),
    auth: bucket.auth,
    bytes: new TextEncoder().encode('{}'),
    contentType: 'application/json',
    metadata: {
      [OWNER_KEY]: owner.trim().toLowerCase(),
      [DEPLOYED_KEY]: deployed.toISOString(),
    },
    ifGenerationMatch,
  });
  return markerOf(name, object);
}

/** `null` when someone else's marker got there first. */
export async function claimMarker(
  bucket: Bucket,
  name: string,
  owner: string,
): Promise<Marker | null> {
  try {
    return await writeMarker(bucket, name, owner, 0);
  } catch (cause) {
    if (isPreconditionFailure(cause)) return null;
    throw cause;
  }
}

export interface SiteFile {
  /** Relative, with no leading slash: `index.html`, `assets/app.js`. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface Synced {
  readonly uploaded: readonly string[];
  readonly unchanged: number;
  readonly deleted: readonly string[];
  readonly marker: Marker;
}

/** Another deploy rewrote the marker while this one ran. */
export class SiteRaced extends Error {
  override readonly name = 'SiteRaced';
}

const isHtml = (path: string): boolean => /\.html?$/i.test(path);

/**
 * Makes `<name>/` hold exactly `files`: uploads what differs by CRC-32C,
 * non-HTML first and HTML last so a new page never names an asset that is not
 * there yet, deletes what is no longer in `files`, and rewrites the marker last
 * against the generation read before the deploy began.
 */
export async function syncSite(
  bucket: Bucket,
  name: string,
  files: readonly SiteFile[],
  owner: string,
  generation: string,
  onUpload: (path: string) => void = () => {},
): Promise<Synced> {
  const prefix = `${name}/`;
  const remote = new Map<string, string | null>();
  for (const object of await listGcsObjects({
    bucketName: bucket.bucketName,
    auth: bucket.auth,
    prefix,
  })) {
    const path = object.name.slice(prefix.length);
    if (path !== MARKER) remote.set(path, object.crc32c);
  }

  const changed = files.filter(
    (file) => remote.get(file.path) !== crc32c(file.bytes),
  );
  const upload = async (batch: readonly SiteFile[]) => {
    for (let at = 0; at < batch.length; at += UPLOAD_WIDTH) {
      await Promise.all(
        batch.slice(at, at + UPLOAD_WIDTH).map(async (file) => {
          await writeGcsObject({
            bucketName: bucket.bucketName,
            objectName: `${prefix}${file.path}`,
            auth: bucket.auth,
            bytes: file.bytes,
            contentType: contentType(file.path),
            cacheControl: FILE_CACHE_CONTROL,
          });
          onUpload(file.path);
        }),
      );
    }
  };
  await upload(changed.filter((file) => !isHtml(file.path)));
  await upload(changed.filter((file) => isHtml(file.path)));

  // Checked again before anything is deleted: a racing deploy's new files
  // must not be deleted as this one's extras.
  const current = await readMarker(bucket, name);
  if (current?.generation !== generation) {
    throw new SiteRaced(
      `${name} was deployed by ${current?.owner || 'someone else'} while this deploy ran`,
    );
  }
  const wanted = new Set(files.map((file) => file.path));
  const extras = [...remote.keys()].filter((path) => !wanted.has(path));
  for (let at = 0; at < extras.length; at += UPLOAD_WIDTH) {
    await Promise.all(
      extras.slice(at, at + UPLOAD_WIDTH).map((path) =>
        removeGcsObject({
          bucketName: bucket.bucketName,
          objectName: `${prefix}${path}`,
          auth: bucket.auth,
        }),
      ),
    );
  }

  let marker: Marker;
  try {
    marker = await writeMarker(bucket, name, owner, generation);
  } catch (cause) {
    if (isPreconditionFailure(cause)) {
      throw new SiteRaced(
        `${name} was deployed by someone else while this deploy ran`,
      );
    }
    throw cause;
  }
  return {
    uploaded: changed.map((file) => file.path),
    unchanged: files.length - changed.length,
    deleted: extras,
    marker,
  };
}

/** Every object under `<name>/`, the marker last, so the site exists until the end. */
export function removeSite(bucket: Bucket, name: string): Promise<number> {
  return deleteGcsPrefix({
    bucketName: bucket.bucketName,
    auth: bucket.auth,
    prefix: `${name}/`,
    last: markerName(name),
  });
}

export { GcsError, isPreconditionFailure };
