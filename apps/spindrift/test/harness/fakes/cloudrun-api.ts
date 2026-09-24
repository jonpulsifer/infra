/**
 * The Cloud Run v2, admission-policy and Cloud Scheduler APIs behind the real
 * adapter. A write answers with an `Operation`, readiness arrives on a later
 * read, and a field the v2 schema does not define is refused.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';
import { CLOUD_ENDPOINTS } from '../installation.ts';

export interface RecordedCloudRequest {
  method: string;
  /** Path and query. */
  url: string;
  path: string;
  body: unknown;
}

/** Status fields merged into a resource on its nth read, or `null` for none. */
export type ServiceScript = (reads: number) => Record<string, unknown> | null;

export interface FakeCloudRunOptions {
  readonly project?: string;
  readonly region?: string;
  readonly service?: ServiceScript;
  /** When set, every Cloud Run `PATCH` answers with this. */
  readonly refuse?: { status: number; body: unknown };
  /** When set, listing a collection answers with this. */
  readonly refuseList?: { status: number; body: unknown };
  /** When set, `:setIamPolicy` answers with this. */
  readonly refuseIam?: { status: number; body: unknown };
  /** When set, every Cloud Scheduler request answers with this. */
  readonly refuseScheduler?: { status: number; body: unknown };
  /** The admission policy the project reports; `null` or absent answers 404. */
  readonly admissionPolicy?: Record<string, unknown> | null;
  /**
   * Each Job's existing runs, in the order the API lists them. `executions.list`
   * documents no order, so seed oldest-first to hold an adapter to sorting.
   */
  readonly executions?: Readonly<Record<string, readonly unknown[]>>;
  /**
   * How many reads of a new resource answer 404 before it is visible, 1 by
   * default: it is created behind the `Operation`, so a first deploy's next read
   * loses the race.
   */
  readonly createLatencyReads?: number;
  readonly token?: string;
}

/**
 * `true` accepts anything under a member, an object descends, and a one-element
 * array applies to every element. Google's parsers refuse unlisted members too.
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
 * A Job's inner template: a revision's container one level deeper, without
 * `scaling`, `revision`, `sessionAffinity` or `healthCheckDisabled`.
 */
const TASK_TEMPLATE: ServiceSchema = {
  containers: [CONTAINER],
  volumes: true,
  maxRetries: true,
  timeout: true,
  serviceAccount: true,
  executionEnvironment: true,
  encryptionKey: true,
  vpcAccess: true,
  nodeSelector: true,
  gpuZonalRedundancyDisabled: true,
};

/** A Job's outer template, which holds no container itself. */
const EXECUTION_TEMPLATE: ServiceSchema = {
  labels: true,
  annotations: true,
  parallelism: true,
  taskCount: true,
  template: TASK_TEMPLATE,
  client: true,
  clientVersion: true,
};

const JOB_SCHEMA: ServiceSchema = {
  name: true,
  uid: true,
  generation: true,
  labels: true,
  annotations: true,
  client: true,
  clientVersion: true,
  launchStage: true,
  binaryAuthorization: true,
  template: EXECUTION_TEMPLATE,
  startExecutionToken: true,
  runExecutionToken: true,
};

const SCHEMAS: Record<string, ServiceSchema> = {
  services: SERVICE_SCHEMA,
  jobs: JOB_SCHEMA,
};

/**
 * A Cloud Scheduler v1 `Job`. `pubsubTarget` and `oidcToken` pass the schema but
 * fail {@link FakeCloudRun.tick}, which fires only an `oauthToken` HTTP target.
 */
const SCHEDULER_JOB_SCHEMA: ServiceSchema = {
  name: true,
  description: true,
  schedule: true,
  timeZone: true,
  retryConfig: true,
  attemptDeadline: true,
  pubsubTarget: true,
  appEngineHttpTarget: true,
  httpTarget: {
    uri: true,
    httpMethod: true,
    headers: true,
    body: true,
    oauthToken: { serviceAccountEmail: true, scope: true },
    oidcToken: { serviceAccountEmail: true, audience: true },
  },
};

/** Five unix-cron fields, checked only for shape; the real API parses each. */
const CRON = /^\S+(\s+\S+){4}$/;

