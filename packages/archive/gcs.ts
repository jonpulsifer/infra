/**
 * Bucket object upload, read, existence check and delete over the JSON API with
 * a federated token. No signed URLs: those need `iam.serviceAccounts.signBlob`.
 */
import {
  FederationError,
  type FederationOptions,
  type TokenProvider,
  workloadIdentityToken,
} from './federation.ts';

/**
 * One provider per credential keeps its token cache across calls. Rotation
 * still works: the projected token is re-read on every exchange.
 */
const providers = new Map<string, TokenProvider>();

function tokenFor(federation: FederationOptions): TokenProvider {
  // An injected clock, reader or transport belongs to a test, not the process.
  if (
    federation.fetch !== undefined ||
    federation.now !== undefined ||
    federation.readToken !== undefined
  ) {
    return workloadIdentityToken(federation);
  }
  const key = [
    federation.tokenPath,
    federation.audience,
    federation.tokenUrl,
    federation.impersonationUrl ?? '',
  ].join('\u0000');
  const known = providers.get(key);
  if (known !== undefined) return known;
  const provider = workloadIdentityToken(federation);
  providers.set(key, provider);
  return provider;
}

/**
 * `fetch` has no deadline, so a socket that dies mid-upload holds whatever its
 * caller holds, such as an unpack slot. Long enough for a slow link to finish.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Reads and deletes send no body, so they get a shorter deadline. */
const READ_TIMEOUT_MS = 60 * 1000;

export interface UploadToGcsInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly bytes: Uint8Array;
  readonly federation: FederationOptions;
  /** Overrides {@link UPLOAD_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export async function uploadToGcsBucket({
  bucketName,
  objectName,
  bytes,
  federation,
  timeoutMs,
}: UploadToGcsInput): Promise<{ location: string; size: number }> {
  const getToken = tokenFor(federation);
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

export interface GcsObject {
  readonly bucket: string;
  readonly object: string;
}

/** `null`, not a throw, for any other scheme or an incomplete address. */
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
  /** Only {@link readGcsObject} checks it, against the declared length. */
  readonly maxBytes?: number;
}

/** Returns a `404` for the caller to read; any other failure throws. */
async function getObject(
  { bucketName, objectName, federation, timeoutMs }: GcsObjectInput,
  query: string,
): Promise<Response> {
  const getToken = tokenFor(federation);
  const token = await getToken();

  const send = federation.fetch ?? ((request: Request) => fetch(request));
  // The JSON API takes the object name as one escaped path segment, so a slash
  // in it is sent as `%2F`.
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
 * A metadata read trimmed by `fields=name`. Only `404` means absent; any other
 * failure throws, so a misconfigured bucket does not pass for an empty one.
 */
export async function gcsObjectExists(input: GcsObjectInput): Promise<boolean> {
  const response = await getObject(input, 'fields=name');
  return response.status !== 404;
}

/**
 * `null` when the bucket does not hold it. An object that declares no length
 * passes `maxBytes`, so the caller must cap what it reads.
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

  // A zero-length object answers with no body.
  return response.body ?? new Blob([]).stream();
}

/** A `404` counts as deleted. */
export async function deleteGcsObject({
  bucketName,
  objectName,
  federation,
  timeoutMs,
}: GcsObjectInput): Promise<void> {
  const token = await tokenFor(federation)();
  const send = federation.fetch ?? ((request: Request) => fetch(request));
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}`;
  const response = await send(
    new Request(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs ?? READ_TIMEOUT_MS),
    }),
  );
  if (response.status !== 404 && !response.ok) {
    throw new FederationError(
      `Deleting gs://${bucketName}/${objectName} failed (${response.status}): ${await response.text()}`,
    );
  }
}
