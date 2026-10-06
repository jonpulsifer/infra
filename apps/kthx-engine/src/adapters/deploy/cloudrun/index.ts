/**
 * The Cloud Run deploy adapter. A `service` or `website` is a Service, a `job`
 * a Job, and a schedule is a Cloud Scheduler job sharing the Job's name. It
 * takes images only, never a source archive the runtime would build itself.
 */
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import type {
  PolicyEngineState,
  TargetDiscovery,
  TargetInspection,
} from '../../../domain/capabilities.ts';
import {
  type ArtifactType,
  artifactAddress,
  type DesiredState,
} from '../../../domain/desired-state.ts';
import {
  type CloudRunAdapterConnection,
  targetLabel,
} from '../../../domain/target.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import { cloudChecklist, cloudSurfaceProbe } from '../cloud/checklist.ts';
import { CloudHttp, type Fetcher, type TokenProvider } from '../cloud/http.ts';
import { cloudWriteFailure, orderedChecklist } from '../cloud/verdict.ts';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  JobExecution,
  JobRuns,
  ObservedState,
  Restarted,
  RunOptions,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
  StartedRun,
} from '../contract.ts';
import { RESTART_STAMP } from '../contract.ts';
import { type DeployEvents, deployEvents, internalFailure } from '../events.ts';
import { parseScopedRef, scopedRef } from '../ref.ts';
import { cloudRunJob } from './job.ts';
import {
  type CloudLogPage,
  cloudLogCursor,
  cloudLogRecord,
  encodeCloudLogCursor,
} from './logs.ts';
import { cloudSchedulerJob, jobInvokerPolicy, TIME_ZONE } from './scheduler.ts';
import {
  allowsUnauthenticated,
  CLOSED_INVOKER_POLICY,
  cloudRunService,
  type InvokerPolicy,
  workloadId,
} from './service.ts';
import {
  type CloudRunStatus,
  type CloudRunWorkload,
  cloudRunStatus,
  servingDigest,
} from './status.ts';

