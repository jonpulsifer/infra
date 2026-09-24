/**
 * GCS bucket checks over Workload Identity Federation. Object calls live in
 * `@repo/archive/gcs`.
 */
import {
  FederationError,
  type FederationOptions,
  workloadIdentityToken,
} from '@repo/archive/federation';

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

/** Proves only a bucket read; the permissions it returns are assumed. */
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
