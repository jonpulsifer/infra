/**
 * The HTTP client the store adapters share. The transport is injectable so a
 * test can put a fake API behind the real client.
 */

export type Fetcher = (request: Request) => Promise<Response>;

/** Called on every request, so an adapter never holds a stored credential. */
export type TokenProvider = () => string | Promise<string>;

export interface StoreEndpoint {
  /** Without a trailing slash. */
  readonly baseUrl: string;
  readonly token: TokenProvider;
  /** Defaults to the global `fetch`; a test injects a fake API here. */
  readonly fetch?: Fetcher;
}

/**
 * Any non-2xx answer except `404`. A `404` returns `null`, because `describe`
 * and `destroy` treat absence as an answer.
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

interface RequestOptions {
  method: string;
  /** Must begin with a slash; appended to the base URL. */
  path: string;
  /** Sent as JSON when present. */
  body?: unknown;
  headers?: Record<string, string>;
}

export class StoreHttp {
  constructor(private readonly endpoint: StoreEndpoint) {}

  /** The parsed JSON body, or `null` on a `404`. */
  async json<Result>(options: RequestOptions): Promise<Result | null> {
    const response = await this.send(options);
    if (response === null) return null;
    return (await response.json()) as Result;
  }

  /**
   * The unread response, or `null` on a `404`. Any other non-2xx throws
   * {@link StoreRequestError}.
   */
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
