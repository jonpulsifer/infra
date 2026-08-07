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
 *   INVALID_ARGUMENT`, and the rendered document is the single thing standing
 *   between this product and a Cloud Run deploy — a `Map.set` is not a check.
 *   There is a schema per collection, and they differ in the ways that bite: a
 *   `Job` has no `ingress`, and it wraps its container one level deeper than a
 *   `Service` does.
 * - **A refusal carries a body with a machine-readable reason**, because the
 *   checklist tells "the service is off" from "you may not" from "there is no
 *   such project" by exactly that, and a bare status code would leave nothing to
 *   tell them apart with.
 * - **The IAM policy is a resource that can be read back**, so a test can assert
 *   §9's fail-closed ordering rather than only that a call was made.
 * - **The admission policy lives at its own endpoint**, which is how a Target
 *   that names none is distinguishable from one whose policy admits everything.
 * - **Cloud Scheduler is a third API in the same project**, because what fires a
 *   Job is not the runtime. It is here rather than in a fake of its own for the
 *   reason {@link FakeCloudRun.tick} exists: the only interesting thing about a
 *   scheduler job is whether the call it makes is *admitted*, and answering that
 *   needs the Job's IAM policy — which lives here.
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
  /** When set, every Cloud Scheduler write is refused with this. */
  readonly refuseScheduler?: { status: number; body: unknown };
  /** The admission policy this project reports, or `null` for none at all. */
  readonly admissionPolicy?: Record<string, unknown> | null;
  /**
   * Runs each Job already has, by job id, **in the order the API will list
   * them**.
   *
   * Seeded rather than only produced by `:run`, because most of a job's history
   * was written before Spindrift asked for anything — a fake that could only
   * report what this process started could not test reading one at all.
   *
   * The order is the seeder's because `executions.list` documents none and
   * takes no `orderBy`. Seed oldest-first to hold an adapter to sorting what it
   * read rather than trusting the page it was handed.
   */
  readonly executions?: Readonly<Record<string, readonly unknown[]>>;
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
 * `TaskTemplate` — the inner half of a Job's doubled template.
 *
 * The container is the same message a revision holds, which is the point: the
 * two documents differ in how deeply they wrap it and in nothing else. Note
 * what is *not* here that `REVISION_TEMPLATE` has — `scaling`, `revision`,
 * `sessionAffinity`, `healthCheckDisabled` — and note that `Job` has no
 * `ingress` at all. Those absences are the whole value of a closed schema: a
 * renderer that reached for a Service concept is refused here rather than in a
 * vessel.
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

/** `ExecutionTemplate` — the outer half, which holds no container itself. */
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

/** The two collections a v2 path can name, and what each one accepts. */
const SCHEMAS: Record<string, ServiceSchema> = {
  services: SERVICE_SCHEMA,
  jobs: JOB_SCHEMA,
};

/**
 * A Cloud Scheduler v1 `Job`, closed the same way and for the same reason.
 *
 * Note the two targets that are here and unused: `pubsubTarget` and
 * `oidcToken`. They are the shapes a renderer might reach for by analogy — one
 * fires a topic rather than a Job, and the other authenticates to an endpoint
 * that verifies an audience rather than to an API that verifies a permission —
 * so a document naming them is accepted by the schema and then fails
 * {@link FakeCloudRun.tick}, which is where the mistake actually shows.
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

/**
 * A unix-cron expression, as loosely as this needs to check one.
 *
 * Five whitespace-separated fields. The real API parses each of them and
 * refuses `400 INVALID_ARGUMENT` for a field it cannot read; what matters here
 * is only that a schedule reaches the far side as a schedule rather than as
 * something the adapter mangled on the way.
 */
const CRON = /^\S+(\s+\S+){4}$/;

/**
 * How this fake is told a call is being made by a service account.
 *
 * The controller's own token is the one every other call carries. A scheduled
 * fire is made by a *different* identity — the account the scheduler job names
 * — which is the whole thing criterion "on the Job and on nothing wider" is
 * about, so it has to be distinguishable here or the IAM policy is decoration.
 */
const SERVICE_ACCOUNT_TOKEN = 'sa:';

/** The one role that lets an identity run a Job. */
const INVOKER = 'roles/run.invoker';

/** The one collection that has runs. Named, because `:run` is refused elsewhere. */
const JOBS_COLLECTION = 'jobs';

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
  readonly schedulerEndpoint = CLOUD_ENDPOINTS.scheduler;
  readonly requests: RecordedCloudRequest[] = [];
  /** Every Operation a write answered with, in order — what a poll would use. */
  readonly operations: { name: string; done: boolean }[] = [];

  /**
   * What this project holds, by `<collection>/<id>`.
   *
   * Keyed by both because a Service and a Job may share a name: they are
   * separate collections in the same project, and a fake that collapsed them
   * would hide exactly the case `parseRef` exists to get right.
   */
  private readonly resources = new Map<string, Record<string, unknown>>();
  /**
   * What Cloud Scheduler holds, by full resource name.
   *
   * A separate map rather than a third collection in `resources`, because it is
   * a separate *service*: a scheduler job and a Cloud Run Job share a resource
   * name, and collapsing them would hide the one interesting property of that
   * — that the same string addresses two things.
   */
  private readonly schedules = new Map<string, Record<string, unknown>>();
  /** Invoker policies, by `<collection>/<id>` — the surface for exposure. */
  private readonly policies = new Map<string, unknown>();
  private readonly reads = new Map<string, number>();
  /** Reads a just-created Service still owes before it can be seen. */
  private readonly creating = new Map<string, number>();
  private nextOperation = 1;
  private nextRun = 1;
  /** Each Job's runs, in list order — the sub-collection `:run` prepends to. */
  private readonly executions = new Map<string, unknown[]>();
  private readonly options: FakeCloudRunOptions;

  constructor(options: FakeCloudRunOptions = {}) {
    this.options = options;
    for (const [job, runs] of Object.entries(options.executions ?? {})) {
      this.executions.set(job, [...runs]);
    }
  }

  /** `projects/<p>/locations/<r>` — what every name here hangs off. */
  private parent(): string {
    return `projects/${this.project}/locations/${this.region}`;
  }

  /** The runs one Job holds, in the order this fake will list them. */
  private runsOf(job: string): unknown[] {
    return this.executions.get(job) ?? [];
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
    return this.resources.get(`services/${id}`);
  }

  /** The same, for the other collection. */
  job(id: string): Record<string, unknown> | undefined {
    return this.resources.get(`jobs/${id}`);
  }

  /** The invoker policy written for one Service, if any was. */
  policy(id: string): unknown {
    return this.policies.get(`services/${id}`);
  }

  /** The same, for a Job — which is where a schedule's grant lands. */
  jobPolicy(id: string): unknown {
    return this.policies.get(`jobs/${id}`);
  }

  /** The Cloud Scheduler job standing in front of one Job, if any is. */
  schedule(id: string): Record<string, unknown> | undefined {
    return this.schedules.get(`${this.parent()}/jobs/${id}`);
  }

  /** Somebody deleted the schedule out of band and told nobody. */
  deschedule(id: string): void {
    this.schedules.delete(`${this.parent()}/jobs/${id}`);
  }

  /** Every scheduler job in the project, by name — nothing should be orphaned. */
  scheduled(): string[] {
    return [...this.schedules.keys()].sort();
  }

  /**
   * Let every scheduler job fire once, the way Cloud Scheduler would.
   *
   * The point is not that the fake can call itself: it is that the call goes
   * through the same `fetch` as everything else, carrying **the identity the
   * scheduler job names** rather than the controller's token. So a fire is
   * admitted only if that account holds `roles/run.invoker` on that Job — which
   * makes the IAM policy the adapter writes load-bearing instead of decorative,
   * and makes an execution here mean the same thing it means in a vessel:
   * something ran that nobody asked for by hand.
   *
   * Returns each fire's status, in scheduler-job name order.
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

  /** Requests the adapter made, in order — what § Seam 2 asserts on. */
  pathsOf(method: string): string[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => request.path);
  }

  fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    // A POST with no body at all is legal and is what `jobs.run` is fired with
    // — the scheduler sends no overrides. Read as text first so that an empty
    // body is `null` rather than a parse error thrown out of the transport.
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

    // Who is calling. Almost always the controller, holding the token §13's
    // federation minted; a scheduled fire is the one call made by somebody
    // else, and `tick` says so in the header rather than by being let in
    // through a side door.
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

    // The collection is part of the path rather than a mode this fake is put
    // into, because that is what it is on the real API — and because a ref that
    // named the wrong one has to reach a 404 here rather than silently reading
    // the other collection's resource of the same name.
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

    // A Job's runs are a sub-collection rather than a resource of their own,
    // so they are routed before the `<name>[:verb]` split — which would
    // otherwise read `jobs/<id>/executions` as a resource nobody named.
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
      // `pageSize` is honoured and the order is whatever this fake was seeded
      // with, because that is what `executions.list` documents: a page size and
      // no ordering at all. An adapter that asks for ten and trusts them to be
      // the newest ten is right only by luck, and a fake that always answered
      // newest-first is a fake that makes that luck look like a guarantee.
      const page = Number(url.searchParams.get('pageSize') ?? '0');
      const held = this.runsOf(runs[1] as string);
      return json(200, {
        executions: page > 0 ? held.slice(0, page) : held,
      });
    }

    const [name, verb] = rest.split(':', 2);
    if (name === undefined || name === '') return json(404, notFound());
    const key = `${collection}/${name}`;

    // `jobs.run` is the runtime's own verb: it answers with an `Operation`
    // whose metadata **is** the Execution being created, and the execution
    // appears in the job's sub-collection behind it. A fake that only answered
    // the call would let an adapter that never read the name back pass.
    if (verb === 'run') {
      if (collection !== JOBS_COLLECTION || !this.resources.has(key)) {
        return json(404, notFound());
      }
      // The controller holds `roles/run.admin` on the project, which carries
      // this. Every other identity has to have been granted it **on this Job**,
      // which is what makes a schedule that was removed stop firing even if
      // something still calls: the binding is what the policy says now, not
      // what it said when the scheduler job was written.
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

  /** Whether one service account may run one Job, per that Job's own policy. */
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
   * Cloud Scheduler, as much of it as an adapter that creates, updates and
   * deletes needs.
   *
   * **No create-or-update, deliberately.** The real `jobs.create` refuses a
   * name that already exists with `409 ALREADY_EXISTS` and the real
   * `jobs.patch` refuses one that does not with `404`, and modelling both is
   * what keeps an adapter honest about the fact that this API has no upsert —
   * one that assumed otherwise would pass here and leave a Component's second
   * deploy silently on its first schedule.
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
    // What `observe` asks, and the only read this API serves. A job that was
    // never scheduled and one whose scheduler job was deleted answer the same
    // `404` here — which is the point: the API cannot tell them apart either.
    if (method === 'GET') {
      const held =
        addressed === null ? undefined : this.schedules.get(addressed);
      return held === undefined
        ? json(404, notFound())
        : json(200, { ...held, state: 'ENABLED' });
    }
    // `patch` addresses the job and `create` addresses its parent — the only
    // difference between the two, other than which of them refuses.
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

  /** Everything stored in one collection. */
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
    // The resource is created *behind* the Operation the write returned, so for
    // a while after a create it is genuinely not there yet. `read()` must map
    // that to "still applying" rather than to a failure.
    const owed = this.creating.get(key) ?? 0;
    if (owed > 0) {
      this.creating.set(key, owed - 1);
      return json(404, notFound());
    }
    const held = this.resources.get(key);
    if (held === undefined) return json(404, notFound());

    // The runtime writes the terminal condition *after* the resource exists,
    // which is what makes `apply` poll rather than assume.
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
    // `allowMissing` is what makes the adapter's one call create-or-update. A
    // fake that created regardless would let the adapter drop the parameter
    // and still pass, so the refusal is modelled rather than assumed.
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
      // Only a Service is addressable. A fake that minted a `uri` for a Job
      // would hand the adapter a URL for something nothing routes to, and the
      // one assertion that a job reports no address would pass for the wrong
      // reason.
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

/**
 * A refusal because the service is switched off in this project.
 *
 * One definition for both APIs this fake stands in for, because what the
 * adapter reads is the ErrorInfo `reason` and that is identical whichever
 * service is off — the human message is the part that names one, and no test
 * reads it.
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
            // ErrorInfo names the project whose switch is off — the call's
            // consumer, which is not necessarily the project in the URL.
            ...(consumer === undefined
              ? {}
              : { metadata: { consumer: `projects/${consumer}` } }),
          },
        ],
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