/**
 * A bearer token of this prefix plus an email calls as that service account,
 * which is how a scheduled fire differs from the controller.
 */
const SERVICE_ACCOUNT_TOKEN = 'sa:';

const INVOKER = 'roles/run.invoker';

/** `:run` is refused outside this collection. */
const JOBS_COLLECTION = 'jobs';

/** The path of the first member the schema does not name, or `null`. */
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

/** The v2 API rejects labels in these namespaces. */
const RESERVED_LABEL_NAMESPACES = [
  'run.googleapis.com',
  'cloud.googleapis.com',
  'serving.knative.dev',
  'autoscaling.knative.dev',
];

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

/** The default: ready on the second read after apply. */
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
  readonly schedulerEndpoint = CLOUD_ENDPOINTS.scheduler;
  readonly requests: RecordedCloudRequest[] = [];
  readonly operations: { name: string; done: boolean }[] = [];

  /** Keyed by `<collection>/<id>`, since a Service and a Job may share a name. */
  private readonly resources = new Map<string, Record<string, unknown>>();
  /** Scheduler jobs by full resource name, which can equal a Cloud Run Job's. */
  private readonly schedules = new Map<string, Record<string, unknown>>();
  /** `:setIamPolicy` bodies, by `<collection>/<id>`. */
  private readonly policies = new Map<string, unknown>();
  private readonly reads = new Map<string, number>();
  /** 404 reads a just-created resource still owes. */
  private readonly creating = new Map<string, number>();
  private nextOperation = 1;
  private nextRun = 1;
  /** Each Job's runs in list order; `:run` prepends. */
  private readonly executions = new Map<string, unknown[]>();
  private readonly options: FakeCloudRunOptions;

  constructor(options: FakeCloudRunOptions = {}) {
    this.options = options;
    for (const [job, runs] of Object.entries(options.executions ?? {})) {
      this.executions.set(job, [...runs]);
    }
  }

  private parent(): string {
    return `projects/${this.project}/locations/${this.region}`;
  }

  private runsOf(job: string): unknown[] {
    return this.executions.get(job) ?? [];
  }

  get project(): string {
    return this.options.project ?? 'example-vessel';
  }

  get region(): string {
    return this.options.region ?? 'somewhere';
  }

  /** The adapter's token provider, the controller's own token. */
  token = (): string => this.options.token ?? 'federated-token';

  service(id: string): Record<string, unknown> | undefined {
    return this.resources.get(`services/${id}`);
  }

  get serviceCount(): number {
    return [...this.resources.keys()].filter((key) =>
      key.startsWith('services/'),
    ).length;
  }

  job(id: string): Record<string, unknown> | undefined {
    return this.resources.get(`jobs/${id}`);
  }

  policy(id: string): unknown {
    return this.policies.get(`services/${id}`);
  }

  jobPolicy(id: string): unknown {
    return this.policies.get(`jobs/${id}`);
  }

  schedule(id: string): Record<string, unknown> | undefined {
    return this.schedules.get(`${this.parent()}/jobs/${id}`);
  }

  /** Deletes the schedule out of band. */
  deschedule(id: string): void {
    this.schedules.delete(`${this.parent()}/jobs/${id}`);
  }

  scheduled(): string[] {
    return [...this.schedules.keys()].sort();
  }

  /**
   * Fires every scheduler job once through `fetch` as the account it names, so a
   * fire needs `roles/run.invoker` on the Job. Returns statuses in name order.
   */
  async tick(): Promise<number[]> {
    const fired: number[] = [];
    for (const name of this.scheduled()) {
      const job = this.schedules.get(name) as {
        httpTarget?: {
          uri?: string;
          httpMethod?: string;
          oauthToken?: { serviceAccountEmail?: string };
        };
      };
      const target = job.httpTarget;
      if (target?.uri === undefined) {
        fired.push(400);
        continue;
      }
      const response = await this.fetch(
        new Request(target.uri, {
          method: target.httpMethod ?? 'POST',
          headers: {
            authorization: `Bearer ${SERVICE_ACCOUNT_TOKEN}${
              target.oauthToken?.serviceAccountEmail ?? ''
            }`,
          },
        }),
      );
      fired.push(response.status);
    }
    return fired;
  }

  pathsOf(method: string): string[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => request.path);
  }

  fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    // A scheduled `jobs.run` has an empty body, which reads as `null`.
    const sent =
      request.method === 'GET' || request.method === 'DELETE'
        ? ''
        : await request.clone().text();
    const body = sent === '' ? null : (JSON.parse(sent) as unknown);
    this.requests.push({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      body,
    });

    // Only a scheduled fire sets `caller`; every other call is the controller's.
    const authorization = request.headers.get('authorization') ?? '';
    const caller = authorization.startsWith(`Bearer ${SERVICE_ACCOUNT_TOKEN}`)
      ? authorization.slice(`Bearer ${SERVICE_ACCOUNT_TOKEN}`.length)
      : null;
    if (caller === null && authorization !== `Bearer ${this.token()}`) {
      return json(401, { error: { message: 'unauthenticated' } });
    }

    if (url.origin === new URL(this.policyEndpoint).origin) {
      return this.admissionResponse();
    }

    if (url.origin === new URL(this.schedulerEndpoint).origin) {
      return this.schedulerResponse(request.method, url, body);
    }

    const parent = `/v2/projects/${this.project}/locations/${this.region}/`;
    if (!url.pathname.startsWith(parent)) {
      return json(404, {
        error: { message: 'no such path', status: 'NOT_FOUND' },
      });
    }

    // A ref naming the wrong collection 404s instead of reading the other
    // collection's resource of the same name.
    const [collection, ...segments] = url.pathname
      .slice(parent.length)
      .split('/');
    if (collection === undefined || SCHEMAS[collection] === undefined) {
      return json(404, {
        error: { message: 'no such collection', status: 'NOT_FOUND' },
      });
    }

    const rest = segments.join('/');
    if (rest === '') {
      if (this.options.refuseList !== undefined) {
        return json(
          this.options.refuseList.status,
          this.options.refuseList.body,
        );
      }
      return json(200, { [collection]: [...this.held(collection)] });
    }

    // Before the `<name>[:verb]` split, which would read `executions` as a name.
    const runs = rest.match(/^([^/:]+)\/executions$/);
    if (runs !== null) {
      if (request.method !== 'GET') {
        return json(405, {
          error: { message: 'runs are listed, not written' },
        });
      }
      if (!this.resources.has(`${collection}/${runs[1]}`)) {
        return json(404, notFound());
      }
      // `executions.list` documents a page size and no order.
      const page = Number(url.searchParams.get('pageSize') ?? '0');
      const held = this.runsOf(runs[1] as string);
      return json(200, {
        executions: page > 0 ? held.slice(0, page) : held,
      });
    }

    const [name, verb] = rest.split(':', 2);
    if (name === undefined || name === '') return json(404, notFound());
    const key = `${collection}/${name}`;

    // `jobs.run` answers with an `Operation` whose metadata is the new
    // Execution, which then appears in the Job's runs.
    if (verb === 'run') {
      if (collection !== JOBS_COLLECTION || !this.resources.has(key)) {
        return json(404, notFound());
      }
      // The controller holds `roles/run.admin` on the project. Any other caller
      // needs `roles/run.invoker` on this Job's current policy.
      if (caller !== null && !this.mayRun(key, caller)) {
        return json(permissionDenied().status, permissionDenied().body);
      }
      const started = `${name}-${this.nextRun++}`;
      this.executions.set(name, [
        { name: `${this.parent()}/jobs/${name}/executions/${started}` },
        ...this.runsOf(name),
      ]);
      return json(200, {
        name: `${this.parent()}/operations/op-${this.nextOperation++}`,
        done: false,
        metadata: {
          '@type': 'type.googleapis.com/google.cloud.run.v2.Execution',
          name: `${this.parent()}/jobs/${name}/executions/${started}`,
        },
      });
    }

    if (verb === 'setIamPolicy') {
      if (this.options.refuseIam !== undefined) {
        return json(this.options.refuseIam.status, this.options.refuseIam.body);
      }
      // Domain-restricted sharing refuses `allUsers` with this message. Public
      // reach goes through the Service's `invokerIamDisabled` instead.
      const bindings =
        (body as { policy?: { bindings?: { members?: string[] }[] } })?.policy
          ?.bindings ?? [];
      if (bindings.some((binding) => binding.members?.includes('allUsers'))) {
        return json(403, {
          error: {
            status: 'PERMISSION_DENIED',
            message:
              'One or more users named in the policy do not belong to a permitted customer, perhaps due to an organization policy.',
          },
        });
      }
      if (!this.resources.has(key)) return json(404, notFound());
      this.policies.set(key, body);
      return json(200, (body as { policy?: unknown })?.policy ?? {});
    }

    switch (request.method) {
      case 'GET':
        return this.readResponse(key);
      case 'PATCH':
        return this.applyResponse(
          url,
          collection,
          key,
          name,
          body as Record<string, unknown>,
        );
      case 'DELETE':
        if (!this.resources.has(key)) return json(404, notFound());
        this.resources.delete(key);
        this.policies.delete(key);
        this.reads.delete(key);
        this.creating.delete(key);
        return json(200, this.operation(name, true));
      default:
        return json(405, {
          error: { message: `${request.method} is not supported` },
        });
    }
  };

  private mayRun(key: string, serviceAccount: string): boolean {
    const written = this.policies.get(key) as
      | { policy?: { bindings?: { role?: string; members?: string[] }[] } }
      | undefined;
    return (written?.policy?.bindings ?? []).some(
      (binding) =>
        binding.role === INVOKER &&
        (binding.members ?? []).includes(`serviceAccount:${serviceAccount}`),
    );
  }

  /**
   * Cloud Scheduler has no upsert: `jobs.create` answers 409 for an existing name
   * and `jobs.patch` answers 404 for a missing one.
   */
  private schedulerResponse(method: string, url: URL, body: unknown): Response {
    if (this.options.refuseScheduler !== undefined) {
      return json(
        this.options.refuseScheduler.status,
        this.options.refuseScheduler.body,
      );
    }
    const parent = `/v1/${this.parent()}/jobs`;
    const addressed = url.pathname.startsWith(`${parent}/`)
      ? url.pathname.slice('/v1/'.length)
      : null;
    if (method === 'DELETE') {
      if (addressed === null || !this.schedules.has(addressed)) {
        return json(404, notFound());
      }
      this.schedules.delete(addressed);
      return json(200, {});
    }
    // Never scheduled and deleted out of band both answer 404, as they do live.
    if (method === 'GET') {
      const held =
        addressed === null ? undefined : this.schedules.get(addressed);
      return held === undefined
        ? json(404, notFound())
        : json(200, { ...held, state: 'ENABLED' });
    }
    // `patch` addresses the job and `create` addresses its parent.
    if (method === 'PATCH') {
      if (addressed === null || !this.schedules.has(addressed)) {
        return json(404, notFound());
      }
    } else if (method !== 'POST' || url.pathname !== parent) {
      return json(404, notFound());
    }

    const document = body as Record<string, unknown>;
    const unknown = unknownMember(document, SCHEDULER_JOB_SCHEMA);
    if (unknown !== null) {
      return json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `Invalid JSON payload received. Unknown name "${unknown}" at 'job'.`,
        },
      });
    }
    const name = document.name;
    if (
      typeof name !== 'string' ||
      !name.startsWith(`${this.parent()}/jobs/`)
    ) {
      return json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'the job name must be under the parent it is created in',
        },
      });
    }
    if (method === 'POST' && this.schedules.has(name)) {
      return json(409, {
        error: { code: 409, status: 'ALREADY_EXISTS', message: 'job exists' },
      });
    }
    if (
      typeof document.schedule !== 'string' ||
      !CRON.test(document.schedule)
    ) {
      return json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `"${String(document.schedule)}" is not a valid cron expression`,
        },
      });
    }
    this.schedules.set(name, document);
    return json(200, { ...document, state: 'ENABLED' });
  }

  private held(collection: string): Record<string, unknown>[] {
    return [...this.resources]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, held]) => held);
  }

  private admissionResponse(): Response {
    const policy = this.options.admissionPolicy;
    if (policy === undefined || policy === null) return json(404, notFound());
    return json(200, policy);
  }

  private readResponse(key: string): Response {
    // The resource is created behind its `Operation`, so an early read 404s.
    const owed = this.creating.get(key) ?? 0;
    if (owed > 0) {
      this.creating.set(key, owed - 1);
      return json(404, notFound());
    }
    const held = this.resources.get(key);
    if (held === undefined) return json(404, notFound());

    // The terminal condition arrives after the resource exists, so `apply` polls.
    const script = this.options.service ?? READY;
    const reads = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, reads);
    const status = script(reads);
    return json(200, status === null ? held : { ...held, ...status });
  }

  private applyResponse(
    url: URL,
    collection: string,
    key: string,
    name: string,
    document: Record<string, unknown>,
  ): Response {
    if (this.options.refuse !== undefined) {
      return json(this.options.refuse.status, this.options.refuse.body);
    }
    // A masked write replaces only the named fields. Any template change is a
    // new revision, so the read count starts over.
    const mask = url.searchParams.get('updateMask');
    if (mask !== null) {
      const held = this.resources.get(key);
      if (held === undefined) return json(404, notFound());
      const rejected = this.schemaProblem(collection, document);
      if (rejected !== null) return rejected;
      const merged = structuredClone(held);
      for (const path of mask.split(',')) {
        const segments = path.split('.');
        setPath(merged, segments, getPath(document, segments));
      }
      this.resources.set(key, merged);
      this.reads.set(key, 0);
      return json(200, this.operation(name, false));
    }
    // Only `allowMissing=true` lets a `PATCH` create.
    if (
      !this.resources.has(key) &&
      url.searchParams.get('allowMissing') !== 'true'
    ) {
      return json(404, notFound());
    }
    const rejected = this.schemaProblem(collection, document);
    if (rejected !== null) return rejected;

    const creating = !this.resources.has(key);
    const stored = {
      ...document,
      name,
      // Only a Service is addressable.
      ...(collection === 'services'
        ? { uri: `https://${name}.run.example.test` }
        : {}),
    };
    this.resources.set(key, stored);
    this.reads.set(key, 0);
    if (creating) {
      this.creating.set(key, this.options.createLatencyReads ?? 1);
    }
    return json(200, this.operation(name, false));
  }

  /** Why the API would refuse this document, or `null` if it would not. */
  private schemaProblem(
    collection: string,
    document: Record<string, unknown>,
  ): Response | null {
    const job = collection === 'jobs';
    const unknown = unknownMember(
      document,
      SCHEMAS[collection] as ServiceSchema,
    );
    if (unknown !== null) {
      return json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `Invalid JSON payload received. Unknown name "${unknown}" at '${job ? 'job' : 'service'}'.`,
        },
      });
    }
    const template = document.template as
      | { labels?: unknown }
      | undefined
      | null;
    const label =
      labelProblem(document.labels, job ? 'job' : 'service') ??
      labelProblem(
        template?.labels,
        job ? 'execution template' : 'revision template',
      );
    if (label !== null) {
      return json(400, {
        error: { code: 400, status: 'INVALID_ARGUMENT', message: label },
      });
    }
    return null;
  }

  /** A real operation always carries the `name` it is polled by. */
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

function getPath(object: unknown, segments: readonly string[]): unknown {
  return segments.reduce<unknown>(
    (value, segment) =>
      (value as Record<string, unknown> | undefined)?.[segment],
    object,
  );
}

function setPath(
  object: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    object[head] = value;
    return;
  }
  const held = object[head];
  const next =
    typeof held === 'object' && held !== null
      ? (held as Record<string, unknown>)
      : {};
  object[head] = next;
  setPath(next, rest, value);
}

/** The `@type` of a `google.rpc.ErrorInfo` detail. */
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';

function notFound(): unknown {
  return { error: { message: 'not found', status: 'NOT_FOUND' } };
}

/**
 * The API is switched off in the project. It serves every API here: the adapter
 * reads the ErrorInfo `reason`, which is the same whichever service is off.
 */
export function serviceDisabled(consumer?: string): {
  status: number;
  body: unknown;
} {
  return {
    status: 403,
    body: {
      error: {
        message: 'this API has not been used in this project',
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': ERROR_INFO,
            reason: 'SERVICE_DISABLED',
            // The consumer project, which may differ from the one in the URL.
            ...(consumer === undefined
              ? {}
              : { metadata: { consumer: `projects/${consumer}` } }),
          },
        ],
      },
    },
  };
}

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
