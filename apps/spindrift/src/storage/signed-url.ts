/**
 * V4 signed URLs, so a hosted runner can `curl` a depot object with no
 * credential. Signing uses IAM `signBlob`, which needs the federated principal
 * to hold `roles/iam.serviceAccountTokenCreator` on the impersonated account.
 */
import {
  FederationError,
  type FederationOptions,
  workloadIdentityToken,
} from '@repo/archive/federation';
import { type GcsObject, parseGcsLocation } from '@repo/archive/gcs';

export { type GcsObject, parseGcsLocation };

const STORAGE_HOST = 'storage.googleapis.com';

/** RSA, because `signBlob` signs with the service account's RSA key. */
const ALGORITHM = 'GOOG4-RSA-SHA256';

/** GCS takes `auto` as the region. */
const SCOPE_SUFFIX = 'auto/storage/goog4_request';

/**
 * Ample for a runner to pull a bundle, and a URL leaked in run output has
 * expired by the time anyone reads it.
 */
export const SIGNED_URL_TTL_SECONDS = 900;

export interface SignedUrlInput {
  /** `gs://bucket/object`. */
  readonly location: string;
  readonly federation: FederationOptions;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

/**
 * Signs a `gs://` location and returns anything else as is. Show operators
 * `location`, never the result: a signed URL is a bearer capability.
 */
export async function fetchableBundleUrl(
  location: string,
  federation: FederationOptions | null | undefined,
  /** The adapter's own transport, so a test's fake far side signs too. */
  fetch?: FederationOptions['fetch'],
): Promise<string> {
  if (parseGcsLocation(location) === null) return location;
  if (federation === null || federation === undefined) {
    throw new FederationError(
      'no cloud federation is configured, so nothing can be signed to fetch it with',
    );
  }
  return signedObjectUrl({
    location,
    federation: fetch === undefined ? federation : { ...federation, fetch },
  });
}

/** Throws {@link FederationError}, like every other federated call. */
export async function signedObjectUrl({
  location,
  federation,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
  now = () => new Date(),
}: SignedUrlInput): Promise<string> {
  const target = parseGcsLocation(location);
  if (target === null) {
    throw new FederationError(
      `${location} is not a gs:// object address, so no signed URL can be minted for it`,
    );
  }

  const signer = signingServiceAccount(federation);
  const at = now();
  const timestamp = basicIso(at);
  const datestamp = timestamp.slice(0, 8);
  const scope = `${datestamp}/${SCOPE_SUFFIX}`;

  // Only `host` is signed: the runner's `curl` would have to send any other.
  const query = canonicalQuery({
    'X-Goog-Algorithm': ALGORITHM,
    'X-Goog-Credential': `${signer}/${scope}`,
    'X-Goog-Date': timestamp,
    'X-Goog-Expires': String(ttlSeconds),
    'X-Goog-SignedHeaders': 'host',
  });

  const path = `/${encodePath(target.bucket)}/${encodePath(target.object)}`;
  const canonicalRequest = [
    'GET',
    path,
    query,
    `host:${STORAGE_HOST}`,
    '',
    'host',
    // GCS's literal for a payload left out of the signature.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    timestamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = await signBlob(federation, signer, stringToSign);
  return `https://${STORAGE_HOST}${path}?${query}&X-Goog-Signature=${signature}`;
}

/**
 * The account named in `impersonationUrl`. Without one there is no service
 * account whose key GCS could verify a signature against.
 */
function signingServiceAccount(federation: FederationOptions): string {
  const url = federation.impersonationUrl;
  if (url === null) {
    throw new FederationError(
      'this installation federates without impersonating a service account, ' +
        'so it has no identity to sign a storage URL as. A hosted build route ' +
        'needs `cloud.federation.impersonationUrl` set to the controller service account.',
    );
  }
  const match = /\/serviceAccounts\/([^/:]+):/.exec(url);
  if (match === null) {
    throw new FederationError(
      `could not read a service account out of the impersonation URL ${url}`,
    );
  }
  return decodeURIComponent(match[1]!);
}

/** `POST …:signBlob`, returning the signature hex-encoded as V4 wants it. */
async function signBlob(
  federation: FederationOptions,
  serviceAccount: string,
  payload: string,
): Promise<string> {
  // The federated token: signing as the impersonated account would need a
  // token-creator grant on itself.
  const getToken = workloadIdentityToken({
    ...federation,
    impersonationUrl: null,
  });
  const token = await getToken();

  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signBlob`;
  const send = federation.fetch ?? ((request: Request) => fetch(request));
  const response = await send(
    new Request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: base64(new TextEncoder().encode(payload)),
      }),
    }),
  );
  if (!response.ok) {
    throw new FederationError(
      `signing a storage URL as ${serviceAccount} was refused with ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { signedBlob?: string };
  if (typeof body.signedBlob !== 'string') {
    throw new FederationError(
      `signing a storage URL as ${serviceAccount} returned no signature`,
    );
  }
  return hex(bytesOfBase64(body.signedBlob));
}

/** V4's canonical query: percent-encoded pairs, sorted by encoded key. */
function canonicalQuery(params: Record<string, string>): string {
  const encoded = new Map(
    Object.entries(params).map(
      ([key, value]) => [encodeComponent(key), encodeComponent(value)] as const,
    ),
  );
  return [...encoded.keys()]
    .sort()
    .map((key) => `${key}=${encoded.get(key)}`)
    .join('&');
}

/**
 * `encodeURIComponent` leaves `!'()*` alone; V4 needs them escaped, or the
 * signature covers a different string than the URL carries.
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** As {@link encodeComponent}, but `/` stays a path separator. */
function encodePath(value: string): string {
  return value.split('/').map(encodeComponent).join('/');
}

/** `YYYYMMDDTHHMMSSZ`, the only timestamp form V4 accepts. */
function basicIso(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function bytesOfBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
