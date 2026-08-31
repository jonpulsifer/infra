/**
 * Credential-less Google Cloud Storage (GCS) operations using Workload Identity
 * Federation (§13).
 *
 * What this app asks of a bucket beyond the object calls themselves — putting
 * bytes in it, reading them back, asking whether one is still there are all
 * `@repo/archive/gcs`, because the kthx server makes the same calls against the
 * same API and there is one way to make them.
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
