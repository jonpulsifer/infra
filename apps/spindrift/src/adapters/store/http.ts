/**
 * What the two store implementations share: an HTTP seam that a test can put a
 * fake far side behind.
 *
 * § Seam 2 names the pattern this repo already uses — "a fake of the far-side
 * HTTP API behind the real client, with the test asserting the requests that
 * were made" (`apps/ddnsd/main_test.go`). That only works if the client takes
 * its transport rather than reaching for a global, so {@link StoreEndpoint}
 * carries a `fetch` and both adapters go through {@link StoreHttp} instead of
 * calling `fetch` directly. Nothing else about the two backends is shared, and
 * nothing here knows what either of them stores.
 *
 * The token is a provider, not a string. §13 settles one auth mode — "native
 * OIDC federation, nothing stored" — so a credential here is minted per request
 * by whatever federates, and an adapter that accepted a string would be holding
 * one.
 */

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** Where a store is reached and how a request to it is authorized. */
export interface StoreEndpoint {
  /** Base URL of the API, without a trailing slash. */
  readonly baseUrl: string;
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * A far side that answered, but not with success.
 *
 * A `404` is not one of these: absence is an answer both stores' contracts have
 * a value for (`describe` returns `null`, `destroy` succeeds), so it is returned
 * rather than raised. Everything else throws, because §10's verbs have no way to
 * say "the vault refused" — a store that cannot be written to is a fault, not a
 * result.
 */
export class StoreRequestError extends Error {
  override readonly name = 'StoreRequestError';

  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} failed with ${status}: ${body}`);
  }
}

/** One request's worth of options. */
interface RequestOptions {
  method: string;
  /** Appended to the endpoint's base URL; must begin with a slash. */
  path: string;
  /** Serialized as JSON when present. */
  body?: unknown;
  /** Extra headers, on top of the bearer token and content negotiation. */
  headers?: Record<string, string>;
}

/**
 * The client both adapters make their calls through.
 *
 * Deliberately thin: it authorizes, serializes, and turns a `404` into `null`.
 * Retries, backoff, and pagination belong to whichever API needs them, because
 * neither of these two agrees with the other about any of the three.
 */
export class StoreHttp {
  constructor(private readonly endpoint: StoreEndpoint) {}

  /** Send a request and parse a JSON response, or `null` on a `404`. */
  async json<Result>(options: RequestOptions): Promise<Result | null> {
    const response = await this.send(options);
    if (response === null) return null;
    return (await response.json()) as Result;
  }

  /** Send a request whose response body is not read. `null` on a `404`. */
  async send(options: RequestOptions): Promise<Response | null> {
    const url = `${this.endpoint.baseUrl}${options.path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.endpoint.token()}`,
      ...options.headers,
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

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StoreRequestError(
        options.method,
        url,
        response.status,
        await response.text(),
      );
    }
    return response;
  }
}
