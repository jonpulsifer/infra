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
