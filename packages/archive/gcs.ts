/**
 * Bucket objects over the JSON API: upload, read, list, conditional writes,
 * metadata and deletes. No signed URLs: those need `iam.serviceAccounts.signBlob`.
 * `STORAGE_EMULATOR_HOST`, as Google's client libraries read it, points every
 * call at another endpoint.
 */
import {
  FederationError,
  type FederationOptions,
  type Fetcher,
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

/** Any bearer source: a federated credential, a user's ADC, a test's string. */
export interface GcsAuth {
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
  /** Overrides `STORAGE_EMULATOR_HOST` and the public endpoint. */
  readonly endpoint?: string;
}

export function federatedAuth(federation: FederationOptions): GcsAuth {
  return federation.fetch === undefined
    ? { token: tokenFor(federation) }
    : { token: tokenFor(federation), fetch: federation.fetch };
}

/** A refusal from the bucket, with its HTTP status. */
export class GcsError extends FederationError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A generation precondition did not hold: someone else wrote first. */
export const isPreconditionFailure = (cause: unknown): boolean =>
  cause instanceof GcsError && cause.status === 412;

function endpointOf(auth: GcsAuth): string {
  const raw =
    auth.endpoint?.trim() ||
    process.env.STORAGE_EMULATOR_HOST?.trim() ||
    'https://storage.googleapis.com';
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * `fetch` has no deadline, so a socket that dies mid-upload holds whatever its
 * caller holds, such as an unpack slot. Long enough for a slow link to finish.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Reads and deletes send no body, so they get a shorter deadline. */
const READ_TIMEOUT_MS = 60 * 1000;

/** The most objects one list page returns. */
const PAGE_SIZE = 1000;

/** Deletes in flight while a prefix is cleared. */
const DELETE_WIDTH = 16;

/** The JSON API takes an object name as one escaped path segment. */
const objectUrl = (auth: GcsAuth, bucket: string, object: string): string =>
  `${endpointOf(auth)}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;

async function send(
  auth: GcsAuth,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const token = await auth.token();
  const { timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const transport = auth.fetch ?? ((request: Request) => fetch(request));
  return transport(
    new Request(url, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? READ_TIMEOUT_MS),
    }),
  );
}

async function refusal(response: Response, what: string): Promise<GcsError> {
  return new GcsError(
    `${what} failed (${response.status}): ${await response.text()}`,
    response.status,
  );
}

export interface GcsObjectInfo {
  readonly name: string;
  /** A decimal string: generations overflow a JS number. */
  readonly generation: string;
  readonly size: number;
  /** Base64 big-endian CRC-32C. */
  readonly crc32c: string | null;
  readonly md5Hash: string | null;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly updated: string | null;
  readonly timeCreated: string | null;
}

const FIELDS =
  'name,generation,size,crc32c,md5Hash,contentType,metadata,updated,timeCreated';

function infoOf(raw: Record<string, unknown>): GcsObjectInfo {
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  const metadata: Record<string, string> = {};
  if (typeof raw.metadata === 'object' && raw.metadata !== null) {
    for (const [key, value] of Object.entries(raw.metadata)) {
      if (typeof value === 'string') metadata[key] = value;
    }
  }
  return {
    name: String(raw.name ?? ''),
    generation: String(raw.generation ?? '0'),
    size: Number(raw.size ?? 0),
    crc32c: text(raw.crc32c),
    md5Hash: text(raw.md5Hash),
    contentType: text(raw.contentType),
    metadata,
    updated: text(raw.updated),
    timeCreated: text(raw.timeCreated),
  };
}

export interface GcsListInput {
  readonly bucketName: string;
  readonly auth: GcsAuth;
  readonly prefix?: string;
  /** The JSON API's glob filter, such as `*` + `/.kthx`. */
  readonly matchGlob?: string;
  readonly timeoutMs?: number;
}

/** Every object, across pages, in the bucket's name order. */
export async function listGcsObjects({
  bucketName,
  auth,
  prefix,
  matchGlob,
  timeoutMs,
}: GcsListInput): Promise<GcsObjectInfo[]> {
  const found: GcsObjectInfo[] = [];
  let pageToken: string | null = null;
  do {
    const query = new URLSearchParams({
      maxResults: String(PAGE_SIZE),
      fields: `items(${FIELDS}),nextPageToken`,
    });
    if (prefix !== undefined) query.set('prefix', prefix);
    if (matchGlob !== undefined) query.set('matchGlob', matchGlob);
    if (pageToken !== null) query.set('pageToken', pageToken);
    const url = `${endpointOf(auth)}/storage/v1/b/${encodeURIComponent(bucketName)}/o?${query}`;
    const response = await send(auth, url, { method: 'GET', timeoutMs });
    if (!response.ok) {
      throw await refusal(
        response,
        `Listing gs://${bucketName}/${prefix ?? ''}`,
      );
    }
    const page = (await response.json()) as {
      items?: Record<string, unknown>[];
      nextPageToken?: string;
    };
    for (const item of page.items ?? []) found.push(infoOf(item));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken !== null);
  return found;
}

