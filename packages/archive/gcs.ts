/**
 * Putting an archive in a bucket and getting it back, with no stored credential.
 *
 * Both calls take the federation they authenticate with rather than reaching
 * for an ambient one (§13: "native OIDC federation, nothing stored"), and both
 * go through the JSON API rather than a signed URL — a V4 signature needs
 * `iam.serviceAccounts.signBlob` on top of object access, which is a second IAM
 * grant to hold for bytes this process is already allowed to read.
 */
import {
  FederationError,
  type FederationOptions,
  workloadIdentityToken,
} from './federation.ts';

export interface UploadToGcsInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly bytes: Uint8Array;
  readonly federation: FederationOptions;
}

/**
 * How long an upload may stall before it is abandoned.
 *
 * `fetch` has no deadline of its own, so a connection that dies mid-PUT holds
 * everything its caller is holding for as long as the kernel keeps the socket.
 * That is not only a leaked request: a kthx release holds one of `MAX_UPLOADS`
 * slots and the unpacked site behind it across this call, so two stuck sockets
 * would refuse every release until the pod restarted. Long enough that a slow
 * link finishes a bundle, short enough that a wedged one clears itself.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

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
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
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
 * One object's bytes, as a stream, or `null` when the bucket does not hold it.
 *
 * A stream rather than a buffer because the caller is unpacking a release onto
 * a volume: holding a whole archive in memory to write it straight back out is
 * the read-path cost this exists to avoid.
 *
 * `404` is a value for the same reason it is in a caller's existence check — an
 * object the depot no longer holds is an ordinary answer to "is this release
 * still there". Every other refusal throws: a `403` reported as absence would
 * look like a cold cache and be answered by re-staging bytes that are already
 * in the bucket.
 */
export async function readGcsObject({
  bucketName,
  objectName,
  federation,
}: GcsObjectInput): Promise<ReadableStream<Uint8Array> | null> {
  const getToken = workloadIdentityToken(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  // The JSON API takes the object name as one fully-escaped path segment, so
  // the slash in `ephemeral/<hex>.tgz` is `%2F` rather than a path separator;
  // `alt=media` is what makes the response the bytes rather than the metadata.
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await send(
    new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    const errorText = await response.text();
    throw new FederationError(
      `Reading gs://${bucketName}/${objectName} failed (${response.status}): ${errorText}`,
    );
  }
  // A zero-length object answers with no body at all, which is a stream of
  // nothing rather than a caller's problem to distinguish.
  return response.body ?? new Blob([]).stream();
}
