/**
 * The Cloud Run deploy adapter (§6).
 *
 * Accepts an `image`, talks to the runtime's own API directly, and reads status
 * off the resource's own conditions. There is no operator in between and nothing
 * to install: §6's "the GitOps operator *is* the pluggable machinery" has no
 * analogue here, which is why this adapter is smaller than the Kubernetes one
 * and why the Target's connection carries an endpoint rather than a flavour.
 *
 * **Two collections, one adapter.** A `service` or a `website` is a Service and
 * a `job` is a Job: two resources with separate APIs, separate documents and
 * separate ideas of what readiness means. The kind picks one at `apply`, and the
 * ref carries it from then on — `observe` and `destroy` are handed a ref and no
 * Component, so nothing else could tell them which API to ask. `service.ts` and
 * `job.ts` render the two documents; this file is the only thing that knows both
 * exist.
 *
 * **Three APIs, though.** A Job carries no cron expression, so a scheduled one
 * is a Cloud Scheduler job calling `jobs.run` in front of it — `scheduler.ts`
 * renders that, and it is the one part of a Component this adapter places
 * outside the runtime's own API. It shares the Job's resource name exactly, so
 * a `DeployRef` locates both and `destroy` takes the schedule with the Job.
 *
 * **Never the build-from-source path** (§4). The runtime will happily take a
 * source archive and build it, and taking that offer would give this
 * installation a second build engine — with its own frontends, its own
 * defaults, and its own idea of what a website is — reachable only from one of
 * three backends. §4's "build is always separate from deploy" is what forbids
 * it, `service.ts` and `job.ts` are where the documents that carry no build are
 * rendered, and `test/adapters/cloudrun.test.ts` is what notices if one appears.
 *
 * **Nothing here watches.** `apply` polls the Service it just wrote for a
 * bounded window and `observe` is one read, exactly as the Kubernetes adapter
 * does — and here the poll is not even a compromise: this backend has no watch
 * to give up (plan, Transport shape).
 *
 * **No egress filtering is advertised** (§8). The runtime has network controls,
 * but not the by-name egress allowlist §8 specifies, and a capability reported
 * `true` on the strength of something adjacent is how a workload ends up placed
 * somewhere its egress was never actually constrained.
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
  FailureReason,
  JobExecution,
  JobRuns,
  ObservedState,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
  StartedRun,
} from '../contract.ts';
import { cloudRunJob } from './job.ts';
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
  /** Mints a bearer token per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  /** The fast cadence, while an attempt is in flight (plan, Transport shape). */
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT` (§6). */
  readonly timeoutMs?: number;
  /** Injected so a test does not spend the cadence it is asserting about. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Cloud Logging API root; injectable for perimeter endpoints and tests. */
  readonly logsEndpoint?: string;
  /**
   * Cloud Scheduler API root — what fires a scheduled job (§7).
   *
   * Injected only by a test: `adapters/registry.ts` passes this adapter a token
   * and a transport and nothing else. Defaulted rather than carried on the
   * connection because it is a property of the cloud rather than of a project —
   * unlike the Target's own `endpoint`, there is nothing per-Target to say.
   */
  readonly schedulerEndpoint?: string;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_LOGS_ENDPOINT = 'https://logging.googleapis.com';
const DEFAULT_SCHEDULER_ENDPOINT = 'https://cloudscheduler.googleapis.com';
/**
 * The runtime's own API root — one hostname for every connected project,
 * because Google runs a single Cloud Run control plane rather than one per
 * customer. `CloudRunConnection.endpoint` used to be required for exactly the
 * reason `DEFAULT_LOGS_ENDPOINT` above is not on the connection at all: it read
 * as connection material analogous to a cluster's `apiServer`. It never was —
 * an operator was retyping this same string on every project — so it is now
 * this adapter's default, applied wherever `connection.endpoint` is read,
 * with the Target's own value kept only as an override for a perimeter or a
 * mirror in front of the real API.
 */
export const DEFAULT_ENDPOINT = 'https://run.googleapis.com';
const SERVICE_ID_LIMIT = 63;

/**
 * The two API collections this adapter places into.
 *
 * A Component's kind chooses one at apply, and a ref carries it thereafter —
 * see {@link refOf}. There is no third: the runtime's other resources are
 * things this adapter reads, never things it creates.
 */
const SERVICES = 'services';
const JOBS = 'jobs';
type Collection = typeof SERVICES | typeof JOBS;

/** The sub-collection a Job's runs live in — the executions §17 names. */
const EXECUTIONS = 'executions';

/**
 * What a job's log entries carry where a service's carry a revision (§17).
 *
 * A Job's entries are typed `cloud_run_job`, keyed on `job_name`, and labelled
 * with the execution and task that wrote them — none of which a
 * `cloud_run_revision` filter matches. That is why a run's logs are a different
 * question from "what is this Component saying now" rather than the same query
 * with a different name in it.
 */
const JOB_RESOURCE = 'cloud_run_job';
const SERVICE_RESOURCE = 'cloud_run_revision';
const EXECUTION_LABEL = 'run.googleapis.com/execution_name';
const TASK_INDEX_LABEL = 'run.googleapis.com/task_index';

/** How many runs `executions` reports when nothing says otherwise. */
const DEFAULT_EXECUTION_PAGE = 20;

/**
 * How many the API is asked for, regardless of how many are reported.
 *
 * `projects.locations.jobs.executions.list` documents no ordering and takes no
 * `orderBy`, so a page of ten is ten *some* executions and sorting them
 * afterwards only orders what arrived. Asking for a page far larger than the
 * depth any caller wants makes the newest ones be in it whichever end the API
 * starts from. Google's list APIs clamp a `pageSize` above their own maximum
 * rather than refusing it, so this is a ceiling request, not a promise.
 *
 * ponytail: a job with more executions than this still hides its newest ones if
 * the API pages oldest-first. Upgrade path is following `nextPageToken` until
 * it is empty, which is unbounded work for a screen that shows ten rows.
 */
const EXECUTION_PAGE_ASKED = 100;

/** How the operator would name the service in the sentence about enabling it. */
const SERVICE_NAME = 'Cloud Run';

/**
 * The reason a cloud API gives for "this service is not turned on here".
 *
 * The same code `cloud/checklist.ts` reads, and read here for one narrow
 * purpose — see {@link CloudRunDeployAdapter.unschedule}.
 */
const SERVICE_DISABLED = 'SERVICE_DISABLED';

/**
 * What the runtime runs.
 *
 * A property of the backend rather than of a project — there is no call that
 * reports it — and it is stated here rather than left empty because an empty
 * `arch` means "no architecture excluded" to placement, which would let an
 * `arm64` build be placed somewhere it cannot run.
 */
const RUNTIME_ARCH = ['amd64'] as const;

/**
 * The largest single workload the runtime admits (§3's `resourceCeiling`).
 *
 * Documented limits of the service rather than a project's own quota, which is
 * lower for most projects and not readable from the API this adapter holds. So
 * it is a ceiling in the honest direction: a workload this rejects genuinely
 * does not fit anywhere, and one it admits may still be refused by a quota —
 * which §8 already routes to `REJECTED` and surfaces at Place as
 * `QUOTA_EXHAUSTED` when something has measured it.
 */
const RESOURCE_CEILING = { cpu: '8', memory: '32Gi' } as const;

/** The one store a Cloud Run revision can resolve a reference from natively. */
const NATIVE_STORE: readonly StoreAdapter[] = ['gcp-secret-manager'];

/** What a binary-authorization policy says, as much as this adapter reads. */
interface AdmissionPolicy {
  readonly globalPolicyEvaluationMode?: string;
  readonly defaultAdmissionRule?: {
    readonly evaluationMode?: string;
    readonly enforcementMode?: string;
  };
}

/** The enforcement mode that actually blocks rather than only recording. */
const BLOCKING = 'ENFORCED_BLOCK_AND_AUDIT_LOG';
/** The evaluation mode that verifies nothing, whatever its enforcement says. */
const VERIFIES_NOTHING = 'ALWAYS_ALLOW';

export class CloudRunDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'cloudrun';
  /** §6's table: `cloudrun` takes an image. */
  readonly artifactTypes: readonly ArtifactType[] = ['image'];

  constructor(private readonly options: CloudRunAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a Cloud Run Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `cloudrun does not accept a ${desired.artifact.type} artifact`,
      );
    }
    const image = artifactAddress(
      desired.artifact,
      connection.reachableRegistries ?? [],
    );
    if (image === null) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        'the artifact carries no address this Target can pull it by',
      );
    }

    const job = desired.kind === 'job';
    // What this job's schedule is, or `null` for every other Component: the one
    // value the rest of `apply` reads to decide whether anything stands in
    // front of the Job. A `service` never has one — §6 marks `schedule` as a
    // job's field — so reading it off the kind here means nothing below has to
    // ask again.
    const fires = job ? (desired.schedule ?? null) : null;
    // A schedule fires *as* an identity or it does not fire: Cloud Scheduler
    // authenticates the `jobs.run` call it makes, and a scheduler job created
    // without an account would be created happily and refused on every tick —
    // a Component reporting `LIVE` on a cadence that lands nowhere, which is
    // the failure this whole path exists to avoid. The Target's runtime
    // account is the only identity this controller can act as
    // (`terraform/gcp/projects/bluenose/iam.tf`), so a Target naming none
    // cannot hold a scheduled job. `REJECTED` because §6 puts it with the
    // refusals answered by changing the request: drop the schedule, or place it
    // where an identity is named.
    if (fires !== null && connection.serviceAccount === undefined) {
      yield this.status('FAILED', { reason: 'REJECTED' });
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

    yield this.status('APPLYING', { resource: id });

    // A job that declares no schedule must not keep one a previous deploy
    // asked for, and the removal happens **before** the Job is written for the
    // same reason §9 writes a tightening invoker policy first: a gap in which
    // nothing fires is better than a window in which the old cadence fires the
    // new template. Asserted on every unscheduled job rather than only where
    // one was removed — this adapter holds no memory of the last deploy, and
    // deleting what is not there costs one call and answers `404`.
    //
    // **Said, not fatal.** Which is the difference between this call and the
    // one in `destroy`: here it is a cleanup for a schedule most jobs never
    // had, and failing on it would make every Cloud Run job — including one
    // that has never declared a cadence — depend on Cloud Scheduler being
    // enabled, permitted and reachable. Two ways that bites without anything
    // being wrong: Cloud Scheduler serves a strict subset of Cloud Run's
    // regions, and a project's IAM is eventually consistent after the terraform
    // that grants the role. What actually stops a schedule firing is the empty
    // invoker policy written further down, and that is a Cloud Run call: a
    // scheduler job that survived this lands on a Job that no longer admits it.
    // So the residue is a ticking job producing nothing — stated on the
    // timeline so it is not silent, and raised for real by `destroy`.
    if (job && fires === null) {
      const stopped = await this.unschedule(connection, id);
      if (stopped !== null) {
        yield this.log(
          `${stopped.detail ?? `the schedule on job ${id} could not be removed`} — this Component declares none, so the deploy continues and the grant below is what stops it firing`,
          id,
        );
      }
    }

    // §9: "tightening drops public reach first and stays red if the stricter
    // boundary does not come up." So for every non-public exposure the invoker
    // policy is written *before* the Service — a bounded outage is preferred
    // over a window in which the new revision is up and still reachable by
    // whoever the old one let in. On a Target that has nothing there yet this
    // call finds no Service and does nothing, which is why the policy is
    // written again after the rollout below: the closed state is **asserted**
    // on every deploy rather than inherited from the platform's default.
    //
    // The *open* half does not travel through IAM at all: `{public, none}` is
    // the Service document's own `invokerIamDisabled`, so it tightens in the
    // same PATCH that rolls the template — the field and the revision flip
    // together, and no principal an org policy could refuse is ever named.
    //
    // A job's invoker policy is not on this path. Nothing routes to a Job, so
    // its policy answers only *who may run it* — which is the scheduler and
    // nobody else — and the tightening direction there is the scheduler job
    // deleted above rather than a binding: a grant with nothing left to use it
    // invokes nothing. So a job asserts its policy once, after the Job exists
    // and in whichever direction the schedule now means.
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
        yield this.status('FAILED', { resource: id, reason: tightened.reason });
        return { ...tightened, ref };
      }
    }

    const render = {
      project: connection.project,
      image,
      serviceAccount: connection.serviceAccount ?? null,
      // §16's "one signature, two verifiers": `policyEndpoint` is where this
      // project's admission policy is read from, so a Target that names one is
      // a Target whose project has a policy the workload must submit to. The
      // vessel's `run.allowedBinaryAuthorizationPolicies` constraint applies to
      // Jobs as well as Services, so both declare it.
      useProjectAdmissionPolicy: connection.policyEndpoint !== undefined,
    };
    const document = job
      ? cloudRunJob(desired, render)
      : cloudRunService(desired, render);
    const applied = await http.json<unknown>({
      method: 'PATCH',
      path: `/v2/${parentOf(connection)}/${collection}/${encodeURIComponent(id)}`,
      // Create-or-update in one call, which is what makes `apply` idempotent
      // without core having to remember whether it placed this before.
      query: { allowMissing: 'true' },
      body: document,
    });
    if (!applied.ok) {
      const verdict = cloudWriteFailure(applied, ref);
      yield this.status('FAILED', { resource: id, reason: verdict.reason });
      return verdict;
    }
    yield this.log(`applied ${job ? 'job' : 'service'} ${id}`, id);

    const verdict = yield* this.awaitVerdict(
      http,
      connection,
      collection,
      id,
      ref,
    );
    if (verdict.phase !== 'LIVE') return verdict;

    if (job) {
      // Who may run this Job, asserted in whichever direction the schedule now
      // means — a binding for the identity the scheduler fires as, or nothing
      // at all. One call rather than a branch, because "what the policy says"
      // and "whether there is a schedule" are the same question, and skipping
      // the write on the unscheduled path is how a grant outlives the schedule
      // that justified it.
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
        yield this.status('FAILED', { resource: id, reason: bound.reason });
        return { ...bound, ref };
      }
      if (fires === null) return verdict;

      // Last, and only now: the binding it fires with is already in place, so
      // the first tick cannot land on a Job that has not yet been told to
      // admit it.
      const scheduled = await this.schedule(connection, id, fires, ref);
      if (scheduled !== null) {
        // And taken back when nothing came to use it. Writing the grant first
        // is right on the path that succeeds and wrong on the path that does
        // not: the runtime account is one identity shared by every workload in
        // the vessel — which is the whole reason the binding is per-Job — so a
        // grant left behind by a visibly failed deploy is a Job anything in the
        // vessel may run, uncleaned until someone deploys this Component
        // successfully. Best effort, and deliberately not allowed to replace
        // the verdict: what the operator has to see is why the schedule did not
        // land, not a second failure about tidying up after it.
        await this.setInvoker(
          http,
          connection,
          JOBS,
          id,
          jobInvokerPolicy(null),
          'this job',
        );
        yield this.status('FAILED', { resource: id, reason: scheduled.reason });
        return { ...scheduled, ref };
      }
      yield this.log(`firing job ${id} on "${fires}" (${TIME_ZONE})`, id);
      return verdict;
    }

    // Now that the Service exists, the closed policy is asserted on every
    // exposure. Tightening repeats a write it may already have made, which is
    // idempotent and is what makes "no non-public mode has a bypassable
    // origin" this adapter's guarantee rather than the platform default's. On
    // the public cell the write earns its place differently: openness is the
    // document field above, and the empty policy strips the `allUsers`
    // binding earlier versions of this adapter minted.
    const written = await this.setInvoker(
      http,
      connection,
      SERVICES,
      id,
      CLOSED_INVOKER_POLICY,
      `{reach: ${desired.reach}, auth: ${desired.auth}}`,
    );
    if (written !== null) {
      yield this.status('FAILED', { resource: id, reason: written.reason });
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
    // A Job's placement has a second half nothing else reads. Asked on every
    // job rather than only scheduled ones, because the whole question is
    // whether the schedule is *absent*, and only core knows whether that is the
    // honest answer — an adapter that skipped the read for jobs it believed
    // unscheduled could only ever believe what it just read.
    //
    // ponytail: one extra Cloud Scheduler GET per job per drift pass
    // (`DEFAULT_DRIFT_INTERVAL_MS`, five minutes). Carry the desired cadence
    // across the seam instead if a vessel ever holds enough jobs to make that a
    // real cost.
    const schedule =
      placed.collection === JOBS
        ? await this.observeSchedule(connection, placed.id)
        : undefined;
    return {
      ref,
      phase: status.phase,
      artifactDigest: servingDigest(read),
      // Omitted rather than `undefined`: absent is a third state on this field
      // and a key holding `undefined` is not it.
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
    // The schedule goes first, and it goes at all: a scheduler job left behind
    // would keep calling `jobs.run` on a Job that no longer exists, which is
    // the orphan §6's idempotence rule is about wearing a second service's
    // uniform. Ordered first so the window is "nothing fires it yet" rather
    // than "it fires and 404s".
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
    // §6's idempotence: destroying what is already gone succeeds. Every other
    // refusal is raised, because a delete that silently did nothing is how an
    // orphaned Service outlives the App that paid for it.
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
    // naming one narrows the filter twice: to this Component's Job rather than
    // its Service, and to that run rather than every run it has ever had. The
    // Component-wide question a service answers has no answer for a job, which
    // is why there is no third branch here.
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
   * Start one run of the job this ref names, now (§17).
   *
   * `jobs.run` is the runtime's own verb, and the same one a schedule fires
   * through — the scheduler calls exactly this over HTTP, as the identity the
   * Job's invoker policy names. So an on-demand run and a scheduled one produce
   * the same kind of execution, which is what makes a job's history one list
   * rather than two (§17). The call answers with an
   * `Operation` whose `metadata` **is** the Execution being created, which is
   * where the name comes from — an execution named by the runtime rather than
   * by this adapter, for the same reason a Service's `uri` comes back across
   * this seam rather than being handed in (§9).
   *
   * A ref naming the other collection is refused rather than run: a Service has
   * no execution, and the alternative to saying so is a 404 from a path that
   * reads as if it should have worked.
   */
  async run(target: DeployTarget, ref: DeployRef): Promise<StartedRun> {
    const placed = this.placedJob(target, ref);
    if (placed.kind === 'none') return placed;

    const started = await this.http(placed.connection).json<CloudOperation>({
      method: 'POST',
      path: `${placed.path}:run`,
      body: {},
    });
    if (!started.ok) {
      throw new Error(`running job ${placed.id} failed: ${started.message}`);
    }
    const name = started.value?.metadata?.name;
    return {
      kind: 'started',
      execution: {
        // An operation that named no execution still started one — the runtime
        // is creating it behind the operation. The Job's own id is the honest
        // thing to say meanwhile: it names what was run, and the next read of
        // `executions` replaces it with the run's own name.
        name: name === undefined ? placed.id : shortName(name),
        outcome: 'running',
        startedAt: null,
      },
    };
  }

  /** The runs that have happened, newest first (§17). */
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
    // Sort then slice, and in that order: the API documents no ordering, so
    // a page of `limit` would be `limit` arbitrary runs and sorting them would
    // put the newest of *those* on top. `limit` is what to report, never what
    // to look at — see {@link EXECUTION_PAGE_ASKED}.
    return {
      kind: 'executions',
      executions: (read.value?.executions ?? [])
        .map(cloudRunExecution)
        .sort((left, right) => startedAtOf(right) - startedAtOf(left))
        .slice(0, Math.max(1, limit)),
    };
  }

  /**
   * The Job this ref names on this connection, or why it names no job.
   *
   * Synchronous, because everything it decides is already in the ref: §6 makes
   * the collection part of the handle precisely so `observe` and `destroy` can
   * tell a Service from a Job without a Component, and these two verbs get the
   * same answer from the same place.
   */
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
   * One pass of §13's checklist and §3's discovery, in one call.
   *
   * The checklist comes from a single probe — see `cloud/checklist.ts` — and
   * discovery is mostly properties of the runtime rather than of a project,
   * because there is no call that reports them. Which is fine, and is why they
   * are constants with the reasoning written down beside them: a value core
   * invented and a value core read are equally honest as long as nobody has to
   * guess which one they are looking at.
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

  // --- apply's second half -------------------------------------------------

  private async *awaitVerdict(
    http: CloudHttp,
    connection: CloudRunAdapterConnection,
    collection: Collection,
    id: string,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const deadline =
      this.clock() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // `apply` already emitted APPLYING, so treat that as the first reported
    // phase: a Service whose terminal condition has not appeared yet must not
    // put a second identical event on the timeline.
    let reported: DeployPhase = 'APPLYING';
    // The condition message last put on the timeline. A revision says several
    // different things while staying in one phase — provisioning, pulling,
    // routing traffic — and those sentences are the only progress a reader gets
    // between "applying" and a verdict.
    let said: string | undefined;

    for (;;) {
      const service = await this.read(http, connection, collection, id);
      const status: CloudRunStatus =
        service === null ? { phase: 'APPLYING' } : cloudRunStatus(service);

      if (status.phase !== reported) {
        reported = status.phase;
        yield this.status(status.phase, {
          resource: id,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }

      // Terminal phases are excluded: their detail travels on the verdict, and
      // repeating it here would put the same sentence on the timeline twice.
      if (
        status.detail !== undefined &&
        status.detail !== said &&
        status.phase !== 'LIVE' &&
        status.phase !== 'FAILED'
      ) {
        said = status.detail;
        yield this.log(status.detail, id);
      }

      if (status.phase === 'LIVE') {
        // §9: the platform names its own, so the canonical address comes back
        // across this seam rather than being handed in. A Service reported
        // ready with no `uri` is the one case core cannot fill in, and an
        // absent url is more honest than a name core assembled. A Job document
        // has no `uri` member at all, which is the same absence meaning
        // something stronger: there is no address, because nothing routes here.
        const uri = service?.uri;
        return {
          phase: 'LIVE',
          ref,
          ...(uri === undefined ? {} : { url: uri }),
        };
      }

      if (status.phase === 'FAILED') {
        // §6's read on red is already done: unlike a cluster, the runtime puts
        // the reason on the object itself, so there are no pods to go and look
        // at. What §12 wants — the diagnosis surviving the platform's own
        // retention — is served by persisting `debug` on the Deploy row.
        return {
          phase: 'FAILED',
          ref,
          reason: status.reason ?? 'STARTUP_FAILED',
          ...(status.detail === undefined ? {} : { detail: status.detail }),
          debug: status.debug,
        };
      }

      if (this.clock() >= deadline) {
        yield this.status('FAILED', { resource: id, reason: 'TIMEOUT' });
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

  /**
   * Write one resource's whole invoker policy, or say why it could not.
   *
   * Takes the policy rather than the exposure it came from, because both
   * collections have one and they are computed from different things: a
   * Service's from `{reach, auth}` (§9), a Job's from whether anything fires it
   * (§7). What is shared is the write and how a refusal is read, and that is
   * all this holds. `describes` is how the policy is named in the sentence a
   * failure produces.
   */
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
    // A resource that does not exist yet cannot have a policy, and where the
    // policy grants nothing that is not a failure but a statement already true:
    // there is no reach to drop from something that was never placed. A policy
    // that *grants* is a different matter — it did not land, and saying so is
    // the whole point of writing it after the resource exists.
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

  // --- what stands in front of a Job ---------------------------------------

  /**
   * Put this job on its schedule, replacing whatever was there.
   *
   * **Patch, then create on `404`.** Cloud Scheduler has no create-or-update —
   * `jobs.create` refuses a name that exists and `jobs.patch` refuses one that
   * does not — so one of the two has to go first, and the choice is not a wash.
   * Patching first costs **one** call in the steady state, which is every
   * re-deploy of a Component whose cadence has not changed, and it never leaves
   * a moment with nothing scheduled. Deleting first would cost two always and
   * open that window on every deploy, including ones that change nothing: a
   * create that then failed — a transient `500`, a quota — would have destroyed
   * a working cadence, and core keeps the earlier deploy `LIVE`
   * (`reconciler/deploy-loop.ts`), so nothing in the product would say the
   * firing had stopped.
   */
  private async schedule(
    connection: CloudRunAdapterConnection,
    id: string,
    schedule: string,
    name: DeployRef,
  ): Promise<Omit<Extract<DeployVerdict, { phase: 'FAILED' }>, 'ref'> | null> {
    const document = cloudSchedulerJob(schedule, {
      // `cloudSchedulerJob` reads `connection.endpoint` straight off what it is
      // given, so the default has to be resolved before it gets there — the
      // fired URL would otherwise carry the literal string `undefined`.
      connection: { ...connection, endpoint: this.endpointOf(connection) },
      name,
      // Refused before anything was written when the Target names none —
      // see `apply`. The fallback is unreachable and is here because the
      // type cannot know that.
      serviceAccount: connection.serviceAccount ?? '',
    });
    const path = `/v1/${parentOf(connection)}/${JOBS}`;
    const patched = await this.scheduler().json<unknown>({
      method: 'PATCH',
      path: `${path}/${encodeURIComponent(id)}`,
      // Named rather than omitted: an absent mask means "replace the whole
      // resource" to some of this family's APIs and "update what was sent" to
      // others, and the fields this adapter writes are the only ones it should
      // be able to clear. `name` is the identity and is not in it.
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
   * What is firing this job, or `null` where nothing is.
   *
   * **A read that cannot fail into a lie.** `null` here is what makes core
   * report a stopped schedule, so every way of not knowing has to be `null`'s
   * opposite — an unreachable API, an expired token, a `403` — or a five
   * minute uplink blip would announce that a cadence stopped. Only the two
   * answers that *prove* absence produce `null`: a `404`, and the service
   * being switched off in this project, which is `unschedule`'s reasoning in
   * the other direction.
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

  /** Take this job off its schedule, whether or not it was on one. */
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
    // Nothing to remove, in the two ways there are to have nothing. A `404` is
    // the ordinary one. A refusal because the service is switched off in this
    // project is the other, and it is proof rather than an assumption: an API
    // that was never enabled has nothing under it that could have created a
    // scheduler job.
    //
    // Read off `reason` and nothing else. `cloud/http.ts` lifts that out of the
    // ErrorInfo the API attaches, which is how Google says "this service is
    // off" machine-readably; scanning the *body* for the same string would
    // tolerate a genuine `IAM_PERMISSION_DENIED` whose human message happens to
    // mention it — swallowing the one refusal that must be raised, on the path
    // whose whole job is to make sure a schedule really stopped.
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

  // --- inspect's second half -----------------------------------------------

  private async discover(
    connection: CloudRunAdapterConnection,
  ): Promise<TargetDiscovery> {
    return {
      arch: [...RUNTIME_ARCH],
      // The runtime does offer accelerators, in some regions and behind their
      // own quota, and neither fact is readable from the call this adapter
      // makes. Reported `false` because a GPU capability that is wrong makes a
      // workload placeable where it cannot run, and one that is missing only
      // makes it placeable somewhere else.
      gpu: false,
      resourceCeiling: { ...RESOURCE_CEILING },
      // §11 keeps a Datastore a top-level noun with its own placement; nothing
      // this adapter drives hosts one, and a managed database beside it is
      // `external` provenance rather than something discovered here.
      persistence: false,
      postgres: false,
      valkey: false,
      // §8: advertised as absent, deliberately. See the file's header.
      egressFiltering: false,
      policyEngine: await this.admissionPolicy(connection),
      logHistorySeconds: connection.logHistorySeconds ?? 0,
      servedHosts: connection.servedHosts ?? [],
      reachableRegistries: connection.reachableRegistries ?? [],
      // A revision resolves a pinned reference from its own project's store
      // over its own access path (§10's "one store of record, several access
      // paths"), so this is a property of the runtime rather than something
      // installed in the project.
      reachableSecretStores: [...NATIVE_STORE],
    };
  }

  /**
   * What this project's admission policy was found doing (§16, §32).
   *
   * §16's "one signature, two verifiers" makes this the cloud half, and §32's
   * rule applies unchanged: **enforcing, not installed.** Two ways a policy
   * proves nothing while looking configured, and both are reported `AUDIT` —
   * a dry-run enforcement that only writes a log entry, and an evaluation mode
   * that admits everything however it is enforced.
   *
   * A Target whose connection names no policy endpoint reports nothing
   * installed, which derives `verifiedDeploy: false`. That is the direction
   * this has to fail in: nobody said where to look, so nothing was verified.
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

  // --- plumbing ------------------------------------------------------------

  /** The runtime API root this Target actually reaches, override or default. */
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

  /**
   * The Cloud Scheduler API, which is not the Target's endpoint.
   *
   * A second root rather than a second connection field: the Target names where
   * *its own* control plane is, and the service that fires its jobs is the
   * cloud's, addressed the same way from every project. Same shape as the
   * logging root `tail` reaches for, and the same token — §13's federation is
   * one identity across every API it touches.
   */
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

  /** One Service or Job, or `null` where there is nothing there. */
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

  private internal(detail: string): DeployVerdict {
    return { phase: 'FAILED', reason: 'INTERNAL', detail };
  }

  private status(
    phase: DeployPhase,
    extra: { resource?: string; reason?: FailureReason; detail?: string } = {},
  ): DeployEvent {
    return { type: 'status', at: new Date(this.clock()), phase, ...extra };
  }

  private log(line: string, resource?: string): DeployEvent {
    return {
      type: 'log',
      at: new Date(this.clock()),
      line,
      ...(resource === undefined ? {} : { resource }),
    };
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
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

/** The long-running operation a write answers with, as much as is read. */
interface CloudOperation {
  /** The resource being created — for `jobs.run`, the Execution itself. */
  readonly metadata?: { readonly name?: string };
}

interface CloudExecutionPage {
  readonly executions?: readonly CloudExecution[];
}

/** One run, as much of the v2 `Execution` as this adapter reads. */
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
}

/**
 * One `Execution` as a run (§17).
 *
 * The `Completed` condition is the terminal one, and the counts are the
 * fallback rather than the primary reading: a run whose condition has not been
 * written yet but whose task already failed is a failed run, and reporting it
 * as still going would leave the screen waiting for something that is over.
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
  return {
    name: shortName(execution.name ?? ''),
    outcome,
    startedAt: at === undefined ? null : new Date(at),
    ...(completed?.message === undefined ? {} : { detail: completed.message }),
  };
}

/** What a run sorts by. A run with no start time yet is the newest there is. */
function startedAtOf(execution: JobExecution): number {
  return execution.startedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The last segment of a resource path.
 *
 * The runtime names an execution in full — `projects/…/jobs/…/executions/x` —
 * and the log filter's `execution_name` label carries only the `x`. So the
 * short name is what travels, because it is the one form both the list and the
 * logs agree on.
 */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

interface CloudLogPage {
  readonly entries?: readonly CloudLogEntry[];
}

interface CloudLogEntry {
  readonly timestamp?: string;
  readonly receiveTimestamp?: string;
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly jsonPayload?: unknown;
  readonly resource?: { readonly labels?: Record<string, string> };
  /** Where a job's entries carry which execution and task wrote them. */
  readonly labels?: Record<string, string>;
}

interface CloudLogRecord {
  readonly at: string;
  readonly insertId: string;
  readonly line: string;
  readonly replica: string;
}

function cloudLogRecord(entry: CloudLogEntry): CloudLogRecord | null {
  const at = entry.timestamp ?? entry.receiveTimestamp;
  if (!at || !entry.insertId) return null;
  const line =
    entry.textPayload ??
    (entry.jsonPayload === undefined
      ? null
      : JSON.stringify(entry.jsonPayload));
  if (line === null || line.trim() === '') return null;
  return {
    at,
    insertId: entry.insertId,
    line,
    // What wrote the line. A service's replica is a revision; a run's is one of
    // its tasks, and a run with `taskCount: 1` still names the task rather than
    // leaving the column reading `unknown` for every line it ever writes.
    replica:
      entry.resource?.labels?.revision_name ??
      taskReplica(entry.labels?.[TASK_INDEX_LABEL]) ??
      'unknown',
  };
}

/** The `task N` a task index reads as, or nothing when there is no index. */
function taskReplica(index: string | undefined): string | undefined {
  return index === undefined ? undefined : `task ${index}`;
}

function cloudLogCursor(cursor: string | undefined): CloudLogRecord | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf8'),
    ) as {
      at?: unknown;
      insertId?: unknown;
    };
    return typeof value.at === 'string' && typeof value.insertId === 'string'
      ? { at: value.at, insertId: value.insertId, line: '', replica: '' }
      : null;
  } catch {
    return null;
  }
}

function encodeCloudLogCursor(record: CloudLogRecord): string {
  return Buffer.from(
    JSON.stringify({ at: record.at, insertId: record.insertId }),
  ).toString('base64');
}

/** `projects/<p>/locations/<r>` — the parent every call hangs off. */
function parentOf(connection: CloudRunAdapterConnection): string {
  return `projects/${connection.project}/locations/${connection.region}`;
}

/**
 * The adapter's own handle on what `apply` placed — opaque to core (§6).
 *
 * It carries the project and the region as well as the id because an operator
 * may reconnect a Target against a different project, and a ref that named only
 * the resource would then be read against the wrong one — reporting a healthy
 * workload that is not the one this Deploy placed.
 *
 * It carries the **collection** for a reason that outlives this change:
 * `observe` and `destroy` are handed a ref and nothing else — no Component, no
 * kind — so the handle is the only thing that can say which API to ask. Which
 * is also why the ref shape written before jobs existed still parses: every ref
 * already stored says `services`, and reading the collection out of the ref
 * rather than deriving it from a kind is what keeps those readable instead of
 * orphaning every running Service.
 *
 * A third thing falls out of the shape rather than being designed into it: a
 * Cloud Scheduler job is named `projects/…/locations/…/jobs/…` too, so this
 * string **is** the scheduler job's own resource name at a different API root.
 * That is why nothing has to store where a schedule went.
 */
function refOf(
  connection: CloudRunAdapterConnection,
  collection: Collection,
  id: string,
): DeployRef {
  return `${parentOf(connection)}/${collection}/${id}`;
}

/** What this ref names on this connection, or `null` if it names another. */
function parseRef(
  connection: CloudRunAdapterConnection,
  ref: DeployRef,
): { collection: Collection; id: string } | null {
  const prefix = `${parentOf(connection)}/`;
  if (!ref.startsWith(prefix)) return null;
  const [collection, ...rest] = ref.slice(prefix.length).split('/');
  if (collection !== SERVICES && collection !== JOBS) return null;
  const id = rest.join('/');
  return id.length === 0 || id.includes('/') ? null : { collection, id };
}