export interface GcsTarget {
  readonly bucketName: string;
  readonly objectName: string;
  readonly auth: GcsAuth;
  readonly timeoutMs?: number;
}

/** `null` when the bucket holds no such object; any other failure throws. */
export async function statGcsObject(
  target: GcsTarget,
): Promise<GcsObjectInfo | null> {
  const url = `${objectUrl(target.auth, target.bucketName, target.objectName)}?fields=${FIELDS}`;
  const response = await send(target.auth, url, {
    method: 'GET',
    timeoutMs: target.timeoutMs,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    throw await refusal(
      response,
      `Reading gs://${target.bucketName}/${target.objectName}`,
    );
  }
  return infoOf((await response.json()) as Record<string, unknown>);
}

export interface GcsWriteInput extends GcsTarget {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** `0` writes only when the object does not exist. */
  readonly ifGenerationMatch?: string | number;
}

/**
 * One multipart upload: the object's metadata and its bytes in one request, so
 * no reader sees the bytes without their type. A failed precondition is a
 * {@link GcsError} with status 412.
 */
export async function writeGcsObject(
  input: GcsWriteInput,
): Promise<GcsObjectInfo> {
  const query = new URLSearchParams({
    uploadType: 'multipart',
    fields: FIELDS,
  });
  if (input.ifGenerationMatch !== undefined) {
    query.set('ifGenerationMatch', String(input.ifGenerationMatch));
  }
  const resource: Record<string, unknown> = {
    name: input.objectName,
    contentType: input.contentType,
  };
  if (input.cacheControl !== undefined) {
    resource.cacheControl = input.cacheControl;
  }
  if (input.metadata !== undefined) resource.metadata = input.metadata;

  const boundary = `kthx-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(resource)}\r\n--${boundary}\r\nContent-Type: ${input.contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    head.byteLength + input.bytes.byteLength + tail.byteLength,
  );
  body.set(head, 0);
  body.set(input.bytes, head.byteLength);
  body.set(tail, head.byteLength + input.bytes.byteLength);

  const url = `${endpointOf(input.auth)}/upload/storage/v1/b/${encodeURIComponent(input.bucketName)}/o?${query}`;
  const response = await send(input.auth, url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    timeoutMs: input.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw await refusal(
      response,
      `Writing gs://${input.bucketName}/${input.objectName}`,
    );
  }
  return infoOf((await response.json()) as Record<string, unknown>);
}

export interface GcsMetadataInput extends GcsTarget {
  readonly metadata: Readonly<Record<string, string | null>>;
  readonly ifGenerationMatch?: string | number;
}

/** Merges custom metadata; `null` removes a key. The generation stays. */
export async function patchGcsMetadata(
  input: GcsMetadataInput,
): Promise<GcsObjectInfo> {
  const query = new URLSearchParams({ fields: FIELDS });
  if (input.ifGenerationMatch !== undefined) {
    query.set('ifGenerationMatch', String(input.ifGenerationMatch));
  }
  const response = await send(
    input.auth,
    `${objectUrl(input.auth, input.bucketName, input.objectName)}?${query}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: input.metadata }),
      timeoutMs: input.timeoutMs,
    },
  );
  if (!response.ok) {
    throw await refusal(
      response,
      `Updating gs://${input.bucketName}/${input.objectName}`,
    );
  }
  return infoOf((await response.json()) as Record<string, unknown>);
}

export interface GcsReadInput extends GcsTarget {
  /** Refuses an object whose declared length is larger. */
  readonly maxBytes?: number;
}

/**
 * `null` when the bucket does not hold it. An object that declares no length
 * passes `maxBytes`, so the caller must cap what it reads.
 */
