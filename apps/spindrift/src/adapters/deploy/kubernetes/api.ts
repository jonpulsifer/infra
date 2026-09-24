/**
 * A thin Kubernetes REST client over an injected `fetch` and token. Writes are
 * server-side apply, so fields another manager sets survive the next deploy.
 */

export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential. */
export type TokenProvider = () => string | Promise<string>;

export interface KubernetesEndpoint {
  /** Without a trailing slash. */
  readonly apiServer: string;
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}

/** The same in every installation, so two sharing a cluster never contend. */
export const FIELD_MANAGER = 'spindrift';

/** A non-2xx answer. A transport failure throws from `fetch` instead. */
export class KubernetesRequestError extends Error {
  override readonly name = 'KubernetesRequestError';

  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} failed with ${status}: ${body}`);
  }
}

export interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ResourceRef {
  /** `apps/v1`, or `v1` for the core group. */
  apiVersion: string;
  /** The lowercase plural the path uses, such as `helmreleases`. */
  plural: string;
  namespace?: string;
  name?: string;
}

export function resourcePath(ref: ResourceRef): string {
  const prefix = ref.apiVersion.includes('/')
    ? `/apis/${ref.apiVersion}`
    : `/api/${ref.apiVersion}`;
  const scope =
    ref.namespace === undefined ? '' : `/namespaces/${ref.namespace}`;
  const name = ref.name === undefined ? '' : `/${ref.name}`;
  return `${prefix}${scope}/${ref.plural}${name}`;
}

export interface KubernetesList<Item = KubernetesObject> {
  items: Item[];
}

export class KubernetesApi {
  constructor(private readonly endpoint: KubernetesEndpoint) {}

  /** `null` when the object does not exist. */
  async get(ref: ResourceRef): Promise<KubernetesObject | null> {
    return this.json<KubernetesObject>('GET', resourcePath(ref), {
      tolerate: [404],
    });
  }

  /** `null` when the kind is not served, which differs from an empty list. */
  async list(
    ref: ResourceRef,
    query?: Record<string, string>,
  ): Promise<KubernetesObject[] | null> {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const list = await this.json<KubernetesList>(
      'GET',
      `${resourcePath(ref)}${search}`,
      { tolerate: [404] },
    );
    return list === null ? null : (list.items ?? []);
  }

  /**
   * `force` takes conflicting fields, or a field another manager once set would
   * fail every later deploy with a conflict.
   */
  async apply(object: KubernetesObject, plural: string): Promise<void> {
    const path = resourcePath({
      apiVersion: object.apiVersion,
      plural,
      namespace: object.metadata.namespace,
      name: object.metadata.name,
    });
    await this.send(
      'PATCH',
      `${path}?fieldManager=${FIELD_MANAGER}&force=true`,
      {
        body: object,
        contentType: 'application/apply-patch+yaml',
      },
    );
  }

  /**
   * A 404 here is a fault: the namespace is gone or the group is not served,
   * so nothing was created.
   */
  async create(
    ref: ResourceRef,
    object: KubernetesObject,
  ): Promise<KubernetesObject> {
    const created = await this.json<KubernetesObject>(
      'POST',
      resourcePath(ref),
      { body: object },
    );
    // Unreachable: no status is tolerated, so `send` never answers `null`.
    if (created === null) {
      throw new Error(`POST ${resourcePath(ref)} returned no object`);
    }
    return created;
  }

  /**
   * Idempotent. Pass `propagation` to stop what the object runs: the API's
   * default for a `batch/v1` Job orphans its pods, which keep running.
   */
  async delete(
    ref: ResourceRef,
    options: { readonly propagation?: 'Background' | 'Foreground' } = {},
  ): Promise<void> {
    const query =
      options.propagation === undefined
        ? ''
        : `?propagationPolicy=${options.propagation}`;
    await this.send('DELETE', `${resourcePath(ref)}${query}`, {
      tolerate: [404],
    });
  }

  /**
   * `null` before the pod starts (400) or after it is collected (404). Never
   * followed: a caller polls again for new lines.
   */
  async logs(
    namespace: string,
    pod: string,
    options: {
      readonly container?: string;
      readonly timestamps?: boolean;
      readonly sinceTime?: string;
      readonly tailLines?: number;
      readonly limitBytes?: number;
    } = {},
  ): Promise<string | null> {
    const params = new URLSearchParams();
    if (options.container !== undefined) {
      params.set('container', options.container);
    }
    if (options.timestamps === true) params.set('timestamps', 'true');
    if (options.sinceTime !== undefined) {
      params.set('sinceTime', options.sinceTime);
    }
    if (options.tailLines !== undefined) {
      params.set('tailLines', String(options.tailLines));
    }
    if (options.limitBytes !== undefined) {
      params.set('limitBytes', String(options.limitBytes));
    }
    const query = params.size === 0 ? '' : `?${params.toString()}`;
    const response = await this.send(
      'GET',
      `/api/v1/namespaces/${namespace}/pods/${pod}/log${query}`,
      { tolerate: [400, 404] },
    );
    return response === null ? null : await response.text();
  }

  async servesKind(apiVersion: string, kind: string): Promise<boolean> {
    const path = apiVersion.includes('/')
      ? `/apis/${apiVersion}`
      : `/api/${apiVersion}`;
    const resources = await this.json<{ resources?: { kind: string }[] }>(
      'GET',
      path,
      // An unserved group has no discovery document.
      { tolerate: [404] },
    );
    return (resources?.resources ?? []).some(
      (resource) => resource.kind === kind,
    );
  }

  private async json<Result>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      tolerate?: readonly number[];
    } = {},
  ): Promise<Result | null> {
    const response = await this.send(method, path, options);
    if (response === null) return null;
    return (await response.json()) as Result;
  }

  private async send(
    method: string,
    path: string,
    options: {
      body?: unknown;
      contentType?: string;
      /**
       * Statuses answered as `null`. Never 404 for `create`: a create that 404s
       * created nothing, and must not report success.
       */
      tolerate?: readonly number[];
    } = {},
  ): Promise<Response | null> {
    const url = `${this.endpoint.apiServer}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.endpoint.token()}`,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/json';
    }

    const request = new Request(url, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const send = this.endpoint.fetch ?? ((input: Request) => fetch(input));
    const response = await send(request);

    if (options.tolerate?.includes(response.status)) return null;
    if (!response.ok) {
      throw new KubernetesRequestError(
        method,
        url,
        response.status,
        await response.text(),
      );
    }
    return response;
  }
}
