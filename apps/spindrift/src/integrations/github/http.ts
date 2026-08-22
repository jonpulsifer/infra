/**
 * The transport every call to the repository host goes through (§15, § Seam 2).
 *
 * § Seam 2 names the pattern this repo already uses for a far side that speaks
 * HTTP: "a fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" (`apps/ddnsd/main_test.go`). That only
 * works if the client takes its transport, so {@link GitHubEndpoint} carries a
 * `fetch` and nothing in this integration calls the global.
 *
 * **Why this is not `adapters/store/http.ts`.** The two differ on the only
 * things a transport decides. A store's `404` is an answer — absence is a value
 * its contract has — whereas here a `404` is very often the *symptom of lost
 * access*, because a repository the App can no longer see is indistinguishable
 * from one that never existed. And this client has to fetch bytes, not only
 * JSON. Sharing a class across those two would mean one of the two callers
 * reading a status code the other one already interpreted.
 *
 * Hence {@link GitHubAccessError}: the one place where "the far side said no"
 * is turned into the closed vocabulary §15's freeze rule is written against.
 */

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/**
 * Mints an `Authorization` value per request.
 *
 * A provider rather than a string for the same reason the store adapters take
 * one: §15 stores no token, so every credential here is short-lived and minted
 * at the moment of use. A client holding a string would be holding a token.
 */
export type AuthorizationProvider = () => string | Promise<string>;

/** Where the repository host is, and how a request to it is authorized. */
export interface GitHubEndpoint {
  /** Base URL of the REST API, without a trailing slash. */
  readonly baseUrl: string;
  readonly authorization: AuthorizationProvider;
  /**
   * A cached installation token can be rejected without repository access
   * being lost — the mint is an hour-lived value and the far side may
   * invalidate it early. Answering `'retry'` drops whatever the provider
   * cached and re-sends the request exactly once with a fresh authorization;
   * a second `401` — and any `401` where this hook is absent — keeps the
   * ordinary `ACCESS_LOST` classification. Answering an `Error` throws it.
   */
  readonly onUnauthorized?: (
    authorization: string,
  ) => 'retry' | Error | Promise<'retry' | Error>;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * Why a call to the repository host did not succeed.
 *
 * Closed, and the closing is the point. §15 turns exactly one of these into a
 * state — `ACCESS_LOST` freezes the repository — so the classification has to
 * happen once, here, rather than at each call site guessing from a status code.
 *
 * - `ACCESS_LOST`: `401`, `403`, or `404`. **All three, deliberately.** A
 *   repository the installation was removed from answers `404` exactly as a
 *   repository that never existed does; there is no response that distinguishes
 *   them, and treating one as a fault and the other as a freeze would make the
 *   behaviour depend on a difference nobody can observe.
 * - `RATE_LIMITED`: `429`, or a `403` carrying the rate-limit marker. Split out
 *   because it is emphatically *not* lost access — freezing a repository
 *   because the hour's quota ran out would turn a delay into an operator
 *   incident.
 * - `UNAVAILABLE`: everything else. The far side is having a bad time; the next
 *   pass of the loop will ask again.
 */
export type GitHubAccessCode = 'ACCESS_LOST' | 'RATE_LIMITED' | 'UNAVAILABLE';

/** A far side that answered, but not with success. */
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

/** How many times a transient refusal is worth asking again. */
export const TRANSIENT_ATTEMPTS = 3;

/** Waits between them: a blip clears fast, a quota does not. */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [1_000, 4_000];

/**
 * Run one call again when the far side merely could not answer.
 *
 * This is the *policy* {@link GitHubHttp} deliberately does not have, kept
 * beside the classification it reads rather than inside the client that
 * produces it — a caller opts in, the transport still never retries itself.
 *
 * **Everything is retried except lost access**, which is the inversion that
 * matters. A `GitHubAccessError` of `ACCESS_LOST` is §15's freeze signal and
 * asking again cannot change it. Everything else — a `503`, a spent quota, and
 * above all a connection reset partway through a multi-megabyte archive, which
 * throws out of `fetch` before there is any status to classify — is the far
 * side having a bad moment, and the whole failure mode this exists for is a
 * deploy dying on one of those with no loop above it to try again.
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

/** The REST API version this client's response parsing was written against. */
const API_VERSION = '2022-11-28';

/** The header the host sets when a `403` is a quota refusal, not a permission one. */
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

/** One request's worth of options. */
interface RequestOptions {
  method: string;
  /** Appended to the endpoint's base URL; must begin with a slash. */
  path: string;
  /** Serialized as JSON when present. */
  body?: unknown;
  /** What the caller will read. Bytes skip content negotiation for JSON. */
  accept?: string;
  /**
   * Statuses the caller has a value for, returned instead of thrown.
   *
   * Only ever `404` (`setBranch` adds `422` for a ref that is not there yet),
   * and only from calls where absence is itself the answer, not a symptom:
   * whether a *file* exists (`readFile`, `jobLog`), and whether a pull request
   * a stored column still names is one worth merging (`pullRequestState`,
   * ticket 136). Everything else lets the classification above stand, so an
   * installation that lost access does not silently read as a repository with
   * no configuration in it.
   */
  tolerate?: readonly number[];
}

/**
 * The client this integration makes its calls through.
 *
 * Deliberately thin: it authorizes, negotiates content, and classifies a
 * refusal. Retries and backoff belong to the caller, which is the only thing
 * that knows whether it is worth waiting — {@link retryTransient} is the
 * policy for the callers that have no loop above them to wait in.
 */
export class GitHubHttp {
  constructor(private readonly endpoint: GitHubEndpoint) {}

  /** Send a request and parse a JSON response. `null` on a tolerated status. */
  async json<Result>(options: RequestOptions): Promise<Result | null> {
    const response = await this.send(options);
    if (response === null) return null;
    return (await response.json()) as Result;
  }

  /** Send a request and read the response body as bytes. */
  async bytes(options: RequestOptions): Promise<Uint8Array> {
    const response = await this.send(options);
    // Unreachable without `tolerate`, which no byte-returning call passes: the
    // archive download has no meaning for "absent" that is not lost access.
    if (response === null) {
      throw new TypeError('a tolerated status cannot return bytes');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Send one request. `null` when the status was tolerated by the caller. */
  async send(options: RequestOptions): Promise<Response | null> {
    const url = `${this.endpoint.baseUrl}${options.path}`;
    // At most two attempts, and only when `onUnauthorized` says the first
    // `401` was a stale mint rather than lost access. The second attempt's
    // `401` never consults the hook again, so the loop is bounded by shape.
    for (let attempt = 0; ; attempt += 1) {
      const authorization = await this.endpoint.authorization();
      const headers: Record<string, string> = {
        Accept: options.accept ?? 'application/vnd.github+json',
        Authorization: authorization,
        // Pinning the API version is what keeps a far-side default from
        // changing the shape of a response this client parses.
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
