/**
 * A fake Kubernetes API (Task 17, § Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real paths, its
 * real server-side apply, and its real status reading all run. Nothing inside
 * core is faked; this is the cluster that is not there.
 *
 * Four behaviours are modelled because the adapter has to survive them:
 *
 * - **A kind the cluster does not serve answers `404`, and a served kind with
 *   nothing in it answers `200` with an empty `items`.** That distinction is
 *   the whole reason `KubernetesApi.list` returns `null` rather than `[]`, so
 *   `servedKinds` decides it — not whether a test happened to seed anything.
 * - **The controller writes status after the object is applied.** A fake that
 *   returned a ready object immediately would let an adapter that never polled
 *   pass, which is the whole of `apply`'s second half.
 * - **A rejected write answers `4xx` with a body**, because §6 wants the
 *   sentence the developer reads and a fake that returned a bare status code
 *   would leave nothing to read.
 * - **A write is only a server-side apply if it says so.** The content type and
 *   the field manager are what make a `PATCH` an apply rather than some other
 *   patch, and the API server refuses one that omits either — so this does too,
 *   rather than storing whatever it is handed.
 */
import type { Fetcher } from '../../../src/adapters/deploy/kubernetes/api.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  contentType: string | null;
  body: unknown;
}

/** Any object the fake holds, as loosely typed as the API's own JSON. */
export interface FakeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** What one applied object's status becomes, read by read. */
export type StatusScript = (reads: number) => Record<string, unknown> | null;

export interface FakeKubernetesOptions {
  /**
   * Kinds this cluster serves, as `group/version` → kind names.
   *
   * The core group is served by every cluster and is therefore not a question
   * a test has to answer; anything listed here for `v1` is served in addition
   * to {@link CORE_KINDS}.
   */
  servedKinds?: Record<string, string[]>;
  /** Objects that already exist, keyed by `plural/namespace/name`. */
  objects?: Record<string, FakeObject>;
  /** Collections a list call returns, keyed by plural. */
  lists?: Record<string, FakeObject[]>;
  /** What an applied delivery object's status becomes over successive reads. */
  status?: StatusScript;
  /** When set, every apply is refused with this status and body. */
  refuse?: { status: number; body: string };
  /** What a `SelfSubjectAccessReview` answers. */
  allowed?: boolean;
  token?: string;
  /**
   * What a pod's log reads, by pod name and by read count.
   *
   * A function of the read rather than a string because a build's log grows
   * while the build runs: a fake that served the whole log on the first read
   * would let a route that never polled — and never yielded a timeline — pass.
   */
  logs?: (pod: string, reads: number) => string | null;
}

const HOST = 'https://cluster.invalid';

/**
 * The core-group kinds every cluster serves.
 *
 * Fixed rather than configurable: a cluster that did not serve `Pod` is not a
 * cluster, so making a test declare it would only be a way to forget it and
 * get a `404` that means nothing. A core plural outside this list still
 * `404`s, which is the honest answer for a kind that does not exist.
 */
const CORE_KINDS = [
  'Pod',
  'Event',
  'Node',
  'Namespace',
  'Secret',
  'ConfigMap',
  'Service',
  'ServiceAccount',
  'PersistentVolumeClaim',
];

/**
 * The plural the API path uses for one kind.
 *
 * The API server's own rule, which is why the discovery document and the list
 * route can share it: a fake whose discovery said one plural and whose routing
 * expected another would answer inconsistently about the same kind.
 */
