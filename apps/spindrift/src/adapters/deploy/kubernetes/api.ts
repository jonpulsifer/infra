/**
 * The Kubernetes API, as thin as the adapter needs it.
 *
 * § Seam 2 names the pattern: "a fake of the far-side HTTP API behind the real
 * client, with the test asserting the requests that were made". That only works
 * if the client takes its transport, so `fetch` is injected and nothing here
 * reaches for a global.
 *
 * There is no client library. §19 already rules out the machinery a library
 * brings — "no CRD, no informer, no controller-runtime" — and what is left is
 * four verbs over REST paths. A dependency for that would be a dependency whose
 * types drift from the four objects this adapter actually writes.
 *
 * **Writes are server-side apply.** A `PATCH` with the apply content type makes
 * Spindrift a named field manager, so a field an operator sets on the same
 * object is not silently reverted by the next deploy — and re-applying an
 * unchanged object is a no-op rather than a new generation.
 */

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** Where a cluster is reached and how a request to it is authorized. */
export interface KubernetesEndpoint {
  /** The API server, without a trailing slash. */
  readonly apiServer: string;
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * The field manager every write is attributed to.
 *
 * A constant rather than a value: two installations sharing a cluster still
 * want their writes attributed to Spindrift, and a per-installation manager
 * would make the same object look contended between them.
 */
export const FIELD_MANAGER = 'spindrift';

/** A cluster that answered, but not with success. */
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

/** Any Kubernetes object, as loosely typed as the API's own JSON. */
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

/** Where one object lives, in the API's own path vocabulary. */
export interface ResourceRef {
  /** `apps/v1`, or `v1` for the core group. */
  apiVersion: string;
  /** The lowercase plural, as the path uses it — `helmreleases`, `pods`. */
  plural: string;
  namespace?: string;
  name?: string;
}

/** The path a ref addresses. Exported because the tests assert on paths. */
export function resourcePath(ref: ResourceRef): string {
  const prefix = ref.apiVersion.includes('/')
    ? `/apis/${ref.apiVersion}`
    : `/api/${ref.apiVersion}`;
  const scope =
    ref.namespace === undefined ? '' : `/namespaces/${ref.namespace}`;
  const name = ref.name === undefined ? '' : `/${ref.name}`;
  return `${prefix}${scope}/${ref.plural}${name}`;
}

/** What a list call returns, of whatever kind was listed. */
export interface KubernetesList<Item = KubernetesObject> {
  items: Item[];
}

export class KubernetesApi {
  constructor(private readonly endpoint: KubernetesEndpoint) {}

  /** One object, or `null` when the API says it is not there. */
  async get(ref: ResourceRef): Promise<KubernetesObject | null> {
    return this.json<KubernetesObject>('GET', resourcePath(ref), {
      tolerate: [404],
    });
  }

  /**
   * Every object matching a ref, or `null` when the *kind* is not served.
   *
   * The distinction is the whole reason this returns `null` rather than an
   * empty list: "no `HelmRelease`s exist" and "this cluster does not know what
   * a `HelmRelease` is" are different answers, and §13's checklist turns on the
   * second one.
   */
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
   * Server-side apply one object.
   *
   * `force` resolves a conflict in Spindrift's favour for the fields Spindrift
   * owns. Without it a field another manager once set — a replica count edited
   * by hand, say — would make every subsequent deploy fail with a conflict
   * instead of converging.
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
   * `POST` one object, and answer with what the API server made of it.
   *
   * Two callers, and they want opposite things from the reply.
   * `SelfSubjectAccessReview` answers rather than stores: the API server
   * replies with what the request's own identity may do, which is how §13's
   * "OIDC both ways" is checked without holding a credential. A Job stores, and
   * the object that comes back is the proof it exists.
   *
   * **A `404` here is a fault, never an absence.** `POST`ing to a collection
   * path 404s when the namespace is gone or the group is not served — neither
   * of which is "there is nothing there", both of which mean nothing was
   * created. Absence is only an answer for a read, which is why the tolerance
   * for it is opt-in one method up rather than a default in {@link send}.
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
    // `send` only answers `null` for a tolerated status and this call tolerates
    // none, so this is unreachable — asserted rather than assumed because the
    // whole point of the change above is that a caller must not be able to
    // treat "created nothing" as "created something".
    if (created === null) {
      throw new Error(`POST ${resourcePath(ref)} returned no object`);
    }
    return created;
  }

  /**
   * Idempotent: deleting what is already gone succeeds (§6).
   *
   * `propagation` is for a caller that means to stop what the object is
   * running, not only to remove it: a `batch/v1` Job deleted through the API
   * orphans its pods unless a policy says otherwise (`kubectl` sets one; the
   * API's own default for that version is to orphan), so a build Job deleted
   * without it keeps building.
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
   * One pod's log as text, or `null` when the pod has none yet.
   *
   * Read rather than followed: a `follow=true` connection is a long-lived
   * stream, and every other read in this adapter is a poll for the reason §6
   * gives — a watch over the uplink stays open while delivering nothing. A
   * caller that wants the tail asks again and takes what is new.
   *
   * A pod that has not started yet answers `400`, which is not a fault: the
   * container is pulling, and the honest answer is that there is no log.
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
      // A pod that has been garbage collected is a `404`, and "there is no log"
      // is the same honest answer for it as for one that has not started.
      { tolerate: [400, 404] },
    );
    return response === null ? null : await response.text();
  }

  /** Whether the API serves a kind at all — §13's checklist, one call. */
  async servesKind(apiVersion: string, kind: string): Promise<boolean> {
    const path = apiVersion.includes('/')
      ? `/apis/${apiVersion}`
      : `/api/${apiVersion}`;
    const resources = await this.json<{ resources?: { kind: string }[] }>(
      'GET',
      path,
      // A group the cluster does not serve has no discovery document, which is
      // the answer this asks for rather than a fault.
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
       * Statuses the caller has a value for, returned as `null` rather than
       * raised.
       *
       * `404` is in here for every read and for `delete`, and in here for
       * nothing that writes. It used to be unconditional, on the reasoning that
       * absence is an answer every caller has a value for — which was true
       * until a caller started `POST`ing a Job. A create whose namespace was
       * deleted 404s, and swallowing that turned "nothing was created" into a
       * started run: an act that reached nothing and reported success. The
       * distinction is a property of the verb, so the verb states it.
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
