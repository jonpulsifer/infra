/**
 * The depot holds each release's tar.gz durably; the local sites volume is a
 * cache that refills from it. Objects are content-addressed, so identical
 * bundles share one object.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDeploymentFederation } from '@repo/archive/federation-credential';
import {
  deleteGcsObject,
  parseGcsLocation,
  readGcsObject,
  uploadToGcsBucket,
} from '@repo/archive/gcs';

/** Bounds the depot write inside an upload request. */
const PUT_TIMEOUT_MS = 60_000;

export interface Depot {
  /** Answers the location to store in the row. */
  put(objectName: string, bytes: Uint8Array): Promise<string>;
  /** `null` when the depot no longer holds the object. */
  get(location: string, maxBytes: number): Promise<Uint8Array | null>;
  /**
   * A location for {@link get}, for file rows, which store no location. Release
   * rows keep what {@link put} answered, which may name another bucket.
   */
  locate(objectName: string): string;
  /** An object that is already gone is not an error. */
  delete(objectName: string): Promise<void>;
}

/**
 * Uses the pod's workload identity. No signed URLs: a V4 signature would need
 * `iam.serviceAccounts.signBlob` as well as object access.
 */
export function bucketDepot(
  bucket: string,
  env: Record<string, string | undefined> = Bun.env,
): Depot {
  // Read per call: the kubelet rewrites the projected credential volume.
  const federationOf = async () => {
    const federation = await loadDeploymentFederation(env);
    if (federation === null) {
      throw new Error(
        'KTHX_BUCKET is set but this deployment mounts no cloud credential',
      );
    }
    return federation;
  };

  return {
    async put(objectName, bytes) {
      const { location } = await uploadToGcsBucket({
        bucketName: bucket,
        objectName,
        bytes,
        federation: await federationOf(),
        timeoutMs: PUT_TIMEOUT_MS,
      });
      return location;
    },
    async get(location, maxBytes) {
      const object = parseGcsLocation(location);
      if (object === null) return localBytes(location, maxBytes);
      const stream = await readGcsObject({
        bucketName: object.bucket,
        objectName: object.object,
        federation: await federationOf(),
        maxBytes,
      });
      return stream === null ? null : await drain(stream, maxBytes);
    },
    locate: (objectName) => `gs://${bucket}/${objectName}`,
    async delete(objectName) {
      await deleteGcsObject({
        bucketName: bucket,
        objectName,
        federation: await federationOf(),
      });
    },
  };
}

/** For local runs and tests; the chart requires `KTHX_BUCKET`. */
export function diskDepot(root: string): Depot {
  return {
    async put(objectName, bytes) {
      const path = join(root, objectName);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
      return `file://${path}`;
    },
    get: (location, maxBytes) => localBytes(location, maxBytes),
    locate: (objectName) => `file://${join(root, objectName)}`,
    delete: (objectName) =>
      rm(join(root, objectName), { force: true }).catch(() => {}),
  };
}

async function localBytes(
  location: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!location.startsWith('file://')) {
    throw new Error(`${location} is not a location this depot reads`);
  }
  const file = Bun.file(location.slice('file://'.length));
  if (!(await file.exists())) return null;
  if (file.size > maxBytes) {
    throw new Error(`${location} is larger than ${maxBytes} bytes`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** Cancels the stream as soon as it passes `maxBytes`. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`the object is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