function pluralOf(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/** The body the API server returns for a kind or object that is not there. */
function notFound(message: string): unknown {
  return {
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    reason: 'NotFound',
    code: 404,
    message,
  };
}

/**
 * Whether one object satisfies a `labelSelector`.
 *
 * Equality and existence only, which is every form this adapter sends — and
 * every unsupported form falls through to matching nothing rather than to
 * matching everything, because "the selector was ignored" is exactly the
 * failure this is here to make visible.
 */
function matchesSelector(object: FakeObject, selector: string): boolean {
  const labels = (object.metadata.labels ?? {}) as Record<string, string>;
  return selector
    .split(',')
    .filter((term) => term.length > 0)
    .every((term) => {
      const at = term.indexOf('=');
      if (at === -1) return labels[term] !== undefined;
      return labels[term.slice(0, at)] === term.slice(at + 1);
    });
}

/** The default: the controller reports ready on the first read after apply. */
const READY: StatusScript = () => ({
  observedGeneration: 1,
  conditions: [
    {
      type: 'Ready',
      status: 'True',
      reason: 'InstallSucceeded',
      message: 'ok',
    },
  ],
});

export class FakeKubernetes {
  readonly apiServer = HOST;
  readonly requests: RecordedRequest[] = [];

  private readonly objects = new Map<string, FakeObject>();
  private readonly reads = new Map<string, number>();
  private readonly options: FakeKubernetesOptions;

  constructor(options: FakeKubernetesOptions = {}) {
    this.options = options;
    for (const [key, object] of Object.entries(options.objects ?? {})) {
      this.objects.set(key, object);
    }
  }

  /** Mint the token provider the adapter is constructed with. */
  token = (): string => this.options.token ?? 'federated-token';

  /** Put an object where the adapter will find it. */
  place(key: string, object: FakeObject): void {
    this.objects.set(key, object);
  }

  /** What the cluster holds now — the assertion surface for a write. */
  get(key: string): FakeObject | undefined {
    return this.objects.get(key);
  }

  /** Every object of one plural, in insertion order. */
  all(plural: string): FakeObject[] {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${plural}/`))
      .map(([, object]) => object);
  }

  /** Requests the adapter made, in order — what § Seam 2 asserts on. */
  pathsOf(method: string): string[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => request.path);
  }

  fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === 'GET' || request.method === 'DELETE'
        ? null
        : await request.clone().json();
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      contentType: request.headers.get('content-type'),
      body,
    });

    // The cluster trusts one federated credential. `token()` is the adapter's
    // injected provider, so overriding it must be able to model an expired or
    // otherwise invalid credential rather than silently teaching the fake to
    // trust the bad value too.
    if (request.headers.get('authorization') !== 'Bearer federated-token') {
      return json(401, { message: 'unauthenticated' });
    }

    const discovery = this.discovery(url.pathname);
    if (discovery !== null) return discovery;

    const parsed = parsePath(url.pathname);
    if (parsed === null) return json(404, { message: 'no such path' });

    // The one API that answers rather than stores. It answers about the
    // attributes it is asked about, so a review carrying none is a review
    // about nothing — the API server refuses it rather than approving it.
    if (parsed.plural === 'selfsubjectaccessreviews') {
      const spec = (body as { spec?: { resourceAttributes?: unknown } } | null)
        ?.spec;
      const attributes = spec?.resourceAttributes as
        | { verb?: string; resource?: string }
        | undefined;
      if (attributes?.verb === undefined || attributes.resource === undefined) {
        return json(422, {
          kind: 'Status',
          status: 'Failure',
          reason: 'Invalid',
          code: 422,
          message:
            'SelfSubjectAccessReview.spec.resourceAttributes must name a verb and a resource',
        });
      }
      return json(201, {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        status: { allowed: this.options.allowed ?? true },
      });
    }

    if (parsed.subresource === 'log') {
      const reads = (this.reads.get(url.pathname) ?? 0) + 1;
      this.reads.set(url.pathname, reads);
      const text = this.options.logs?.(parsed.name ?? '', reads) ?? null;
      // A pod whose container has not started answers `400`, which is not a
      // fault: the honest answer is that there is no log yet.
      return text === null
        ? json(400, { message: 'container is waiting to start' })
        : new Response(text);
    }

    if (parsed.name === undefined) {
      return this.listResponse(parsed, url.searchParams);
    }

    const key = `${parsed.plural}/${parsed.namespace ?? ''}/${parsed.name}`;
    switch (request.method) {
      case 'GET':
        return this.getResponse(key);
      case 'PATCH':
        return this.applyResponse(key, body as FakeObject, request, url);
      case 'DELETE':
        // Deleting what is not there is a `404`, which is what makes
        // `KubernetesApi.delete`'s idempotence a property of the adapter
        // rather than of a fake that never disagreed.
        if (!this.objects.has(key)) {
          return json(
            404,
            notFound(`${parsed.plural} "${parsed.name}" not found`),
          );
        }
        this.objects.delete(key);
        this.reads.delete(key);
        return json(200, { status: 'Success' });
      default:
        return json(405, { message: `${request.method} is not supported` });
    }
  };

  private discovery(path: string): Response | null {
    const match = path.match(/^\/apis\/([^/]+\/[^/]+)$/);
    if (match === null) return null;
    const kinds = this.kindsOf(match[1] as string);
    if (kinds === null) return json(404, { message: 'no such group' });
    return json(200, {
      resources: kinds.map((kind) => ({ kind, name: pluralOf(kind) })),
    });
  }

  /** The kinds one `group/version` serves, or `null` if it is not served. */
  private kindsOf(apiVersion: string): string[] | null {
    const served = this.options.servedKinds ?? {};
    if (!apiVersion.includes('/')) {
      return [...CORE_KINDS, ...(served[apiVersion] ?? [])];
    }
    return served[apiVersion] ?? null;
  }

  /**
   * A list, or the `404` that means this cluster does not serve the kind.
   *
   * The two are different answers and `KubernetesApi.list` exists to keep them
   * apart, so what decides is whether the kind is *served* — never whether it
   * happens to hold anything. A served kind holding nothing answers `200` with
   * an empty `items`, which is the branch every `?? []` at a call site is
   * written for and which nothing could previously reach.
   *
   * `servedKinds` is the authority. Seeded objects and a seeded `lists` entry
   * also make a kind served, because they cannot mean anything else: an API
   * that hands back `Pod`s serves `Pod`s. What they no longer do is the
   * inverse — an unseeded kind is absent, not unheard of.
   */
  private listResponse(parsed: ParsedPath, query: URLSearchParams): Response {
    const kinds = this.kindsOf(parsed.apiVersion);
    const serves =
      (kinds ?? []).some((kind) => pluralOf(kind) === parsed.plural) ||
      this.options.lists?.[parsed.plural] !== undefined ||
      this.all(parsed.plural).length > 0;
    if (!serves) {
      return json(
        404,
        notFound('the server could not find the requested resource'),
      );
    }
    const items =
      this.options.lists?.[parsed.plural] ?? this.all(parsed.plural);
    // The cluster filters, not the caller: a selector the adapter got wrong
    // comes back with nothing rather than with everything.
    const selector = query.get('labelSelector');
    return json(200, {
      items:
        selector === null
          ? items
          : items.filter((item) => matchesSelector(item, selector)),
    });
  }

  private getResponse(key: string): Response {
    const object = this.objects.get(key);
    if (object === undefined) return json(404, { message: 'not found' });

    // The controller writes status *after* the object exists, which is what
    // makes `apply` poll rather than assume.
    const script = this.options.status ?? READY;
    const reads = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, reads);
    const status = script(reads);
    return json(200, status === null ? object : { ...object, status });
  }

  private applyResponse(
    key: string,
    object: FakeObject,
    request: Request,
    url: URL,
  ): Response {
    // "Whether you are submitting JSON data or YAML data, use
    // `application/apply-patch+yaml` as the Content-Type header value." A
    // `PATCH` sent as `application/json` is a merge patch — a different verb
    // with different semantics — and the API server refuses it here rather
    // than quietly applying it as one.
    if (
      request.headers.get('content-type') !== 'application/apply-patch+yaml'
    ) {
      return json(415, {
        kind: 'Status',
        status: 'Failure',
        reason: 'UnsupportedMediaType',
        code: 415,
        message:
          'the body of the request was in an unknown format - accepted media types include: application/apply-patch+yaml',
      });
    }
    // "All Server-Side Apply patch requests are required to identify themselves
    // by providing a `fieldManager` query parameter." Without one there is
    // nobody for the applied fields to belong to, which is the whole mechanism
    // that keeps an operator's edit from being reverted by the next deploy.
    if ((url.searchParams.get('fieldManager') ?? '') === '') {
      return json(400, {
        kind: 'Status',
        status: 'Failure',
        reason: 'BadRequest',
        code: 400,
        message: 'fieldManager is required for apply patch',
      });
    }
    if (this.options.refuse !== undefined) {
      return new Response(this.options.refuse.body, {
        status: this.options.refuse.status,
      });
    }
    const stored = {
      ...object,
      metadata: { ...object.metadata, generation: 1 },
    };
    this.objects.set(key, stored);
    this.reads.set(key, 0);
    return json(200, stored);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface ParsedPath {
  /** `v1` for the core group, `group/version` otherwise. */
  apiVersion: string;
  plural: string;
  namespace?: string;
  name?: string;
  /** `log`, `status`, and the rest — a segment after the object's name. */
  subresource?: string;
}

/** The inverse of `resourcePath` — what the adapter addressed. */
function parsePath(path: string): ParsedPath | null {
  const parts = path.split('/').filter((part) => part.length > 0);
  // /api/v1/... or /apis/group/version/...
  const apiVersion =
    parts[0] === 'api'
      ? (parts[1] ?? null)
      : parts[0] === 'apis' && parts[1] !== undefined && parts[2] !== undefined
        ? `${parts[1]}/${parts[2]}`
        : null;
  const rest =
    parts[0] === 'api'
      ? parts.slice(2)
      : parts[0] === 'apis'
        ? parts.slice(3)
        : null;
  if (rest === null || apiVersion === null) return null;

  if (rest[0] === 'namespaces' && rest.length >= 3) {
    return {
      apiVersion,
      namespace: rest[1] as string,
      plural: rest[2] as string,
      ...(rest[3] === undefined ? {} : { name: rest[3] }),
      ...(rest[4] === undefined ? {} : { subresource: rest[4] }),
    };
  }
  if (rest.length === 0) return null;
  return {
    apiVersion,
    plural: rest[0] as string,
    ...(rest[1] === undefined ? {} : { name: rest[1] }),
  };
}
