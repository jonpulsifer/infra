/** The transport every GitHub call goes through, and its refusal codes. */

export type Fetcher = (request: Request) => Promise<Response>;

/** Called per request, so no client holds a token between calls. */
export type AuthorizationProvider = () => string | Promise<string>;

export interface GitHubEndpoint {
  /** No trailing slash. */
  readonly baseUrl: string;
  readonly authorization: AuthorizationProvider;
  /**
   * GitHub can revoke a cached token early. Answering retry re-sends once with
   * a fresh authorization; a second `401` is `ACCESS_LOST`. An `Error` is thrown.
   */
  readonly onUnauthorized?: (
    authorization: string,
  ) => 'retry' | Error | Promise<'retry' | Error>;
  readonly fetch?: Fetcher;
}

/**
 * `ACCESS_LOST` freezes the repository. It includes `404`, because a repository
 * the App lost answers `404` just as one that never existed does.
 */
export type GitHubAccessCode = 'ACCESS_LOST' | 'RATE_LIMITED' | 'UNAVAILABLE';

export class GitHubAccessError extends Error {
  override readonly name = 'GitHubAccessError';

  constructor(
    readonly code: GitHubAccessCode,
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} failed with ${status}: ${body}`);
  }
}

export const TRANSIENT_ATTEMPTS = 3;

/** Longer each time, since a spent quota takes longer to clear than a blip. */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [1_000, 4_000];

/**
 * Retries anything but `ACCESS_LOST`, including a connection reset partway
 * through a download, which throws before there is a status to classify.
 */
export async function retryTransient<Result>(
  attempt: () => Promise<Result>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<Result> {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (cause) {
      const fatal =
        cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST';
      const wait = TRANSIENT_BACKOFF_MS[index];
      if (fatal || index >= TRANSIENT_ATTEMPTS - 1 || wait === undefined) {
        throw cause;
      }
      await sleep(wait);
    }
  }
}

/** Pinned so a GitHub default cannot change a response this client parses. */
const API_VERSION = '2022-11-28';

/** A `403` with this header at `0` is a spent quota. */
const RATE_LIMIT_REMAINING = 'X-RateLimit-Remaining';

function classify(response: Response): GitHubAccessCode {
  if (response.status === 429) return 'RATE_LIMITED';
  if (response.status === 403) {
    return response.headers.get(RATE_LIMIT_REMAINING) === '0'
      ? 'RATE_LIMITED'
      : 'ACCESS_LOST';
  }
  if (response.status === 401 || response.status === 404) return 'ACCESS_LOST';
  return 'UNAVAILABLE';
}

interface RequestOptions {
  method: string;
  /** Starts with a slash. */
  path: string;
  body?: unknown;
  accept?: string;
  /**
   * Statuses answered with `null` instead of thrown. Only for calls where the
   * status is an answer, so lost access never reads as an empty repository.
   */
  tolerate?: readonly number[];
}

/**
 * Authorizes, negotiates content and classifies a refusal. Retrying a
 * transient failure is up to the caller, through {@link retryTransient}.
 */
export class GitHubHttp {
  constructor(private readonly endpoint: GitHubEndpoint) {}

  /** `null` on a tolerated status. */
  async json<Result>(options: RequestOptions): Promise<Result | null> {
    const response = await this.send(options);
    if (response === null) return null;
    return (await response.json()) as Result;
  }

  async bytes(options: RequestOptions): Promise<Uint8Array> {
    const response = await this.send(options);
    if (response === null) {
      throw new TypeError('a tolerated status cannot return bytes');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** `null` on a tolerated status. */
  async send(options: RequestOptions): Promise<Response | null> {
    const url = `${this.endpoint.baseUrl}${options.path}`;
    // At most two attempts: only the first `401` consults `onUnauthorized`.
    for (let attempt = 0; ; attempt += 1) {
      const authorization = await this.endpoint.authorization();
      const headers: Record<string, string> = {
        Accept: options.accept ?? 'application/vnd.github+json',
        Authorization: authorization,
        'X-GitHub-Api-Version': API_VERSION,
      };
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const request = new Request(url, {
        method: options.method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const send = this.endpoint.fetch ?? ((input: Request) => fetch(input));
      const response = await send(request);

      if (response.ok) return response;
      if (options.tolerate?.includes(response.status)) return null;
      if (
        response.status === 401 &&
        this.endpoint.onUnauthorized !== undefined &&
        attempt === 0
      ) {
        const outcome = await this.endpoint.onUnauthorized(authorization);
        if (outcome === 'retry') continue;
        throw outcome;
      }
      throw new GitHubAccessError(
        classify(response),
        options.method,
        url,
        response.status,
        await response.text(),
      );
    }
  }
}
