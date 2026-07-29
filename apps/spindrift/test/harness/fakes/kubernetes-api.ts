/**
 * A fake Kubernetes API (Task 17, § Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real paths, its
 * real server-side apply, and its real status reading all run. Nothing inside
 * core is faked; this is the cluster that is not there.
 *
 * Three behaviours are modelled because the adapter has to survive them:
 *
 * - **A kind the cluster does not serve answers `404`**, which is how §13's
 *   checklist tells "no `HelmRelease`s exist" from "this cluster has never
 *   heard of one".
 * - **The controller writes status after the object is applied.** A fake that
 *   returned a ready object immediately would let an adapter that never polled
 *   pass, which is the whole of `apply`'s second half.
 * - **A rejected write answers `4xx` with a body**, because §6 wants the
 *   sentence the developer reads and a fake that returned a bare status code
 *   would leave nothing to read.
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
  /** Kinds this cluster serves, as `group/version` → kind names. */
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

    // The one API that answers rather than stores.
    if (parsed.plural === 'selfsubjectaccessreviews') {
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

    if (parsed.name === undefined) return this.listResponse(parsed.plural);

    const key = `${parsed.plural}/${parsed.namespace ?? ''}/${parsed.name}`;
    switch (request.method) {
      case 'GET':
        return this.getResponse(key);
      case 'PATCH':
        return this.applyResponse(key, body as FakeObject);
      case 'DELETE':
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
    const served = this.options.servedKinds ?? {};
    const kinds = served[match[1] as string];
    if (kinds === undefined) return json(404, { message: 'no such group' });
    return json(200, {
      resources: kinds.map((kind) => ({ kind, name: kind.toLowerCase() })),
    });
  }

  private listResponse(plural: string): Response {
    const seeded = this.options.lists?.[plural];
    if (seeded === undefined && this.all(plural).length === 0) {
      // A kind nothing was seeded for is a kind this cluster does not serve.
      return json(404, { message: `no ${plural}` });
    }
    return json(200, { items: seeded ?? this.all(plural) });
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

  private applyResponse(key: string, object: FakeObject): Response {
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
  const rest =
    parts[0] === 'api'
      ? parts.slice(2)
      : parts[0] === 'apis'
        ? parts.slice(3)
        : null;
  if (rest === null) return null;

  if (rest[0] === 'namespaces' && rest.length >= 3) {
    return {
      namespace: rest[1] as string,
      plural: rest[2] as string,
      ...(rest[3] === undefined ? {} : { name: rest[3] }),
      ...(rest[4] === undefined ? {} : { subresource: rest[4] }),
    };
  }
  if (rest.length === 0) return null;
  return {
    plural: rest[0] as string,
    ...(rest[1] === undefined ? {} : { name: rest[1] }),
  };
}
