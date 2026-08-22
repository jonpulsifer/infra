/**
 * Credential-less Google Cloud Storage (GCS) operations using Workload Identity Federation (§13).
 *
 * Uploads archive bundles to GCS buckets using federated tokens minted on the fly.
 * Tests bucket access permissions via WIF without static service account keys.
 */
import {
  FederationError,
  type FederationOptions,
  workloadIdentityToken,
} from '../adapters/deploy/cloud/federation.ts';

export interface TestBucketPermissionsInput {
  readonly bucketName: string;
  readonly federation: FederationOptions;
}

export interface TestBucketPermissionsResult {
  readonly bucketName: string;
  readonly accessible: boolean;
  readonly location: string;
  readonly permissions: readonly string[];
}

/** Test GCS bucket access using WIF token exchange (§13). */
export async function testGcsBucketPermissions({
  bucketName,
  federation,
}: TestBucketPermissionsInput): Promise<TestBucketPermissionsResult> {
  const getToken = workloadIdentityToken(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}`;
  const response = await send(
    new Request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }),
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new FederationError(
      `GCS bucket access to ${bucketName} refused with status ${response.status}: ${errorText}`,
    );
  }

  return {
    bucketName,
    accessible: true,
    location: `gs://${bucketName}`,
    permissions: ['storage.objects.create', 'storage.objects.get'],
  };
}

export interface UploadToGcsInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly bytes: Uint8Array;
  readonly federation: FederationOptions;
}

/** Upload an archive bundle directly to a GCS bucket using WIF token authentication. */
export async function uploadToGcsBucket({
  bucketName,
  objectName,
  bytes,
  federation,
}: UploadToGcsInput): Promise<{ location: string; size: number }> {
  const getToken = workloadIdentityToken(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await send(
    new Request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes as unknown as BodyInit,
    }),
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new FederationError(
      `Uploading archive to gs://${bucketName}/${objectName} failed (${response.status}): ${errorText}`,
    );
  }

  return {
    location: `gs://${bucketName}/${objectName}`,
    size: bytes.byteLength,
  };
}

export interface GcsObjectInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly federation: FederationOptions;
}

/**
 * Whether one object is still in the bucket, without reading its bytes.
 *
 * The whole reason `src/storage/bundle-cache.ts` can trust a hint: the index
 * says an object existed, this says whether it exists. A metadata read rather
 * than a download, and `fields=name` so the far side sends the smallest answer
 * it has — the point is to replace a multi-megabyte fetch with one round trip,
 * which it is not if the check itself is expensive.
 *
 * `404` is a value, because an expired `ephemeral/` bundle is the ordinary
 * case this exists to detect. Every other refusal throws: a bucket that
 * answers `403` is a misconfiguration, and reporting it as absence would spend
 * a full re-stage per deploy while looking like a cold cache.
 */
export async function gcsObjectExists({
  bucketName,
  objectName,
  federation,
}: GcsObjectInput): Promise<boolean> {
  const getToken = workloadIdentityToken(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  // The JSON API takes the object name as one fully-escaped path segment, so
  // the slash in `ephemeral/<hex>.tgz` is `%2F` rather than a path separator.
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?fields=name`;
  const response = await send(
    new Request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }),
  );

  if (response.status === 404) return false;
  if (!response.ok) {
    const errorText = await response.text();
    throw new FederationError(
      `Reading gs://${bucketName}/${objectName} failed (${response.status}): ${errorText}`,
    );
  }
  return true;
}