export async function openGcsObject(
  input: GcsReadInput,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await send(
    input.auth,
    `${objectUrl(input.auth, input.bucketName, input.objectName)}?alt=media`,
    { method: 'GET', timeoutMs: input.timeoutMs },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    throw await refusal(
      response,
      `Reading gs://${input.bucketName}/${input.objectName}`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (input.maxBytes !== undefined && declared > input.maxBytes) {
    await response.body?.cancel();
    throw new GcsError(
      `Object gs://${input.bucketName}/${input.objectName} declares ${declared} bytes, over the ${input.maxBytes} this reader accepts`,
      413,
    );
  }
  // A zero-length object answers with no body.
  return response.body ?? new Blob([]).stream();
}

/** The whole object, cancelled as soon as it passes `maxBytes`. */
export async function readGcsBytes(
  input: GcsReadInput & { readonly maxBytes: number },
): Promise<Uint8Array | null> {
  const stream = await openGcsObject(input);
  if (stream === null) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      throw new GcsError(
        `Object gs://${input.bucketName}/${input.objectName} is larger than ${input.maxBytes} bytes`,
        413,
      );
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

/** A `404` counts as deleted; a failed precondition throws a 412. */
export async function removeGcsObject(
  input: GcsTarget & { readonly ifGenerationMatch?: string | number },
): Promise<void> {
  const query =
    input.ifGenerationMatch === undefined
      ? ''
      : `?ifGenerationMatch=${encodeURIComponent(String(input.ifGenerationMatch))}`;
  const response = await send(
    input.auth,
    `${objectUrl(input.auth, input.bucketName, input.objectName)}${query}`,
    { method: 'DELETE', timeoutMs: input.timeoutMs },
  );
  if (response.status !== 404 && !response.ok) {
    throw await refusal(
      response,
      `Deleting gs://${input.bucketName}/${input.objectName}`,
    );
  }
  await response.body?.cancel();
}

export interface GcsPrefixInput {
  readonly bucketName: string;
  readonly auth: GcsAuth;
  /** Ends in `/`, or it also matches every name that merely starts the same. */
  readonly prefix: string;
  /** Deleted after every other object, so a reader never sees it alone gone. */
  readonly last?: string;
}

/** Deletes every object under the prefix and answers how many. */
export async function deleteGcsPrefix({
  bucketName,
  auth,
  prefix,
  last,
}: GcsPrefixInput): Promise<number> {
  const names = (await listGcsObjects({ bucketName, auth, prefix })).map(
    (object) => object.name,
  );
  const first = names.filter((name) => name !== last);
  for (let at = 0; at < first.length; at += DELETE_WIDTH) {
    await Promise.all(
      first
        .slice(at, at + DELETE_WIDTH)
        .map((objectName) => removeGcsObject({ bucketName, objectName, auth })),
    );
  }
  if (last !== undefined && names.includes(last)) {
    await removeGcsObject({ bucketName, objectName: last, auth });
  }
  return names.length;
}

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
  const auth = federatedAuth(federation);
  const url = `${endpointOf(auth)}/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await send(auth, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
    timeoutMs: timeoutMs ?? UPLOAD_TIMEOUT_MS,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new GcsError(
      `Uploading archive to gs://${bucketName}/${objectName} failed (${response.status}): ${errorText}`,
      response.status,
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

const targetOf = (input: GcsObjectInput): GcsReadInput => ({
  bucketName: input.bucketName,
  objectName: input.objectName,
  auth: federatedAuth(input.federation),
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
});

/**
 * Only `404` means absent; any other failure throws, so a misconfigured bucket
 * does not pass for an empty one.
 */
export async function gcsObjectExists(input: GcsObjectInput): Promise<boolean> {
  const target = targetOf(input);
  const response = await send(
    target.auth,
    `${objectUrl(target.auth, input.bucketName, input.objectName)}?fields=name`,
    { method: 'GET', timeoutMs: input.timeoutMs },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw await refusal(
      response,
      `Reading gs://${input.bucketName}/${input.objectName}`,
    );
  }
  return true;
}

/** Federated {@link openGcsObject}. */
export function readGcsObject(
  input: GcsObjectInput,
): Promise<ReadableStream<Uint8Array> | null> {
  return openGcsObject(targetOf(input));
}

/** Federated {@link removeGcsObject}. */
export function deleteGcsObject(input: GcsObjectInput): Promise<void> {
  return removeGcsObject(targetOf(input));
}
