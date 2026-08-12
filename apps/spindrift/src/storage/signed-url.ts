/**
 * Handing a hosted runner a URL it can fetch, without giving it a credential.
 *
 * §15 stages one immutable bundle "for either builder", and the hosted route's
 * builder is a GitHub-hosted runner: a machine on the public internet with no
 * standing relationship to this installation's cloud project. It cannot read
 * `gs://` and it holds nothing that would let it authenticate to GCS. So the
 * durable object address has to be turned into something `curl` resolves, and
 * the reusable workflow — named by the manifest, not composed at dispatch —
 * already does exactly one thing with what it is handed:
 * `curl --fail --location "$LOCATION"`.
 *
 * A **V4 signed URL** is what fits that sentence. It is a bearer capability and
 * that is the accepted tradeoff, bounded two ways: the TTL is minutes, and the
 * URL is minted at dispatch rather than stored, so nothing durable holds one.
 *
 * **There is no private key here, and that is the whole point of §13.** V4
 * signing normally means a service-account key file; instead the string-to-sign
 * goes to IAM's `signBlob`, authorized by the *federated* token — the one from
 * before impersonation. Signing as the impersonated token would instead require
 * the service account to hold a token-creator role on *itself*, which is a
 * separate grant nothing else in this installation needs.
 *
 * **That costs a grant, and it is not the one impersonation needs.** `signBlob`
 * checks `iam.serviceAccounts.signBlob`, which lives in
 * `roles/iam.serviceAccountTokenCreator`. Impersonation checks
 * `iam.serviceAccounts.getAccessToken`, which `roles/iam.workloadIdentityUser`
 * also carries. So an installation whose federated principal holds only
 * `workloadIdentityUser` reaches every other cloud API and is refused here
 * alone — deploys work, and builds from a `gs://` bundle never dispatch. The
 * principal needs `roles/iam.serviceAccountTokenCreator` on the impersonated
 * service account; `terraform/gcp/projects/bluenose/iam.tf` is where this
 * installation grants it.
 */
import {
  FederationError,
  type FederationOptions,
  workloadIdentityToken,
} from '../adapters/deploy/cloud/federation.ts';

/** Where a signed URL points. GCS serves signed requests on this host. */
const STORAGE_HOST = 'storage.googleapis.com';

/** The only V4 algorithm GCS accepts, and the one `signBlob` produces. */
const ALGORITHM = 'GOOG4-RSA-SHA256';

/** V4's request scope. GCS takes `auto` for the region on a signed GET. */
const SCOPE_SUFFIX = 'auto/storage/goog4_request';

/**
 * How long a minted URL stays good.
 *
 * Fifteen minutes is ample for a runner to pull a source bundle and short
 * enough that a URL leaked through a workflow run's outputs is a capability
 * that has already expired by the time anyone reads it. Not a tuning knob.
 */
export const SIGNED_URL_TTL_SECONDS = 900;

/** A `gs://bucket/object` address, split into the two parts signing needs. */
export interface GcsObject {
  readonly bucket: string;
  readonly object: string;
}

/**
 * Parse a `gs://` address, or `null` for anything else.
 *
 * `null` rather than a throw because the caller's question is "is this an
 * object I should sign?", and every other location scheme — a local
 * `upload://` handle, an already-fetchable `https://` URL — is a legitimate
 * answer of "no" rather than an error.
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

export interface SignedUrlInput {
  /** The object to sign a GET for, as `gs://bucket/object`. */
  readonly location: string;
  readonly federation: FederationOptions;
  readonly ttlSeconds?: number;
  /** Injected so a test can sign at a fixed instant. */
  readonly now?: () => Date;
}

/**
 * The address a staged bundle is actually fetched from.
 *
 * A depot object is exchanged for a signed URL; anything else — an `https://`
 * bundle, a registry reference — is already whatever its own fetcher expects
 * and comes back untouched. Every `files` deploy backend reads the same depot
 * for the same reason, and one function is what stops three of them from
 * disagreeing about how a `gs://` address becomes bytes.
 *
 * Throws {@link FederationError}, including for an installation that
 * configured no federation at all: it is the same "this installation cannot
 * reach its cloud" as every other refusal here, and a caller that turns one
 * into its own verdict turns them all into it.
 *
 * **The caller must keep naming `location`, never what comes back.** A signed
 * URL is a bearer capability; the object address is the thing an operator can
 * be told about.
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

/**
 * Mint a short-TTL V4 signed URL for one GCS object.
 *
 * Throws {@link FederationError} — the same type every other federated call
 * raises — so a caller that already handles "this installation could not reach
 * its cloud" handles this too.
 */
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

  // Signed headers are `host` alone. Adding any other header would oblige the
  // runner to send it, and the runner is a `curl` invocation we do not control.
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
    // The body is not signed: GCS names this literal for a GET, and a runner
    // sends no body to hash anyway.
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
 * The service account a signature is made in the name of.
 *
 * Read off `impersonationUrl` because that is where the installation already
 * names it — §13 shapes the federation block after an `external_account`
 * document, and the impersonation URL is that document's service-account field.
 * A `null` impersonation URL means the installation reaches its cloud as the
 * federated identity directly, and a federated identity is not a service
 * account: it has no key GCS can verify a signature against, so there is
 * nothing to sign with and saying so is the only honest answer.
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
  // Deliberately not `federation` as given: the token wanted here is the
  // federated one, before impersonation. See this file's header.
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
 * Percent-encode one query key or value.
 *
 * `encodeURIComponent` leaves `!'()*` alone and V4 requires them encoded, so
 * they are finished by hand. Everything outside the unreserved set must be
 * escaped or the signature covers a different string than the URL carries.
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The same encoding, except `/` stays a separator because this is a path. */
function encodePath(value: string): string {
  return value.split('/').map(encodeComponent).join('/');
}

/** `YYYYMMDDTHHMMSSZ`, which is the only timestamp form V4 accepts. */
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