export interface CloudRunAdapterOptions {
  /** Mints a bearer per request, never stored. */
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
  /** While an attempt is in flight. */
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT`. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Cloud Logging API root; injectable for perimeter endpoints and tests. */
  readonly logsEndpoint?: string;
  /** Cloud Scheduler API root, the same for every project. Set only by tests. */
  readonly schedulerEndpoint?: string;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_LOGS_ENDPOINT = 'https://logging.googleapis.com';
const DEFAULT_SCHEDULER_ENDPOINT = 'https://cloudscheduler.googleapis.com';
/**
 * One Cloud Run control plane serves every project. A Target's own `endpoint`
 * only overrides it, for a perimeter or a mirror.
 */
export const DEFAULT_ENDPOINT = 'https://run.googleapis.com';
const SERVICE_ID_LIMIT = 63;

/** A Component's kind picks one at `apply`, and the ref carries it after. */
const SERVICES = 'services';
const JOBS = 'jobs';
type Collection = typeof SERVICES | typeof JOBS;

const EXECUTIONS = 'executions';

/**
 * A job's log entries are typed `cloud_run_job` and keyed on `job_name`, so no
 * revision filter matches them.
 */
const JOB_RESOURCE = 'cloud_run_job';
const SERVICE_RESOURCE = 'cloud_run_revision';
const EXECUTION_LABEL = 'run.googleapis.com/execution_name';

const DEFAULT_EXECUTION_PAGE = 20;

/**
 * `executions.list` has no order or `orderBy`, so ask far past any page shown
 * and sort; the API clamps `pageSize`.
 *
 * ponytail: a job with more runs than this still hides its newest if the API
 * pages oldest-first. Follow `nextPageToken` if that ever matters.
 */
const EXECUTION_PAGE_ASKED = 100;

const SERVICE_NAME = 'Cloud Run';

const SERVICE_DISABLED = 'SERVICE_DISABLED';

/**
 * No call reports it, and an empty `arch` would let placement put an `arm64`
 * build here.
 */
const RUNTIME_ARCH = ['amd64'] as const;

/**
 * The runtime's documented per-workload limits. A project's own quota is lower
 * and unreadable here, so a workload under this may still be refused.
 */
const RESOURCE_CEILING = { cpu: '8', memory: '32Gi' } as const;

/** The one store a Cloud Run revision can resolve a reference from natively. */
const NATIVE_STORE: readonly StoreAdapter[] = ['gcp-secret-manager'];

/** The binary authorization policy fields this adapter reads. */
interface AdmissionPolicy {
  readonly globalPolicyEvaluationMode?: string;
  readonly defaultAdmissionRule?: {
    readonly evaluationMode?: string;
    readonly enforcementMode?: string;
  };
}

/** The one enforcement mode that blocks; the dry run only logs. */
const BLOCKING = 'ENFORCED_BLOCK_AND_AUDIT_LOG';
/** Verifies nothing, whatever the enforcement mode. */
const VERIFIES_NOTHING = 'ALWAYS_ALLOW';

export class CloudRunDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'cloudrun';
  readonly artifactTypes: readonly ArtifactType[] = ['image'];

  private readonly events: DeployEvents;

  constructor(private readonly options: CloudRunAdapterOptions) {
    this.events = deployEvents(options.now);
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return internalFailure('this Target is not a Cloud Run Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `cloudrun does not accept a ${desired.artifact.type} artifact`,
      );
    }
    const image = artifactAddress(
      desired.artifact,
      connection.reachableRegistries ?? [],
    );
    if (image === null) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        'the artifact carries no address this Target can pull it by',
      );
    }

    const job = desired.kind === 'job';
    // The job's schedule, or `null` for anything else: only a job has one.
    const fires = job ? (desired.schedule ?? null) : null;
    // Cloud Scheduler authenticates its `jobs.run` call, so a schedule with no
    // identity would be refused on every tick while the Component reads LIVE.
    if (fires !== null && connection.serviceAccount === undefined) {
      yield this.events.status('FAILED', { reason: 'REJECTED' });
      return {
        phase: 'FAILED',
        reason: 'REJECTED',
        detail:
          'this Target names no runtime identity for a schedule to fire as',
      };
    }

    const id = workloadId(desired);
    const collection = job ? JOBS : SERVICES;
    const ref = refOf(connection, collection, id);
    const http = this.http(connection);

    yield this.events.status('APPLYING', { resource: id });

    // Removed before the Job is written, so an old cadence never fires the new
    // template. Asserted every time: this adapter keeps no memory of deploys.
    if (job && fires === null) {
      const stopped = await this.unschedule(connection, id);
      if (stopped !== null) {
        // Not fatal: most jobs never had a schedule, and the empty invoker
        // policy written below stops a leftover one from running anything.
        yield this.events.log(
          `${stopped.detail ?? `the schedule on job ${id} could not be removed`} — this Component declares none, so the deploy continues and the grant below is what stops it firing`,
          id,
        );
      }
    }

    // Tightened before the rollout, so a new revision is never up under the old
    // reach. Public reach is `invokerIamDisabled` in the document itself.
    if (!job && !allowsUnauthenticated(desired.reach, desired.auth)) {
      const tightened = await this.setInvoker(
        http,
        connection,
        SERVICES,
        id,
        CLOSED_INVOKER_POLICY,
        `{reach: ${desired.reach}, auth: ${desired.auth}}`,
      );
      if (tightened !== null) {
        yield this.events.status('FAILED', {
          resource: id,
          reason: tightened.reason,
        });
        return { ...tightened, ref };
      }
    }

    const render = {
      project: connection.project,
      image,
      serviceAccount: connection.serviceAccount ?? null,
      // A Target naming a policy endpoint has an admission policy its workloads
      // must submit to, Jobs as well as Services.
      useProjectAdmissionPolicy: connection.policyEndpoint !== undefined,
    };
    const document = job
      ? cloudRunJob(desired, render)
      : cloudRunService(desired, render);
    const applied = await http.json<unknown>({
      method: 'PATCH',
      path: `/v2/${parentOf(connection)}/${collection}/${encodeURIComponent(id)}`,
      // Create-or-update in one call, which keeps `apply` idempotent.
      query: { allowMissing: 'true' },
      body: document,
    });
    if (!applied.ok) {
      const verdict = cloudWriteFailure(applied, ref);
      yield this.events.status('FAILED', {
        resource: id,
        reason: verdict.reason,
      });
      return verdict;
    }
    yield this.events.log(`applied ${job ? 'job' : 'service'} ${id}`, id);

    const verdict = yield* this.awaitVerdict(
      http,
      connection,
      collection,
      id,
      ref,
    );
    if (verdict.phase !== 'LIVE') return verdict;

    if (job) {
      // Written on every deploy, granting the scheduler's identity or nobody,
      // so a grant never outlives the schedule that justified it.
      const bound = await this.setInvoker(
        http,
        connection,
        JOBS,
        id,
        jobInvokerPolicy(
          fires === null ? null : (connection.serviceAccount ?? null),
        ),
        'this job',
      );
      if (bound !== null) {
        yield this.events.status('FAILED', {
          resource: id,
          reason: bound.reason,
        });
        return { ...bound, ref };
      }
      if (fires === null) return verdict;

      // Last, so the binding it fires with is in place for the first tick.
      const scheduled = await this.schedule(connection, id, fires, ref);
      if (scheduled !== null) {
        // Revoke the unused grant: the runtime account is shared across the
        // vessel. Best effort, so the verdict stays about the schedule.
        await this.setInvoker(
          http,
          connection,
          JOBS,
          id,
          jobInvokerPolicy(null),
          'this job',
        );
        yield this.events.status('FAILED', {
          resource: id,
          reason: scheduled.reason,
        });
        return { ...scheduled, ref };
      }
      yield this.events.log(
        `firing job ${id} on "${fires}" (${TIME_ZONE})`,
        id,
      );
      return verdict;
    }

    // Asserted on every exposure now that the Service exists. On a public
    // Service the empty policy strips any stale `allUsers` binding.
    const written = await this.setInvoker(
      http,
      connection,
      SERVICES,
      id,
      CLOSED_INVOKER_POLICY,
      `{reach: ${desired.reach}, auth: ${desired.auth}}`,
    );
    if (written !== null) {
      yield this.events.status('FAILED', {
        resource: id,
        reason: written.reason,
      });
      return { ...written, ref };
    }
    return verdict;
  }

  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const placed = parseRef(connection, ref);
    if (placed === null) return null;

    const read = await this.read(
      this.http(connection),
      connection,
      placed.collection,
      placed.id,
    );
    if (read === null) return null;

    const status = cloudRunStatus(read);
    // Read for every job: only core knows whether an absent schedule is right.
    //
    // ponytail: one Cloud Scheduler GET per job per drift pass. Pass the
    // desired cadence to `observe` if a vessel ever holds enough jobs.
    const schedule =
      placed.collection === JOBS
        ? await this.observeSchedule(connection, placed.id)
        : undefined;
    return {
      ref,
      phase: status.phase,
      artifactDigest: servingDigest(read),
      // Omitted, not `undefined`: absent is a third state on this field.
      ...(schedule === undefined ? {} : { schedule }),
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const placed = parseRef(connection, ref);
    if (placed === null) return;

    const { collection, id } = placed;
    const noun = collection === JOBS ? 'job' : 'service';
    // The schedule first, so nothing fires at a Job that is already gone.
    if (collection === JOBS) {
      const stopped = await this.unschedule(connection, id);
      if (stopped !== null) {
        throw new Error(
          stopped.detail ?? `the schedule on job ${id} could not be removed`,
        );
      }
    }
    const deleted = await this.http(connection).json<unknown>({
      method: 'DELETE',
      path: `/v2/${parentOf(connection)}/${collection}/${encodeURIComponent(id)}`,
    });
    // Destroying what is already gone succeeds. Anything else is raised, so no
    // Service is orphaned silently.
    if (deleted.ok) return;
    if (deleted.kind === 'status' && deleted.status === 404) return;
    throw new Error(
      deleted.kind === 'status'
        ? `deleting ${noun} ${id} failed with ${deleted.status}: ${deleted.message}`
        : `deleting ${noun} ${id} failed: ${deleted.message}`,
    );
  }

  async tail(
    target: DeployTarget,
    subject: RuntimeLogSubject,
    options: RuntimeLogTailOptions = {},
  ): Promise<RuntimeLogPage> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return { kind: 'stream', entries: [], cursor: null, reach: 0 };
    }
    const after = cloudLogCursor(options.after);
    const id = workloadName(subject, SERVICE_ID_LIMIT);
    // A run's entries are keyed on the Job and labelled with the execution, so
    // naming one narrows the filter to that run.
    const run = subject.execution;
    const response = await new CloudHttp({
      baseUrl: this.options.logsEndpoint ?? DEFAULT_LOGS_ENDPOINT,
      token: this.options.token,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }).json<CloudLogPage>({
      method: 'POST',
      path: '/v2/entries:list',
      body: {
        resourceNames: [`projects/${connection.project}`],
        filter: [
          `resource.type="${run === undefined ? SERVICE_RESOURCE : JOB_RESOURCE}"`,
          run === undefined
            ? `resource.labels.service_name="${id}"`
            : `resource.labels.job_name="${id}"`,
          `resource.labels.location="${connection.region}"`,
          ...(run === undefined
            ? []
            : [`labels."${EXECUTION_LABEL}"="${run}"`]),
          ...(after === null ? [] : [`timestamp>="${after.at}"`]),
        ].join(' AND '),
        orderBy: 'timestamp asc',
        pageSize: options.limit ?? 200,
      },
    });
    if (!response.ok) {
      throw new Error(`Cloud Logging read failed: ${response.message}`);
    }
    const records = (response.value.entries ?? [])
      .map(cloudLogRecord)
      .filter((record) => record !== null)
      .sort((left, right) =>
        left.at === right.at
          ? left.insertId.localeCompare(right.insertId)
          : left.at.localeCompare(right.at),
      )
      .filter(
        (record) =>
          after === null ||
          record.at > after.at ||
          (record.at === after.at && record.insertId > after.insertId),
      );
    const entries = records.map((record) => ({
      cursor: encodeCloudLogCursor(record),
      at: new Date(record.at),
      line: record.line,
      replica: record.replica,
    }));
    return {
      kind: 'stream',
      entries,
      cursor: entries.at(-1)?.cursor ?? options.after ?? null,
      reach: connection.logHistorySeconds ?? 0,
    };
  }

  /**
   * `jobs.run`, the verb a schedule fires too, so both kinds of run share one
   * history. The runtime names the execution, in the operation's `metadata`.
   * Parameters are unnamed env overrides, applied to the Job's one container.
   */
  async run(
    target: DeployTarget,
    ref: DeployRef,
    options: RunOptions = {},
  ): Promise<StartedRun> {
    const placed = this.placedJob(target, ref);
    if (placed.kind === 'none') return placed;

    const env = Object.entries(options.env ?? {}).map(([name, value]) => ({
      name,
      value,
    }));
    const started = await this.http(placed.connection).json<CloudOperation>({
      method: 'POST',
      path: `${placed.path}:run`,
      body:
        env.length === 0
          ? {}
          : { overrides: { containerOverrides: [{ env }] } },
    });
    if (!started.ok) {
      throw new Error(`running job ${placed.id} failed: ${started.message}`);
    }
    const name = started.value?.metadata?.name;
    return {
      kind: 'started',
      execution: {
        // The runtime may not have named the execution yet. The Job's id
        // stands in until `executions` is next read.
        name: name === undefined ? placed.id : shortName(name),
        outcome: 'running',
        startedAt: null,
      },
    };
  }

  /**
   * The runtime has no restart verb, so only {@link RESTART_STAMP} is written,
   * under an `updateMask`, and the runtime copies the rest into a new revision.
   * A job is refused: it has runs, not a process.
   */
  async restart(target: DeployTarget, ref: DeployRef): Promise<Restarted> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return {
        kind: 'none',
        because: `${targetLabel(target)} is not a Cloud Run Target`,
      };
    }
    const placed = parseRef(connection, ref);
    if (placed === null) {
      return {
        kind: 'none',
        because: 'this Deploy carries no handle on what it placed here',
      };
    }
    if (placed.collection === JOBS) {
      return {
        kind: 'none',
        because:
          'this ref names a job, which has runs rather than a process to restart',
      };
    }
    const http = this.http(connection);
    const path = `/v2/${parentOf(connection)}/${SERVICES}/${encodeURIComponent(placed.id)}`;
    // Not through `read`, which folds every failure into nothing there. Only a
    // 404 means that; any other failure is thrown.
    const read = await http.json<CloudRunWorkload>({ method: 'GET', path });
    if (!read.ok) {
      if (read.kind === 'status' && read.status === 404) {
        return {
          kind: 'none',
          because: `${placed.id} is no longer on this Target`,
        };
      }
      throw new Error(`reading service ${placed.id} failed: ${read.message}`);
    }

    const at = new Date(this.events.now()).toISOString();
    const annotations = (
      read.value?.template as
        | { annotations?: Record<string, string> }
        | undefined
    )?.annotations;
    const written = await http.json<unknown>({
      method: 'PATCH',
      path,
      query: { updateMask: 'template.annotations' },
      body: {
        template: { annotations: { ...annotations, [RESTART_STAMP]: at } },
      },
    });
    if (!written.ok) {
      throw new Error(
        `restarting service ${placed.id} failed: ${written.message}`,
      );
    }
    return {
      kind: 'restarted',
      detail: `service ${placed.id} stamped ${RESTART_STAMP}=${at}; a new revision of the same image is rolling out`,
    };
  }

  /** Newest first. */
  async executions(
    target: DeployTarget,
    ref: DeployRef,
    limit = DEFAULT_EXECUTION_PAGE,
  ): Promise<JobRuns> {
    const placed = this.placedJob(target, ref);
    if (placed.kind === 'none') return placed;

    const read = await this.http(placed.connection).json<CloudExecutionPage>({
      method: 'GET',
      path: `${placed.path}/${EXECUTIONS}`,
      query: { pageSize: String(EXECUTION_PAGE_ASKED) },
    });
    if (!read.ok) {
      throw new Error(
        `reading the runs of job ${placed.id} failed: ${read.message}`,
      );
    }
    // Sort before slicing: the API returns runs in no documented order.
    return {
      kind: 'executions',
      executions: (read.value?.executions ?? [])
        .map(cloudRunExecution)
        .sort((left, right) => startedAtOf(right) - startedAtOf(left))
        .slice(0, Math.max(1, limit)),
    };
  }

  /** The Job this ref names on this connection, or why it names none. */
  private placedJob(
    target: DeployTarget,
    ref: DeployRef,
  ):
    | {
        readonly kind: 'job';
        readonly connection: CloudRunAdapterConnection;
        readonly id: string;
        readonly path: string;
      }
    | Extract<JobRuns, { kind: 'none' }> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return {
        kind: 'none',
        because: `${targetLabel(target)} is not a Cloud Run Target`,
      };
    }
    const placed = parseRef(connection, ref);
    if (placed === null) {
      return {
        kind: 'none',
        because: 'this Deploy carries no handle on what it placed here',
      };
    }
    if (placed.collection !== JOBS) {
      return {
        kind: 'none',
        because:
          'this ref names a service, which has a runtime tail rather than runs',
      };
    }
    return {
      kind: 'job',
      connection,
      id: placed.id,
      path: `/v2/${parentOf(connection)}/${JOBS}/${encodeURIComponent(placed.id)}`,
    };
  }

  /**
   * The checklist comes from one probe. Discovery is mostly constants of the
   * runtime, since no call reports them.
   */
  async inspect(target: DeployTarget): Promise<TargetInspection> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      throw new Error(`${targetLabel(target)} is not a Cloud Run Target`);
    }
    const http = this.http(connection);

    const probe = await http.json<unknown>({
      method: 'GET',
      path: `/v2/${parentOf(connection)}/services`,
      query: { pageSize: '1' },
    });

    const subject = {
      project: connection.project,
      service: SERVICE_NAME,
      scope: `${connection.project} in ${connection.region}`,
    };

    return {
      prerequisites: orderedChecklist(
        cloudChecklist(probe, subject),
        this.adapter,
      ),
      discovery: await this.discover(connection),
      surface: cloudSurfaceProbe(probe, subject),
    };
  }

  private async *awaitVerdict(
    http: CloudHttp,
    connection: CloudRunAdapterConnection,
    collection: Collection,
    id: string,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const deadline =
      this.events.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // `apply` already emitted APPLYING, so a Service with no condition yet adds
    // no duplicate event.
    let reported: DeployPhase = 'APPLYING';
    // The last condition message logged. It changes within a phase, and is the
    // only progress a reader sees before the verdict.
    let said: string | undefined;

    for (;;) {
      const service = await this.read(http, connection, collection, id);
      const status: CloudRunStatus =
        service === null ? { phase: 'APPLYING' } : cloudRunStatus(service);

      if (status.phase !== reported) {
        reported = status.phase;
        yield this.events.status(status.phase, {
          resource: id,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }

      // Terminal details travel on the verdict instead.
      if (
        status.detail !== undefined &&
        status.detail !== said &&
        status.phase !== 'LIVE' &&
        status.phase !== 'FAILED'
      ) {
        said = status.detail;
        yield this.events.log(status.detail, id);
      }

      if (status.phase === 'LIVE') {
        // The platform names the address; core never assembles one. A Job
        // has no `uri`, since nothing routes to it.
        const uri = service?.uri;
        return {
          phase: 'LIVE',
          ref,
          ...(uri === undefined ? {} : { url: uri }),
          // No `address`: there is no custom domain mapping to target.
        };
      }

      if (status.phase === 'FAILED') {
        // The runtime puts the reason on the resource itself, and `debug`
        // keeps it on the Deploy row past the platform's retention.
        return {
          phase: 'FAILED',
          ref,
          reason: status.reason ?? 'STARTUP_FAILED',
          ...(status.detail === undefined ? {} : { detail: status.detail }),
          debug: status.debug,
        };
      }

      if (this.events.now() >= deadline) {
        yield this.events.status('FAILED', { resource: id, reason: 'TIMEOUT' });
        return {
          phase: 'FAILED',
          ref,
          reason: 'TIMEOUT',
          detail: status.detail ?? 'the revision did not settle in time',
          debug: status.debug,
        };
      }

      await this.wait();
    }
  }

  /** Replaces the whole policy. `describes` names it in the failure sentence. */
  private async setInvoker(
    http: CloudHttp,
    connection: CloudRunAdapterConnection,
    collection: Collection,
    id: string,
    policy: InvokerPolicy,
    describes: string,
  ): Promise<Omit<Extract<DeployVerdict, { phase: 'FAILED' }>, 'ref'> | null> {
    const written = await http.json<unknown>({
      method: 'POST',
      path: `/v2/${parentOf(connection)}/${collection}/${encodeURIComponent(id)}:setIamPolicy`,
      body: policy,
    });
    if (written.ok) return null;
    // A resource not placed yet has no policy, so an empty one is already
    // true. A granting policy that 404s is a failure.
    if (
      written.kind === 'status' &&
      written.status === 404 &&
      policy.policy.bindings.length === 0
    ) {
      return null;
    }
    const failure = cloudWriteFailure(written, id);
    return {
      phase: 'FAILED',
      reason: failure.reason,
      detail: `the invoker policy for ${describes} could not be written: ${failure.detail}`,
      debug: failure.debug,
    };
  }

  /**
   * Cloud Scheduler has no create-or-update. Patch, then create on a 404: one
   * call in the steady state, and never a moment with nothing scheduled.
   */
  private async schedule(
    connection: CloudRunAdapterConnection,
    id: string,
    schedule: string,
    name: DeployRef,
  ): Promise<Omit<Extract<DeployVerdict, { phase: 'FAILED' }>, 'ref'> | null> {
    const document = cloudSchedulerJob(schedule, {
      // Resolved here: `cloudSchedulerJob` reads `connection.endpoint` as
      // given, and an unset one would put `undefined` in the fired URL.
      connection: { ...connection, endpoint: this.endpointOf(connection) },
      name,
      // Unreachable: `apply` refuses a schedule on a Target naming no account.
      serviceAccount: connection.serviceAccount ?? '',
    });
    const path = `/v1/${parentOf(connection)}/${JOBS}`;
    const patched = await this.scheduler().json<unknown>({
      method: 'PATCH',
      path: `${path}/${encodeURIComponent(id)}`,
      // Named: to some of these APIs an absent mask replaces everything.
      query: { updateMask: 'schedule,timeZone,httpTarget' },
      body: document,
    });
    if (patched.ok) return null;
    const written =
      patched.kind === 'status' && patched.status === 404
        ? await this.scheduler().json<unknown>({
            method: 'POST',
            path,
            body: document,
          })
        : patched;
    if (written.ok) return null;
    const failure = cloudWriteFailure(written, id);
    return {
      phase: 'FAILED',
      reason: failure.reason,
      detail: `job ${id} could not be put on the schedule "${schedule}": ${failure.detail}`,
      debug: failure.debug,
    };
  }

  /**
   * `null` makes core report a stopped schedule, so only proof of absence (a
   * 404, or the service switched off) is `null`. Not knowing is `undefined`.
   */
  private async observeSchedule(
    connection: CloudRunAdapterConnection,
    id: string,
  ): Promise<string | null | undefined> {
    const read = await this.scheduler().json<{ schedule?: unknown }>({
      method: 'GET',
      path: `/v1/${parentOf(connection)}/${JOBS}/${encodeURIComponent(id)}`,
    });
    if (read.ok) {
      return typeof read.value?.schedule === 'string'
        ? read.value.schedule
        : null;
    }
    if (
      read.kind === 'status' &&
      (read.status === 404 || read.reason === SERVICE_DISABLED)
    ) {
      return null;
    }
    return undefined;
  }

  /** Succeeds whether or not the job had a schedule. */
  private async unschedule(
    connection: CloudRunAdapterConnection,
    id: string,
  ): Promise<Omit<Extract<DeployVerdict, { phase: 'FAILED' }>, 'ref'> | null> {
    const removed = await this.scheduler().json<unknown>({
      method: 'DELETE',
      path: `/v1/${parentOf(connection)}/${JOBS}/${encodeURIComponent(id)}`,
    });
    if (removed.ok) return null;
    if (removed.kind !== 'status') {
      return {
        phase: 'FAILED',
        reason: 'TARGET_UNREACHABLE',
        detail: `the schedule on job ${id} could not be removed: ${removed.message}`,
      };
    }
    // Nothing to remove: a 404, or the service switched off, which proves no
    // scheduler job exists.
    //
    // `reason` only, never the body: a genuine permission refusal whose message
    // mentions the code would otherwise be swallowed.
    if (removed.status === 404 || removed.reason === SERVICE_DISABLED) {
      return null;
    }
    const failure = cloudWriteFailure(removed, id);
    return {
      phase: 'FAILED',
      reason: failure.reason,
      detail: `the schedule on job ${id} could not be removed: ${failure.detail}`,
      debug: failure.debug,
    };
  }

  private async discover(
    connection: CloudRunAdapterConnection,
  ): Promise<TargetDiscovery> {
    return {
      arch: [...RUNTIME_ARCH],
      // Accelerators depend on region and quota, which no call here reads,
      // and a wrong `true` would place a workload where it cannot run.
      gpu: false,
      resourceCeiling: { ...RESOURCE_CEILING },
      // Nothing this adapter drives persists data; a Datastore is placed apart.
      persistence: false,
      // Both engines sit behind Private Service Connect endpoints in the vessel
      // network, so a vessel without one cannot host a Datastore.
      postgres: connection.network !== undefined,
      valkey: connection.network !== undefined,
      // The runtime has network controls, but no by-name egress allowlist.
      egressFiltering: false,
      policyEngine: await this.admissionPolicy(connection),
      logHistorySeconds: connection.logHistorySeconds ?? 0,
      servedHosts: connection.servedHosts ?? [],
      reachableRegistries: connection.reachableRegistries ?? [],
      // A revision resolves a pinned reference from its project's store.
      reachableSecretStores: [...NATIVE_STORE],
    };
  }

  /**
   * `AUDIT` unless the policy both blocks and evaluates something. With no
   * policy endpoint named, nothing is installed and nothing counts as verified.
   */
  private async admissionPolicy(
    connection: CloudRunAdapterConnection,
  ): Promise<PolicyEngineState> {
    if (connection.policyEndpoint === undefined) {
      return { installed: false, mode: null };
    }
    const read = await new CloudHttp({
      baseUrl: connection.policyEndpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    }).json<AdmissionPolicy>({
      method: 'GET',
      path: `/v1/projects/${encodeURIComponent(connection.project)}/policy`,
    });
    if (!read.ok || read.value === undefined) {
      return { installed: false, mode: null };
    }

    const rule = read.value.defaultAdmissionRule;
    const blocking = rule?.enforcementMode === BLOCKING;
    const verifies =
      rule?.evaluationMode !== undefined &&
      rule.evaluationMode !== VERIFIES_NOTHING;
    return {
      installed: true,
      mode: blocking && verifies ? 'ENFORCE' : 'AUDIT',
    };
  }

  private endpointOf(connection: CloudRunAdapterConnection): string {
    return connection.endpoint ?? DEFAULT_ENDPOINT;
  }

  private http(connection: CloudRunAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: this.endpointOf(connection),
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  /** One Cloud Scheduler root for every project, called with the same token. */
  private scheduler(): CloudHttp {
    return new CloudHttp({
      baseUrl: this.options.schedulerEndpoint ?? DEFAULT_SCHEDULER_ENDPOINT,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): CloudRunAdapterConnection | null {
    return target.connection.adapter === 'cloudrun' ? target.connection : null;
  }

  /** `null` on any failure, not only a 404. */
  private async read(
    http: CloudHttp,
    connection: CloudRunAdapterConnection,
    collection: Collection,
    id: string,
  ): Promise<CloudRunWorkload | null> {
    const read = await http.json<CloudRunWorkload>({
      method: 'GET',
      path: `/v2/${parentOf(connection)}/${collection}/${encodeURIComponent(id)}`,
    });
    return read.ok ? (read.value ?? null) : null;
  }

  private async wait(): Promise<void> {
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (this.options.sleep !== undefined) {
      await this.options.sleep(interval);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

interface CloudOperation {
  /** For `jobs.run`, the Execution being created. */
  readonly metadata?: { readonly name?: string };
}

interface CloudExecutionPage {
  readonly executions?: readonly CloudExecution[];
}

interface CloudExecution {
  readonly name?: string;
  readonly startTime?: string;
  readonly createTime?: string;
  readonly succeededCount?: number;
  readonly failedCount?: number;
  readonly conditions?: readonly {
    readonly type?: string;
    readonly state?: string;
    readonly message?: string;
  }[];
  /** Run overrides are folded in. */
  readonly template?: {
    readonly containers?: readonly {
      readonly env?: readonly {
        readonly name?: string;
        readonly value?: string;
      }[];
    }[];
  };
}

/**
 * The counts back up the `Completed` condition: a failed task is a failed run
 * before the condition is written.
 */
function cloudRunExecution(execution: CloudExecution): JobExecution {
  const completed = (execution.conditions ?? []).find(
    (condition) => condition.type === 'Completed',
  );
  const at = execution.startTime ?? execution.createTime;
  const outcome =
    completed?.state === 'CONDITION_SUCCEEDED' ||
    (completed === undefined && (execution.succeededCount ?? 0) > 0)
      ? 'passed'
      : completed?.state === 'CONDITION_FAILED' ||
          (execution.failedCount ?? 0) > 0
        ? 'failed'
        : 'running';
  // A plain `value` can only be a run override: `workloadContainer` delivers
  // every variable as a pinned reference.
  const ranWith = (execution.template?.containers ?? [])
    .flatMap((container) => container.env ?? [])
    .filter((entry) => entry.value !== undefined && entry.name !== undefined)
    .map((entry) => entry.name);
  const detail = [
    ...(ranWith.length === 0 ? [] : [`ran with ${ranWith.join(', ')}`]),
    ...(completed?.message === undefined ? [] : [completed.message]),
  ].join(' · ');
  return {
    name: shortName(execution.name ?? ''),
    outcome,
    startedAt: at === undefined ? null : new Date(at),
    ...(detail === '' ? {} : { detail }),
  };
}

/** A run with no start time yet sorts as the newest. */
function startedAtOf(execution: JobExecution): number {
  return execution.startedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

/** The log label `execution_name` carries only the last path segment. */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

function parentOf(connection: CloudRunAdapterConnection): string {
  return `projects/${connection.project}/locations/${connection.region}`;
}

/**
 * Carries the project and region, so a Target reconnected to another project
 * never reads the wrong one, and the collection, since `observe` and `destroy`
 * get no kind. It is also the Cloud Scheduler job's resource name.
 */
function refOf(
  connection: CloudRunAdapterConnection,
  collection: Collection,
  id: string,
): DeployRef {
  return scopedRef(parentOf(connection), collection, id);
}

/** What this ref names on this connection, or `null` if it names another. */
function parseRef(
  connection: CloudRunAdapterConnection,
  ref: DeployRef,
): { collection: Collection; id: string } | null {
  const parent = parentOf(connection);
  for (const collection of [SERVICES, JOBS] as const) {
    const id = parseScopedRef(parent, collection, ref);
    if (id !== null) return { collection, id };
  }
  return null;
}
