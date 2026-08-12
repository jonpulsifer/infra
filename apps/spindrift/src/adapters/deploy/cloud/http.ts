/**
 * What the two cloud deploy adapters share: an HTTP seam a test can put a fake
 * far side behind.
 *
 * § Seam 2 names the pattern — "a fake of the far-side HTTP API behind the real
 * client, with the test asserting the requests that were made" — and that only
 * works if the client takes its transport rather than reaching for a global. So
 * both adapters go through {@link CloudHttp} instead of calling `fetch`.
 *
 * It is deliberately not the store's `StoreHttp`, and the difference is the
 * whole reason this file exists: a store turns a `404` into `null` and raises
 * everything else, because absence is a value its contract has. A deploy adapter
 * cannot do that. §6 requires it to distinguish "this project refuses me" from
 * "this project is not there" from "the service is off", and all three arrive as
 * status codes with a body — so this client **returns the failure** rather than
 * throwing it, and the adapter decides which of §6's reasons it is.
 *
 * The token is a provider, not a string. §13 settles one auth mode — "native
 * OIDC federation, nothing stored" — so a credential here is minted per request
 * by whatever federates, and a client that accepted a string would be holding
 * one.
 */

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** Where one cloud API is reached and how a request to it is authorized. */
export interface CloudEndpoint {
  /** Base URL of the API, without a trailing slash. */
  readonly baseUrl: string;
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * What the far side said, as an answer rather than as an exception.
 *
 * `ok` carries the parsed body; every other arm carries enough for the adapter
 * to pick a §6 reason. `transport` is the case with no status at all — DNS
 * failed, the socket died, the uplink is down — which is unambiguously
 * `TARGET_UNREACHABLE` and is the one arm a status-code table cannot express.
 */
export type CloudResponse<Result> =
  | { readonly ok: true; readonly value: Result }
  | {
      readonly ok: false;
      readonly kind: 'status';
      readonly status: number;
      readonly body: string;
      /** The API's own machine-readable reason, where it gave one. */
      readonly reason: string | null;
      /**
       * The project the refusal's `ErrorInfo` names as the call's consumer,
       * where it gave one — the federated token's own project, which is
       * routinely not the project in the request URL. A `SERVICE_DISABLED`
       * is about this project's switch, whatever project the call was aimed
       * at, and a sentence that echoes the URL's project sends an operator
       * to verify an API that was never the problem.
       */
      readonly consumer: string | null;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: 'transport';
      readonly message: string;
    };

/** One request's worth of options. */
export interface CloudRequest {
  method: string;
  /** Appended to the endpoint's base URL; must begin with a slash. */
  path: string;
  /** Serialized as JSON when present. */
  body?: unknown;
  /** Query parameters, appended in the order given. */
  query?: Readonly<Record<string, string | undefined>>;
}

/**
 * The shape a Google-family API reports an error in.
 *
 * Read defensively — every field is optional — because the one thing worse than
 * an unhelpful failure message is a failure while producing the failure message.
 */
interface CloudError {
  error?: {
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: { consumer?: string } }[];
  };
}

export class CloudHttp {
  constructor(private readonly endpoint: CloudEndpoint) {}

  /** Send a request and parse a JSON response. Never throws. */
  async json<Result>(options: CloudRequest): Promise<CloudResponse<Result>> {
    const url = this.url(options);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${await this.endpoint.token()}`,
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
      response = await send(request);
    } catch (cause) {
      return {
        ok: false,
        kind: 'transport',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    if (!response.ok) return failureOf(response, await response.text());

    // A `204` and an empty body are the same thing to a caller that asked for a
    // resource back: there was no document. `undefined` cast to the result type
    // is what every one of these APIs' delete verbs actually returns.
    const text = await response.text();
    if (text.trim() === '') return { ok: true, value: undefined as Result };
    try {
      return { ok: true, value: JSON.parse(text) as Result };
    } catch (cause) {
      return {
        ok: false,
        kind: 'transport',
        message: `the API answered ${response.status} with a body that is not JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
  }

  /**
   * Send bytes with a content type the API chose, and read nothing back.
   *
   * Uploading a file is the one call neither adapter can express as JSON, and
   * it is deliberately a separate verb rather than an overload: an upload takes
   * an absolute URL the API handed out, so it does not hang off `baseUrl` at
   * all and must not be able to accidentally be given a path.
   */
  async upload(input: {
    readonly url: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    /**
     * Whatever else the API requires of an upload — a content digest it checks
     * the bytes against, a length it will not infer. Additive rather than a
     * second verb: one API's integrity header is not a different kind of call.
     */
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<CloudResponse<void>> {
    try {
      const request = new Request(input.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.endpoint.token()}`,
          'Content-Type': input.contentType,
          ...input.headers,
        },
        body: input.bytes as unknown as BodyInit,
      });
      const send =
        this.endpoint.fetch ?? ((request: Request) => fetch(request));
      const response = await send(request);
      if (!response.ok) return failureOf(response, await response.text());
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        ok: false,
        kind: 'transport',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  /** Fetch bytes from an address the artifact named. Never throws. */
  async bytes(url: string): Promise<CloudResponse<Uint8Array<ArrayBuffer>>> {
    try {
      const send =
        this.endpoint.fetch ?? ((request: Request) => fetch(request));
      const response = await send(new Request(url, { method: 'GET' }));
      if (!response.ok) return failureOf(response, await response.text());
      return { ok: true, value: new Uint8Array(await response.arrayBuffer()) };
    } catch (cause) {
      return {
        ok: false,
        kind: 'transport',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  private url(options: CloudRequest): string {
    const url = new URL(`${this.endpoint.baseUrl}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

/** One failed response, with whatever the API was willing to say about it. */
function failureOf<Result>(
  response: Response,
  body: string,
): CloudResponse<Result> {
  let parsed: CloudError | null = null;
  try {
    parsed = JSON.parse(body) as CloudError;
  } catch {
    parsed = null;
  }
  const reason =
    parsed?.error?.details?.find((detail) => detail.reason !== undefined)
      ?.reason ??
    parsed?.error?.status ??
    null;
  // ErrorInfo writes it as `projects/<id>`; the sentences here name projects
  // bare, as the manifest and every subject already do.
  const consumer =
    parsed?.error?.details
      ?.find((detail) => detail.metadata?.consumer !== undefined)
      ?.metadata?.consumer?.replace(/^projects\//, '') ?? null;
  return {
    ok: false,
    kind: 'status',
    status: response.status,
    body,
    reason,
    consumer,
    message: parsed?.error?.message ?? body ?? response.statusText,
  };
}
