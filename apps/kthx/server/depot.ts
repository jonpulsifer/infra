/**
 * The depot holds each site's `/api/files` bytes under `files/<site>/<path>`.
 * Rows in the control database say what exists; the depot only stores bytes.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDeploymentFederation } from '@repo/archive/federation-credential';
import {
  deleteGcsObject,
  readGcsObject,
  uploadToGcsBucket,
} from '@repo/archive/gcs';

/** Bounds the depot write inside an upload request. */
const PUT_TIMEOUT_MS = 60_000;

export interface Depot {
  put(objectName: string, bytes: Uint8Array): Promise<void>;
  /** `null` when the depot no longer holds the object. */
  open(
    objectName: string,
    maxBytes: number,
  ): Promise<ReadableStream<Uint8Array> | null>;
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
      await uploadToGcsBucket({
        bucketName: bucket,
        objectName,
        bytes,
        federation: await federationOf(),
        timeoutMs: PUT_TIMEOUT_MS,
      });
    },
    async open(objectName, maxBytes) {
      return readGcsObject({
        bucketName: bucket,
        objectName,
        federation: await federationOf(),
        maxBytes,
      });
    },
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
    },
    async open(objectName, maxBytes) {
      const file = Bun.file(join(root, objectName));
      if (!(await file.exists())) return null;
      if (file.size > maxBytes) {
        throw new Error(`${objectName} is larger than ${maxBytes} bytes`);
      }
      return file.stream();
    },
    delete: (objectName) =>
      rm(join(root, objectName), { force: true }).catch(() => {}),
  };
}
