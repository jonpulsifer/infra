/**
 * Cloud access tokens by workload identity federation, with no stored
 * credential: a projected token becomes a federated token, which may then
 * impersonate a service account.
 */

export type Fetcher = (request: Request) => Promise<Response>;

export type TokenProvider = () => string | Promise<string>;

/** Covers every Google Cloud API. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';

/** Drops a cached token a minute early so it does not expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export interface FederationConfig {
  /** The workload identity pool provider that trusts this cluster's tokens. */
  readonly audience: string;
  /** Where a projected token is exchanged for a federated one. */
  readonly tokenUrl: string;
  /**
   * The projected token whose audience is the pool. No default: the obvious
   * one, the default service account token, is refused by cloud APIs.
   */
  readonly tokenPath: string;
  /**
   * A `generateAccessToken` URL, or `null` to use the federated token directly
   * when the federated identity holds the roles itself.
   */
  readonly impersonationUrl: string | null;
}

export interface FederationOptions extends FederationConfig {
  readonly fetch?: Fetcher;
  readonly readToken?: (path: string) => Promise<string>;
  readonly now?: () => number;
}

export class FederationError extends Error {
  override readonly name = 'FederationError';
}

interface CachedToken {
  readonly value: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * One provider serves every cloud Target: the pool trusts the cluster, and each
 * call picks its own project.
 */
export function workloadIdentityToken(
  options: FederationOptions,
): TokenProvider {
  let cached: CachedToken | null = null;
  /** Shared so a burst of calls makes one exchange. */
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

/** Projected token, then federated token, then optionally impersonation. */
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
    // An unparseable expiry falls back to the federated one, which is never
    // later: a short guess costs an exchange, a long one serves a dead token.
    expiresAt: Number.isFinite(expiry) ? expiry : expiresAt,
  };
}

/** Read on every exchange because the kubelet rewrites the file. */
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
