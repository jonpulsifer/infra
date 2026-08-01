/**
 * A fake Cloud Run API (Task 28, § Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real paths, its real
 * apply, and its real status reading all run. Nothing inside core is faked; this
 * is the project that is not there.
 *
 * Six behaviours are modelled because the adapter has to survive all six:
 *
 * - **A write answers with an `Operation` and the Service appears behind it.**
 *   "If successful, the response body contains an instance of `Operation`" —
 *   the work is asynchronous, so a `GET` issued straight after a create can
 *   still `404`. That window is the one thing a first Cloud Run deploy is
 *   guaranteed to hit, so it happens on every create here rather than never.
 * - **The runtime writes `terminalCondition` after the Service is accepted.** A
 *   fake that answered ready on the first read would let an adapter that never
 *   polled pass, which is the whole of `apply`'s second half.
 * - **A document carrying a field the v2 schema does not define is refused.**
 *   Google's protobuf-JSON parsers reject unknown members with `400
 *   INVALID_ARGUMENT`, and the rendered Service is the single document
 *   standing between this product and a Cloud Run deploy — a `Map.set` is not
 *   a check.
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
  /**
   * Reads a newly created Service `404`s for before it becomes readable.
   *
   * One by default rather than zero, because the create-then-`404` window is
   * not an edge case: the `PATCH` returns an `Operation` and the Service is
   * created behind it, so the very next `GET` losing the race is the ordinary
   * shape of a first deploy. An adapter that treated an absent Service as a
   * failure would be wrong on every App's first deploy and right afterwards,
   * which is the worst way for a bug to behave.
   */
  readonly createLatencyReads?: number;
  readonly token?: string;
}

/**
 * The shape of a v2 `Service`, as much of it as a document may name.
 *
 * `true` is "this member exists and what is under it is not this fake's
 * business" — a free-form map, a scalar, or a message nothing here renders. An
 * object descends, and a one-element array descends into every element. What
 * matters is the *closed* set at each level: Google's parsers refuse a member
 * they do not know, so a fake that accepted one would be the only reader of
 * this document that ever did.
 */
type ServiceSchema =
  | true
  | { [member: string]: ServiceSchema }
  | [ServiceSchema];

const CONTAINER: ServiceSchema = {
  name: true,
  image: true,
  command: true,
  args: true,
  env: [
    {
      name: true,
      value: true,
      valueSource: { secretKeyRef: { secret: true, version: true } },
    },
  ],
  resources: { limits: true, cpuIdle: true, startupCpuBoost: true },
  ports: [{ name: true, containerPort: true }],
  volumeMounts: [{ name: true, mountPath: true }],
  workingDir: true,
  livenessProbe: true,
  startupProbe: true,
  dependsOn: true,
  baseImageUri: true,
};

const REVISION_TEMPLATE: ServiceSchema = {
  revision: true,
  labels: true,
  annotations: true,
  scaling: { minInstanceCount: true, maxInstanceCount: true },
  vpcAccess: true,
  timeout: true,
  serviceAccount: true,
  containers: [CONTAINER],
  volumes: true,
  executionEnvironment: true,
  encryptionKey: true,
  maxInstanceRequestConcurrency: true,
  sessionAffinity: true,
  healthCheckDisabled: true,
  nodeSelector: true,
  serviceMesh: true,
  gpuZonalRedundancyDisabled: true,
};

const SERVICE_SCHEMA: ServiceSchema = {
  name: true,
  description: true,
  uid: true,
  generation: true,
  labels: true,
  annotations: true,
  client: true,
  clientVersion: true,
  ingress: true,
  launchStage: true,
  binaryAuthorization: true,
  template: REVISION_TEMPLATE,
  traffic: true,
  scaling: true,
  invokerIamDisabled: true,
  defaultUriDisabled: true,
  customAudiences: true,
  iapEnabled: true,
  threatDetectionEnabled: true,
};

/**
 * The first member the document names that the schema does not, if any.
 *
 * Reported by path rather than by name alone, because "Unknown name `foo`" in
 * a nested message is only actionable if it says which message.
 */
