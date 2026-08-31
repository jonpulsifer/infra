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

/**
 * The same deadline on the read side.
 *
 * A read holds an unpack slot exactly the way an upload holds one, so a
 * rehydrate whose socket dies mid-GET refuses every subsequent miss for as long
 * as the kernel keeps it. Shorter than the upload's because nothing here sends
 * a body.
 */
const READ_TIMEOUT_MS = 60 * 1000;

export interface UploadToGcsInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly bytes: Uint8Array;
  readonly federation: FederationOptions;
  /**
   * Overrides {@link UPLOAD_TIMEOUT_MS} for a caller whose own contract fixes
   * the deadline — a kthx release upload is 60 s, a Spindrift stage is minutes.
   */
  readonly timeoutMs?: number;
}

/** Upload an archive bundle directly to a GCS bucket using WIF token authentication. */
export async function uploadToGcsBucket({
  bucketName,
  objectName,
  bytes,
  federation,
  timeoutMs,
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
      signal: AbortSignal.timeout(timeoutMs ?? UPLOAD_TIMEOUT_MS),
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

/** A `gs://bucket/object` address, split into the two parts a call needs. */
export interface GcsObject {
  readonly bucket: string;
  readonly object: string;
}

/**
 * Parse a `gs://` address, or `null` for anything else.
 *
 * `null` rather than a throw because the caller's question is "is this an
 * object I should reach for?", and every other location scheme — a local
 * `upload://` handle, an already-fetchable `https://` URL — is a legitimate
 * answer of "no" rather than an error. It lives beside the calls it feeds
 * because a stored `gs://` address is how both hosts name a release, and a
 * second splitter is a second opinion about `gs://bucket-with-no-object`.
 */
export function parseGcsLocation(location: string): GcsObject | null {
  if (!location.startsWith('gs://')) return null;
  const rest = location.slice('gs://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const object = rest.slice(slash + 1);
  if (object === '') return null;
  return { bucket, object };
}

export interface GcsObjectInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly federation: FederationOptions;
  /** Overrides {@link READ_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Refuse an object whose declared size is over this, before a byte of it is
   * read. Only {@link readGcsObject} looks at it.
   */
  readonly maxBytes?: number;
}

/**
 * One authenticated, deadlined GET against the JSON API, with `404` left intact
 * for the caller to read as a value and every other refusal thrown.
 */
async function getObject(
  { bucketName, objectName, federation, timeoutMs }: GcsObjectInput,
  query: string,
): Promise<Response> {
  const getToken = workloadIdentityToken(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  // The JSON API takes the object name as one fully-escaped path segment, so
  // the slash in `ephemeral/<hex>.tgz` is `%2F` rather than a path separator.
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?${query}`;
  const response = await send(
    new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs ?? READ_TIMEOUT_MS),
    }),
  );

  if (response.status !== 404 && !response.ok) {
    const errorText = await response.text();
    throw new FederationError(
      `Reading gs://${bucketName}/${objectName} failed (${response.status}): ${errorText}`,
    );
  }
  return response;
}

/**
 * Whether one object is still in the bucket, without reading its bytes.
 *
 * The whole reason `apps/spindrift/src/storage/bundle-cache.ts` can trust a
 * hint: the index says an object existed, this says whether it exists. A
 * metadata read rather than a download, and `fields=name` so the far side sends
 * the smallest answer it has — the point is to replace a multi-megabyte fetch
 * with one round trip, which it is not if the check itself is expensive.
 *
 * `404` is a value, because an expired `ephemeral/` bundle is the ordinary case
 * this exists to detect. Every other refusal throws: a bucket that answers
 * `403` is a misconfiguration, and reporting it as absence would spend a full
 * re-stage per deploy while looking like a cold cache.
 */
export async function gcsObjectExists(input: GcsObjectInput): Promise<boolean> {
  const response = await getObject(input, 'fields=name');
  return response.status !== 404;
}

/**
 * One object's bytes, as a stream, or `null` when the bucket does not hold it.
 *
 * A stream rather than a buffer so the caller decides what holding it costs:
 * today's reader (`readBundle`) buffers under its own ceiling, and `maxBytes`
 * is what bounds that buffer before the first byte arrives rather than after
 * the whole object is already resident. An object that declares no length is
 * let through — the reader's own ceiling is the backstop.
 *
 * `404` is a value for the same reason it is in {@link gcsObjectExists}: an
 * object the depot no longer holds is an ordinary answer to "is this release
 * still there".
 */
export async function readGcsObject(
  input: GcsObjectInput,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await getObject(input, 'alt=media');
  if (response.status === 404) return null;

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (input.maxBytes !== undefined && declared > input.maxBytes) {
    await response.body?.cancel();
    throw new FederationError(
      `Object gs://${input.bucketName}/${input.objectName} declares ${declared} bytes, over the ${input.maxBytes} this reader accepts`,
    );
  }

  // A zero-length object answers with no body at all, which is a stream of
  // nothing rather than a caller's problem to distinguish.
  return response.body ?? new Blob([]).stream();
}
