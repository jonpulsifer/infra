/**
 * The Kubernetes API behind the real adapter. An unserved kind lists 404 and an
 * empty served one lists 200, status arrives on a later read, and a `PATCH` is
 * accepted only as a server-side apply.
 */
import type { Fetcher } from '../../../src/adapters/deploy/kubernetes/api.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  contentType: string | null;
  body: unknown;
}

export interface FakeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** An object's `status` on its nth read, or `null` for none. */
export type StatusScript = (reads: number) => Record<string, unknown> | null;

export interface FakeKubernetesOptions {
  /** `group/version` to kind names; `v1` entries add to {@link CORE_KINDS}. */
  servedKinds?: Record<string, string[]>;
  /** Objects that already exist, keyed by `plural/namespace/name`. */
  objects?: Record<string, FakeObject>;
  /** Collections a list call returns, keyed by plural. */
  lists?: Record<string, FakeObject[]>;
  /**
   * Labels an unseeded namespace answers with, by default the Pod Security labels
   * a Target's namespace carries. `{}` makes an unseeded namespace absent.
   */
  namespaceLabels?: Record<string, string>;
  /** Plurals this identity may not list, answered 403. */
  forbidden?: readonly string[];
  status?: StatusScript;
  /** When set, every valid apply answers with this. */
  refuse?: { status: number; body: string };
  /** What a `SelfSubjectAccessReview` answers. */
  allowed?: boolean;
  token?: string;
  /**
   * A pod's log by read count, since a build's log grows while it runs. `null`
   * answers 400, as a container not yet started does.
   */
  logs?: (pod: string, reads: number) => string | null;
}

const HOST = 'https://cluster.invalid';

/** The core kinds every cluster serves; any other core plural 404s. */
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

/** The API server's pluralization, shared by discovery and routing. */
function pluralOf(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

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
 * Equality and existence only, the forms the adapter sends. Any other form
 * matches nothing, so an ignored selector shows.
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

/** The default: ready on the first read after apply. */
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

/** The Pod Security labels the `spindrift-target` namespace declares. */
const DECLARED_NAMESPACE_LABELS: Record<string, string> = {
  'pod-security.kubernetes.io/enforce': 'restricted',
  'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/warn': 'restricted',
};

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

  /** The adapter's token provider. */
  token = (): string => this.options.token ?? 'federated-token';

  place(key: string, object: FakeObject): void {
    this.objects.set(key, object);
  }

  /** Deletes an object out of band. */
  remove(key: string): void {
    this.objects.delete(key);
    this.reads.delete(key);
  }

  /**
   * An unseeded namespace, which a Target's cluster always has, labelled for the
   * adapter to copy onto each App namespace.
   */
  private declaredNamespace(key: string): FakeObject | undefined {
    if (!key.startsWith('namespaces/')) return undefined;
    const labels = this.options.namespaceLabels ?? DECLARED_NAMESPACE_LABELS;
    if (Object.keys(labels).length === 0) return undefined;
    const name = key.slice('namespaces/'.length);
    return {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name, labels },
    };
  }

  get(key: string): FakeObject | undefined {
    return this.objects.get(key);
  }

  all(plural: string): FakeObject[] {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${plural}/`))
      .map(([, object]) => object);
  }

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

    // A literal, so overriding `token` models an invalid credential.
    if (request.headers.get('authorization') !== 'Bearer federated-token') {
      return json(401, { message: 'unauthenticated' });
    }

    const discovery = this.discovery(url.pathname);
    if (discovery !== null) return discovery;

    const parsed = parsePath(url.pathname);
    if (parsed === null) return json(404, { message: 'no such path' });

    // The API server refuses a review that names no verb or resource.
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
      return text === null
        ? json(400, { message: 'container is waiting to start' })
        : new Response(text);
    }

    if (parsed.name === undefined) {
      // A `POST` to a collection creates, and a taken name answers 409.
      if (request.method === 'POST') {
        const object = body as FakeObject;
        const key = `${parsed.plural}/${parsed.namespace ?? ''}/${object.metadata.name}`;
        if (this.objects.has(key)) {
          return json(409, {
            kind: 'Status',
            apiVersion: 'v1',
            status: 'Failure',
            reason: 'AlreadyExists',
            code: 409,
            message: `${parsed.plural} "${object.metadata.name}" already exists`,
          });
        }
        this.objects.set(key, object);
        return json(201, object);
      }
      return this.listResponse(parsed, url.searchParams);
    }

    const key = `${parsed.plural}/${parsed.namespace ?? ''}/${parsed.name}`;
    switch (request.method) {
      case 'GET':
        return this.getResponse(key);
      case 'PATCH':
        return this.applyResponse(key, body as FakeObject, request, url);
      case 'DELETE':
        // Deleting what is not there answers 404, as the API server does.
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
   * An unserved kind answers 404 and a served empty one 200. `servedKinds`, a
   * `lists` entry or a seeded object makes a kind served.
   */
  private listResponse(parsed: ParsedPath, query: URLSearchParams): Response {
    if (this.options.forbidden?.includes(parsed.plural)) {
      return json(403, {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        reason: 'Forbidden',
        code: 403,
        message: `${parsed.plural} is forbidden: User "spindrift" cannot list resource "${parsed.plural}" in the namespace "${parsed.namespace ?? ''}"`,
      });
    }
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
    // The cluster filters, so a wrong selector returns nothing.
    const selector = query.get('labelSelector');
    return json(200, {
      items:
        selector === null
          ? items
          : items.filter((item) => matchesSelector(item, selector)),
    });
  }

  private getResponse(key: string): Response {
    const object = this.objects.get(key) ?? this.declaredNamespace(key);
    if (object === undefined) return json(404, { message: 'not found' });

    // Status arrives after the object exists, so `apply` polls.
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
    // SSA takes `application/apply-patch+yaml` even for a JSON body;
    // `application/json` would be a merge patch.
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
    // Server-side apply requires a `fieldManager` to own the applied fields.
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
    // A `resourceVersion` in the body is a precondition: a moved version is 409.
    const expected = object.metadata.resourceVersion;
    const current = this.objects.get(key)?.metadata.resourceVersion;
    if (
      expected !== undefined &&
      current !== undefined &&
      expected !== current
    ) {
      return json(409, {
        kind: 'Status',
        status: 'Failure',
        reason: 'Conflict',
        code: 409,
        message: `Operation cannot be fulfilled on ${key}: the object has been modified; please apply your changes to the latest version and try again`,
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
  /** A segment after the object's name, such as `log`. */
  subresource?: string;
}

/** The inverse of the adapter's `resourcePath`. */
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
