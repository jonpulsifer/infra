/**
 * The HTTP client the cloud deploy adapters share. A failure is returned, not
 * thrown, so an adapter can tell a refusal, an absence and a disabled service
 * apart by status and body.
 */

import type { Fetcher, TokenProvider } from '@repo/archive/federation';

// One declaration, shared with the federation package that mints the token.
export type { Fetcher, TokenProvider };

export interface CloudEndpoint {
  /** Without a trailing slash. */
  readonly baseUrl: string;
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}

/** `transport` is a failure with no status: DNS, a dead socket, a down uplink. */
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
       * The consumer `ErrorInfo` names: the federated token's own project,
       * often not the URL's. `SERVICE_DISABLED` is about this project's switch.
       */
      readonly consumer: string | null;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: 'transport';
      readonly message: string;
    };

export interface CloudRequest {
  method: string;
  /** Appended to the endpoint's base URL; must begin with a slash. */
  path: string;
  /** Serialized as JSON when present. */
  body?: unknown;
  /** `undefined` values are left out. */
  query?: Readonly<Record<string, string | undefined>>;
}

/** A Google-family error body, all optional so reading a failure cannot fail. */
interface CloudError {
  error?: {
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: { consumer?: string } }[];
  };
}

export class CloudHttp {
  constructor(private readonly endpoint: CloudEndpoint) {}

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

    // A `204` or an empty body is no document, which is what these APIs'
    // delete verbs return.
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

  /** To an absolute URL the API handed out, so it never takes a path. */
  async upload(input: {
    readonly url: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    /** What else the API requires, such as a content digest or a length. */
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

  /**
   * Separate from {@link CloudHttp.json}, which labels any body as JSON:
   * `Request` must write the multipart `Content-Type`, boundary included.
   */
  async form<Result>(input: {
    readonly path: string;
    readonly body: FormData;
  }): Promise<CloudResponse<Result>> {
    try {
      const request = new Request(`${this.endpoint.baseUrl}${input.path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await this.endpoint.token()}`,
        },
        body: input.body,
      });
      const send = this.endpoint.fetch ?? ((sent: Request) => fetch(sent));
      const response = await send(request);
      const text = await response.text();
      if (!response.ok) return failureOf(response, text);
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
  // ErrorInfo writes `projects/<id>`; every subject names a project bare.
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
