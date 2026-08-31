/**
 * The depot: where a release's tar.gz is durable, and where a lost volume
 * refills from.
 *
 * The sites volume is a single-replica local-path PVC. Losing it must cost
 * latency and never data, which is the whole reason a release is uploaded here
 * before it is unpacked: the directory under `/sites` is a cache of this
 * object, and a release row names the object rather than the directory.
 *
 * Objects are content-addressed (`releases/<sha256>.tar.gz`), so re-uploading
 * the same bundle stores nothing new and two sites shipping identical bytes
 * share one object.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDeploymentFederation } from '@repo/archive/federation-credential';
import {
  parseGcsLocation,
  readGcsObject,
  uploadToGcsBucket,
} from '@repo/archive/gcs';

/** The contract's deadline on the depot write inside an upload. */
const PUT_TIMEOUT_MS = 60_000;

export interface Depot {
  /** Store these bytes at this object name; answers the location for the row. */
  put(objectName: string, bytes: Uint8Array): Promise<string>;
  /** The bytes at a stored location, or `null` when the depot no longer holds them. */
  get(location: string, maxBytes: number): Promise<Uint8Array | null>;
}

/**
 * The bucket, reached with the pod's workload identity — no stored credential
 * and no signed URL, because a V4 signature would want
 * `iam.serviceAccounts.signBlob` on top of object access the process already
 * has.
 */
export function bucketDepot(
  bucket: string,
  env: Record<string, string | undefined> = Bun.env,
): Depot {
  // Re-read per call rather than captured at boot: the credential is a
  // projected volume the kubelet owns and rewrites.
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
  };
}

/**
 * The same depot on this disk, for a run with no bucket: `bun run server` on a
 * laptop, and the test suite.
 *
 * Not a fallback the deployment can reach by accident — `KTHX_BUCKET` unset in
 * the cluster is a misconfiguration the chart does not permit — but the
 * rehydrate path has to be exercised by something, and a real second location
 * scheme exercises it better than a mock of the first.
 */
export function diskDepot(root: string): Depot {
  return {
    async put(objectName, bytes) {
      const path = join(root, objectName);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
      return `file://${path}`;
    },
    get: (location, maxBytes) => localBytes(location, maxBytes),
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

/** Hold a stream, refusing past the ceiling rather than after it. */
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
