/**
 * A fake Cloud Run API (Task 28, § Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real paths, its real
 * apply, and its real status reading all run. Nothing inside core is faked; this
 * is the project that is not there.
 *
 * Four behaviours are modelled because the adapter has to survive all four:
 *
 * - **The runtime writes `terminalCondition` after the Service is accepted.** A
 *   fake that answered ready on the first read would let an adapter that never
 *   polled pass, which is the whole of `apply`'s second half.
 * - **A refusal carries a body with a machine-readable reason**, because the
 *   checklist tells "the service is off" from "you may not" from "there is no
 *   such project" by exactly that, and a bare status code would leave nothing to
 *   tell them apart with.
 * - **The IAM policy is a resource that can be read back**, so a test can assert
 *   §9's fail-closed ordering rather than only that a call was made.
 * - **The admission policy lives at its own endpoint**, which is how a Target
 *   that names none is distinguishable from one whose policy admits everything.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';
import { CLOUD_ENDPOINTS } from '../installation.ts';

export interface RecordedCloudRequest {
  method: string;
  /** Path and query, which is what an `allowMissing` assertion needs. */
  url: string;
  path: string;
  body: unknown;
}

/** What one applied Service's status becomes, read by read. */
export type ServiceScript = (reads: number) => Record<string, unknown> | null;

export interface FakeCloudRunOptions {
  readonly project?: string;
  readonly region?: string;
  /** What a Service's condition fields become over successive reads. */
  readonly service?: ServiceScript;
  /** When set, every write is refused with this status and body. */
  readonly refuse?: { status: number; body: unknown };
  /** When set, the list probe `inspect` makes is refused with this. */
  readonly refuseList?: { status: number; body: unknown };
  /** When set, `:setIamPolicy` is refused with this. */
  readonly refuseIam?: { status: number; body: unknown };
  /** The admission policy this project reports, or `null` for none at all. */
  readonly admissionPolicy?: Record<string, unknown> | null;
  readonly token?: string;
}

/** The default: the runtime reports ready on the second read after apply. */
const READY: ServiceScript = (reads) =>
  reads < 2
    ? { terminalCondition: { type: 'Ready', state: 'CONDITION_RECONCILING' } }
    : {
        terminalCondition: {
          type: 'Ready',
          state: 'CONDITION_SUCCEEDED',
          message: 'ok',
        },
      };

export class FakeCloudRun {
  readonly endpoint = CLOUD_ENDPOINTS.run;
  readonly policyEndpoint = CLOUD_ENDPOINTS.policy;
  readonly requests: RecordedCloudRequest[] = [];

  /** Services this project holds, by id. */
  private readonly services = new Map<string, Record<string, unknown>>();
  /** Invoker policies, by service id — the assertion surface for exposure. */
  private readonly policies = new Map<string, unknown>();
  private readonly reads = new Map<string, number>();
  private readonly options: FakeCloudRunOptions;

  constructor(options: FakeCloudRunOptions = {}) {
    this.options = options;
  }

  get project(): string {
    return this.options.project ?? 'example-vessel';
  }

  get region(): string {
    return this.options.region ?? 'somewhere';
  }

  /** Mint the token provider the adapter is constructed with. */
  token = (): string => this.options.token ?? 'federated-token';

  /** What the project holds now — the assertion surface for a write. */
  service(id: string): Record<string, unknown> | undefined {
    return this.services.get(id);
  }

  /** The invoker policy written for one Service, if any was. */
  policy(id: string): unknown {
    return this.policies.get(id);
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
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      body,
    });

    if (request.headers.get('authorization') !== `Bearer ${this.token()}`) {
      return json(401, { error: { message: 'unauthenticated' } });
    }

    if (url.origin === new URL(this.policyEndpoint).origin) {
      return this.admissionResponse();
    }

    const parent = `/v2/projects/${this.project}/locations/${this.region}/services`;
    if (!url.pathname.startsWith(parent)) {
      return json(404, {
        error: { message: 'no such path', status: 'NOT_FOUND' },
      });
    }

    const rest = url.pathname.slice(parent.length).replace(/^\//, '');
    if (rest === '') {
      if (this.options.refuseList !== undefined) {
        return json(
          this.options.refuseList.status,
          this.options.refuseList.body,
        );
      }
      return json(200, { services: [...this.services.values()] });
    }

    const [id, verb] = rest.split(':', 2);
    if (id === undefined || id === '') return json(404, notFound());

    if (verb === 'setIamPolicy') {
      if (this.options.refuseIam !== undefined) {
        return json(this.options.refuseIam.status, this.options.refuseIam.body);
      }
      if (!this.services.has(id)) return json(404, notFound());
      this.policies.set(id, body);
      return json(200, (body as { policy?: unknown })?.policy ?? {});
    }

    switch (request.method) {
      case 'GET':
        return this.readResponse(id);
      case 'PATCH':
        return this.applyResponse(url, id, body as Record<string, unknown>);
      case 'DELETE':
        if (!this.services.has(id)) return json(404, notFound());
        this.services.delete(id);
        this.policies.delete(id);
        this.reads.delete(id);
        return json(200, { done: true });
      default:
        return json(405, {
          error: { message: `${request.method} is not supported` },
        });
    }
  };

  private admissionResponse(): Response {
    const policy = this.options.admissionPolicy;
    if (policy === undefined || policy === null) return json(404, notFound());
    return json(200, policy);
  }

  private readResponse(id: string): Response {
    const service = this.services.get(id);
    if (service === undefined) return json(404, notFound());

    // The runtime writes the terminal condition *after* the Service exists,
    // which is what makes `apply` poll rather than assume.
    const script = this.options.service ?? READY;
    const reads = (this.reads.get(id) ?? 0) + 1;
    this.reads.set(id, reads);
    const status = script(reads);
    return json(200, status === null ? service : { ...service, ...status });
  }

  private applyResponse(
    url: URL,
    id: string,
    document: Record<string, unknown>,
  ): Response {
    if (this.options.refuse !== undefined) {
      return json(this.options.refuse.status, this.options.refuse.body);
    }
    // `allowMissing` is what makes the adapter's one call create-or-update. A
    // fake that created regardless would let the adapter drop the parameter
    // and still pass, so the refusal is modelled rather than assumed.
    if (
      !this.services.has(id) &&
      url.searchParams.get('allowMissing') !== 'true'
    ) {
      return json(404, notFound());
    }
    const stored = {
      ...document,
      name: id,
      uri: `https://${id}.run.example.test`,
    };
    this.services.set(id, stored);
    this.reads.set(id, 0);
    return json(200, { done: false, metadata: { target: id } });
  }
}

/** The body a Google-family API returns for an absent resource. */
function notFound(): unknown {
  return { error: { message: 'not found', status: 'NOT_FOUND' } };
}

/** A refusal because the service is switched off in this project. */
export function serviceDisabled(): { status: number; body: unknown } {
  return {
    status: 403,
    body: {
      error: {
        message: 'Cloud Run API has not been used in this project',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'SERVICE_DISABLED' }],
      },
    },
  };
}

/** A refusal because this identity may not act here. */
export function permissionDenied(): { status: number; body: unknown } {
  return {
    status: 403,
    body: {
      error: {
        message: 'the caller does not have permission',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'IAM_PERMISSION_DENIED' }],
      },
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