function unknownMember(
  document: unknown,
  schema: ServiceSchema,
  path = '',
): string | null {
  if (schema === true) return null;
  if (Array.isArray(schema)) {
    if (!Array.isArray(document)) return null;
    for (const [at, item] of document.entries()) {
      const found = unknownMember(
        item,
        schema[0] as ServiceSchema,
        `${path}[${at}]`,
      );
      if (found !== null) return found;
    }
    return null;
  }
  if (document === null || typeof document !== 'object') return null;
  for (const [member, value] of Object.entries(document)) {
    const under = schema[member];
    const where = path === '' ? member : `${path}.${member}`;
    if (under === undefined) return where;
    const found = unknownMember(value, under, where);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Namespaces the v2 API refuses to take a label in.
 *
 * "Cloud Run API v2 does not support labels with `run.googleapis.com`,
 * `cloud.googleapis.com`, `serving.knative.dev`, or `autoscaling.knative.dev`
 * namespaces, and they will be rejected."
 */
const RESERVED_LABEL_NAMESPACES = [
  'run.googleapis.com',
  'cloud.googleapis.com',
  'serving.knative.dev',
  'autoscaling.knative.dev',
];

/** What is wrong with one label map, or `null` if nothing is. */
function labelProblem(labels: unknown, where: string): string | null {
  if (labels === null || typeof labels !== 'object') return null;
  for (const [key, value] of Object.entries(
    labels as Record<string, unknown>,
  )) {
    const namespace = key.includes('/') ? key.slice(0, key.indexOf('/')) : '';
    if (RESERVED_LABEL_NAMESPACES.includes(namespace)) {
      return `${where} label "${key}" is in a reserved namespace`;
    }
    if (key.length > 63 || !/^[a-z][a-z0-9_-]*$/.test(key)) {
      return `${where} label key "${key}" is not a valid label name`;
    }
    if (typeof value !== 'string') {
      return `${where} label "${key}" is not a string`;
    }
    if (value.length > 63 || !/^[a-z0-9_-]*$/.test(value)) {
      return `${where} label "${key}" has an invalid value "${value}"`;
    }
  }
  return null;
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
  /** Every Operation a write answered with, in order — what a poll would use. */
  readonly operations: { name: string; done: boolean }[] = [];

  /** Services this project holds, by id. */
  private readonly services = new Map<string, Record<string, unknown>>();
  /** Invoker policies, by service id — the assertion surface for exposure. */
  private readonly policies = new Map<string, unknown>();
  private readonly reads = new Map<string, number>();
  /** Reads a just-created Service still owes before it can be seen. */
  private readonly creating = new Map<string, number>();
  private nextOperation = 1;
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
        this.creating.delete(id);
        return json(200, this.operation(id, true));
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
    // The Service is created *behind* the Operation the write returned, so for
    // a while after a create it is genuinely not there yet. `read()` must map
    // that to "still applying" rather than to a failure.
    const owed = this.creating.get(id) ?? 0;
    if (owed > 0) {
      this.creating.set(id, owed - 1);
      return json(404, notFound());
    }
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
    const rejected = this.schemaProblem(document);
    if (rejected !== null) return rejected;

    const creating = !this.services.has(id);
    const stored = {
      ...document,
      name: id,
      uri: `https://${id}.run.example.test`,
    };
    this.services.set(id, stored);
    this.reads.set(id, 0);
    if (creating) {
      this.creating.set(id, this.options.createLatencyReads ?? 1);
    }
    return json(200, this.operation(id, false));
  }

  /** Why the API would refuse this document, or `null` if it would not. */
  private schemaProblem(document: Record<string, unknown>): Response | null {
    const unknown = unknownMember(document, SERVICE_SCHEMA);
    if (unknown !== null) {
      return json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `Invalid JSON payload received. Unknown name "${unknown}" at 'service'.`,
        },
      });
    }
    const template = document.template as
      | { labels?: unknown }
      | undefined
      | null;
    const label =
      labelProblem(document.labels, 'service') ??
      labelProblem(template?.labels, 'revision template');
    if (label !== null) {
      return json(400, {
        error: { code: 400, status: 'INVALID_ARGUMENT', message: label },
      });
    }
    return null;
  }

  /**
   * The long-running operation a write answers with.
   *
   * A real one always carries a `name` — it is the handle the operation is
   * polled by. The adapter discards this body today, so the `name` is here for
   * the moment something wants to poll rather than because anything reads it
   * now; a fake with nothing to poll is a fake that could not tell.
   */
  private operation(id: string, done: boolean): unknown {
    const name = `projects/${this.project}/locations/${this.region}/operations/op-${this.nextOperation++}`;
    this.operations.push({ name, done });
    return {
      name,
      done,
      metadata: {
        '@type': 'type.googleapis.com/google.cloud.run.v2.Service',
        target: id,
      },
    };
  }
}

/** The member a real `google.rpc.ErrorInfo` detail identifies itself by. */
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';

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
        details: [{ '@type': ERROR_INFO, reason: 'SERVICE_DISABLED' }],
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
        details: [{ '@type': ERROR_INFO, reason: 'IAM_PERMISSION_DENIED' }],
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
