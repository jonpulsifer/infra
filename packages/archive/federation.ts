/**
 * Reaching a cloud Target with no stored credential (§13).
 *
 * §13 settles one auth mode — "**native OIDC federation, nothing stored**" —
 * and this is it. The pod projects a token, the token is exchanged for a
 * federated one, and the federated one is optionally used to impersonate a
 * service account. Nothing is held: the projected token is re-read from disk on
 * every exchange because the kubelet rewrites it, and the access token that
 * comes back is cached only until shortly before it expires.
 *
 * **The projected token is not the cluster's own service account token.** That
 * one is minted for this cluster's API server, and a cloud API refuses it — so
 * the path here is a *separately* projected volume whose audience is the
 * workload-identity pool. Sending the default token would produce a `401` on
 * every cloud call, blamed on the Target, and it is exactly the mistake this
 * file exists to make impossible: `tokenPath` is required configuration with no
 * default that could be the wrong one.
 *
 * The shape mirrors an `external_account` credential document field for field —
 * audience, token url, credential source, impersonation url — because an
 * operator configuring this has one of those already and copying it should be
 * the whole of the work.
 */
/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** What every exchange asks for. Cloud APIs are gated on this one scope. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The token-exchange grant, as the standard names it. */
const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';

/**
 * How long before expiry a cached token is thrown away.
 *
 * A token that expires while a request is in flight fails a deploy for a reason
 * nobody can act on, so the cache gives up its last minute rather than spending
 * it. One extra exchange an hour is not a cost worth optimising.
 */
const EXPIRY_SKEW_MS = 60_000;

export interface FederationConfig {
  /**
   * The workload-identity pool provider this cluster's tokens are trusted by.
   *
   * Installation-specific, and therefore a manifest value (§20): it names one
   * installation's cloud, one pool, and one provider.
   */
  readonly audience: string;
  /** Where a projected token is exchanged for a federated one. */
  readonly tokenUrl: string;
  /**
   * Where the projected token is read from.
   *
   * A path with no default. The one that would be convenient — the default
   * service account token — is precisely the wrong one, so requiring the
   * operator to say which volume they projected is what keeps the mistake from
   * being the easy option.
   */
  readonly tokenPath: string;
  /**
   * The service account to impersonate, as a `generateAccessToken` url, or
   * `null` to use the federated token directly.
   *
   * Null is a supported configuration rather than an omission: direct resource
   * access grants the federated identity roles on its own, which is one fewer
   * identity to reason about where the cloud resources allow it.
   */
  readonly impersonationUrl: string | null;
}

export interface FederationOptions extends FederationConfig {
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  /** Injected so a test does not need a file at an absolute path. */
  readonly readToken?: (path: string) => Promise<string>;
  readonly now?: () => number;
}

/** Raised when federation cannot produce a token to call a cloud API with. */
export class FederationError extends Error {
  override readonly name = 'FederationError';
}

/** One cached access token and the moment it stops being usable. */
interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * A token provider that federates, caching what it mints.
 *
 * One provider serves every cloud Target because the exchange is per
 * *installation* rather than per Target: the pool trusts this cluster, and
 * which project a call lands in is decided by the call, not by the identity
 * making it.
 */
export function workloadIdentityToken(
  options: FederationOptions,
): TokenProvider {
  let cached: CachedToken | null = null;
  /** The exchange in flight, so a burst of calls makes one round trip. */
  let inflight: Promise<CachedToken> | null = null;

  const clock = () => options.now?.() ?? Date.now();

  return async (): Promise<string> => {
    const current = cached;
    if (current !== null && clock() < current.expiresAt - EXPIRY_SKEW_MS) {
      return current.value;
    }
    if (inflight === null) {
      inflight = exchange(options, clock).finally(() => {
        inflight = null;
      });
    }
    cached = await inflight;
    return cached.value;
  };
}

/** Projected token → federated token → (optionally) an impersonated one. */
async function exchange(
  options: FederationOptions,
  clock: () => number,
): Promise<CachedToken> {
  const subject = (await readProjectedToken(options)).trim();
  if (subject === '') {
    throw new FederationError(
      `the projected token at ${options.tokenPath} is empty: this process cannot reach a cloud Target`,
    );
  }

  const federated = await post<{
    access_token?: string;
    expires_in?: number;
  }>(options, options.tokenUrl, {
    audience: options.audience,
    grantType: GRANT,
    requestedTokenType: ACCESS_TOKEN,
    scope: SCOPE,
    subjectTokenType: JWT,
    subjectToken: subject,
  });
  const value = federated.access_token;
  if (value === undefined) {
    throw new FederationError('the token exchange returned no access token');
  }
  const expiresAt = clock() + (federated.expires_in ?? 3600) * 1_000;

  if (options.impersonationUrl === null) {
    return { value, expiresAt };
  }

  const impersonated = await post<{
    accessToken?: string;
    expireTime?: string;
  }>(options, options.impersonationUrl, { scope: [SCOPE] }, value);
  const token = impersonated.accessToken;
  if (token === undefined) {
    throw new FederationError('impersonation returned no access token');
  }
  const expiry =
    impersonated.expireTime === undefined
      ? expiresAt
      : Date.parse(impersonated.expireTime);
  return {
    value: token,
    // A far side that answered with an unparseable expiry gets the federated
    // token's, which is never longer — a cache that guessed long would serve a
    // dead token, and one that guessed short only costs an exchange.
    expiresAt: Number.isFinite(expiry) ? expiry : expiresAt,
  };
}

/** Read the projected token, freshly, because the kubelet rewrites the file. */
async function readProjectedToken(options: FederationOptions): Promise<string> {
  if (options.readToken !== undefined) {
    return options.readToken(options.tokenPath);
  }
  const file = Bun.file(options.tokenPath);
  if (!(await file.exists())) {
    throw new FederationError(
      `no projected token at ${options.tokenPath}: this process cannot reach a cloud Target. ` +
        'A pod needs a projected service account token volume whose audience is the workload-identity pool.',
    );
  }
  return file.text();
}

/** One JSON POST, with whatever the far side said on a refusal. */
async function post<Result>(
  options: FederationOptions,
  url: string,
  body: unknown,
  bearer?: string,
): Promise<Result> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;

  const send = options.fetch ?? ((request: Request) => fetch(request));
  const response = await send(
    new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
  if (!response.ok) {
    throw new FederationError(
      `${url} refused the exchange with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as Result;
}
