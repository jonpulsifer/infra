/**
 * The Kubernetes deploy adapter (§6).
 *
 * Accepts an `image`. **The Target declares the delivery flavour**, and
 * Spindrift applies a `HelmRelease` or an Argo `Application` **through the
 * API** — using Flux or Argo is not the same as writing manifests to git, and
 * only the chart source lives in a repository. Status is read from those
 * objects' own conditions.
 *
 * **Nothing here watches.** `apply` polls the object it just wrote on a fast
 * cadence for a bounded window — an attempt, not a standing watch — and
 * `observe` is one read. The plan's transport shape says why: only one of the
 * three backends has a watch at all, a watch dies across the satellite uplink
 * while still looking connected, and any correct watch design needs a resync
 * poll underneath it anyway. So the poll is not the fallback; it is the design.
 *
 * The three verbs are one-shot and imperative. Reconciliation lives in core,
 * above this seam, and both delivery operators self-heal below it — which is
 * why `install.remediation.retries` is zero on the Flux side and why
 * `selfHeal` is on on the Argo side. Neither is a contradiction: the operator
 * keeps what is running running; it does not retry an attempt core did not ask
 * for.
 */
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import {
  type PolicyEngineState,
  type Prerequisite,
  type PrerequisiteResult,
  prerequisitesFor,
  type TargetDiscovery,
  type TargetInspection,
} from '../../../domain/capabilities.ts';
import type {
  ArtifactType,
  DesiredState,
} from '../../../domain/desired-state.ts';
import {
  type KubernetesAdapterConnection,
  type KubernetesDelivery,
  targetLabel,
} from '../../../domain/target.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import { ENGINE_KINDS as DATASTORE_ENGINE_KINDS } from '../../datastore/kubernetes.ts';
import type {
  ClusterProbe,
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
  RuntimeLogEntry,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
  StartedRun,
} from '../contract.ts';
import {
  type Fetcher,
  KubernetesApi,
  type KubernetesObject,
  KubernetesRequestError,
  type TokenProvider,
} from './api.ts';
import {
  APPLICATION,
  applicationStatus,
  applicationValues,
  argoApplication,
} from './argo-application.ts';
import { diagnose } from './diagnose.ts';
import {
  chartSourceKind,
  HELM_RELEASE,
  helmRelease,
  helmReleaseStatus,
  helmReleaseValues,
  OCI_REPOSITORY,
} from './flux-helmrelease.ts';
import type { DeliveryStatus } from './status.ts';
import { chartValues, imageReference, VALUES_CONTRACT } from './values.ts';

/** What the adapter needs that a Target's connection does not carry. */
export interface KubernetesAdapterOptions {
  /**
   * The chart, as this installation names it (§20's `charts.app`).
   *
   * An `oci://` artifact or a path inside the Target's configured repository,
   * and the string itself is what decides which — `chartSourceKind`. Every
   * read and write of a chart source in this adapter goes through that one
   * function, so a Target cannot be checked against one kind and deployed
   * against the other.
   */
  readonly chart: string;
  /** Mints a bearer token per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  /**
   * The fast cadence, while an attempt is in flight. A bounded window, not a
   * standing watch (plan, Transport shape).
   */
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT` (§6). */
  readonly timeoutMs?: number;
  /** Injected so a test does not spend the cadence it is asserting about. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const RUNTIME_LOG_LIMIT_BYTES = 256 * 1024;

/** Which store a `ClusterSecretStore`'s provider key names (§10). */
const STORE_PROVIDERS: Record<string, StoreAdapter> = {
  onepassword: 'onepassword',
  gcpsm: 'gcp-secret-manager',
};

/**
 * The CRDs a datastore engine is discovered by (§3, §11).
 *
 * Imported rather than declared, because the kind a cluster is asked about and
 * the kind Spindrift writes to provision one must be the same kind. A second
 * table here could name an operator no cluster in the fleet installs, and the
 * symptom is silent: the engine discovers `false` everywhere and every Datastore
 * asking for it is a non-candidate for a reason no operator can act on.
 */
const ENGINE_KINDS = DATASTORE_ENGINE_KINDS;

/** The policy engine `verifiedDeploy` is derived from (§32). */
const POLICY = {
  apiVersion: 'kyverno.io/v1',
  kind: 'ClusterPolicy',
  plural: 'clusterpolicies',
} as const;

/** The CNI object that means egress can be filtered by name (§8). */
const EGRESS_POLICY = {
  apiVersion: 'cilium.io/v2',
  kind: 'CiliumNetworkPolicy',
} as const;

const SECRET_STORE = {
  apiVersion: 'external-secrets.io/v1',
  kind: 'ClusterSecretStore',
  plural: 'clustersecretstores',
} as const;

/**
 * The two objects a job's runs are (§7, §17).
 *
 * The chart renders a CronJob for every job, scheduled or not, and a run is a
 * Job it owns — so "start a run" is creating a Job from the CronJob's own
 * `jobTemplate` rather than un-suspending it. Un-suspending would make the
 * next *scheduled* time fire, which for an unscheduled job is a date that never
 * occurs and for a scheduled one is a different act than the operator asked
 * for.
 */
const CRON_JOB = {
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  plural: 'cronjobs',
} as const;

const JOB = { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs' } as const;

/**
 * The label the Job controller stamps on the pods of one run.
 *
 * The current one. The unprefixed label of the same name is set beside it and
 * is deprecated, so keying on this one is what keeps a job's tail reading the
 * run it was asked about rather than whichever label the cluster stops writing
 * first.
 */
const JOB_NAME_LABEL = 'batch.kubernetes.io/job-name';

/** What `kubectl create job --from` marks a run somebody asked for. */
const MANUAL_RUN = 'cronjob.kubernetes.io/instantiate';

/**
 * The longest name a run may carry.
 *
 * A Job's pods are named `<job>-<five random characters>`, and a pod's hostname
 * is a DNS label — so the six characters the Job controller appends have to fit
 * under 63 or the run starts and can never schedule a pod.
 */
const RUN_NAME_LIMIT = 57;

/**
 * What a route attaches to. Read only by {@link KubernetesDeployAdapter.probe}
 * — the App chart renders an `HTTPRoute` and never a `Gateway`, so this
 * adapter's only interest in one is telling an operator which exist and where
 * each answers.
 */
const GATEWAY = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'Gateway',
  plural: 'gateways',
} as const;

export class KubernetesDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'kubernetes';
  /** §6's table: `kubernetes` takes an image. */
  readonly artifactTypes: readonly ArtifactType[] = ['image'];

  constructor(private readonly options: KubernetesAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a Kubernetes Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      // A foreign artifact reaching `apply` is a core bug, and §6 says so in
      // the adapter's own vocabulary rather than by throwing.
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `kubernetes does not accept a ${desired.artifact.type} artifact`,
      );
    }
    const image = imageReference(desired, connection.reachableRegistries ?? []);
    if (image === null) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal('the artifact carries no address to pull it by');
    }

    const object = this.deliveryObject(connection, desired, image);
    const ref = refOf(connection.delivery.flavour, object);
    const api = this.api(connection);

    yield this.status('APPLYING', { resource: resourceLabel(object) });
    try {
      await api.apply(object, pluralOf(connection.delivery.flavour));
    } catch (cause) {
      const verdict = writeFailure(cause, ref);
      yield this.status('FAILED', { reason: verdict.reason });
      return verdict;
    }
    yield this.log(`applied ${resourceLabel(object)}`, resourceLabel(object));

    return yield* this.awaitVerdict(api, connection, desired, object, ref);
  }

  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const parsed = parseRef(ref);
    if (parsed === null) return null;

    const object = await this.api(connection).get({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (object === null) return null;

    const status = statusOf(parsed.flavour, object);
    return {
      ref,
      phase: status.phase,
      // The digest actually serving, as the delivery object still carries it.
      // Core compares it against the desired row to detect drift, which is
      // surfaced and never silently corrected (§6).
      artifactDigest: appliedDigest(parsed.flavour, object),
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const parsed = parseRef(ref);
    if (parsed === null) return;
    // `delete` treats a 404 as success, which is the whole of §6's idempotence
    // requirement: destroying what is already gone succeeds.
    await this.api(connection).delete({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
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
    const api = this.api(connection);
    // A run's pods carry the Component's labels like every other pod the chart
    // renders, so the subject narrows by one term rather than by a second
    // query: with no execution named this is the Component's whole output, and
    // with one it is that run's and no other run's.
    const selector = [
      `app.kubernetes.io/name=${subject.component}`,
      `app.kubernetes.io/part-of=${subject.app}`,
      ...(subject.execution === undefined
        ? []
        : [`${JOB_NAME_LABEL}=${subject.execution}`]),
    ].join(',');
    const pods =
      (await api.list(
        { apiVersion: 'v1', plural: 'pods', namespace: connection.namespace },
        { labelSelector: selector },
      )) ?? [];
    const consumed = runtimeCursor(options.after);
    const identities = new Set(pods.map(runtimePodIdentity));
    const next = Object.fromEntries(
      Object.entries(consumed).filter(([identity]) => identities.has(identity)),
    );
    const entries: RuntimeLogEntry[] = [];
    const limit = Math.max(1, options.limit ?? 200);

    for (const pod of [...pods].sort((a, b) =>
      a.metadata.name.localeCompare(b.metadata.name),
    )) {
      if (entries.length >= limit) break;
      const identity = runtimePodIdentity(pod);
      const prior = consumed[identity];
      const text = await api.logs(connection.namespace, pod.metadata.name, {
        container: 'app',
        timestamps: true,
        ...(prior === undefined
          ? { tailLines: limit }
          : { sinceTime: prior.at }),
        limitBytes: RUNTIME_LOG_LIMIT_BYTES,
      });
      if (text === null) continue;
      const lines = text.split('\n').filter((line) => line.length > 0);
      const occurrences = new Map<string, number>();
      for (const raw of lines) {
        if (entries.length >= limit) break;
        const parsed = runtimeLine(raw);
        const occurrence = (occurrences.get(parsed.cursorAt) ?? 0) + 1;
        occurrences.set(parsed.cursorAt, occurrence);
        if (
          prior !== undefined &&
          (parsed.cursorAt < prior.at ||
            (parsed.cursorAt === prior.at && occurrence <= prior.seen))
        ) {
          continue;
        }
        next[identity] = { at: parsed.cursorAt, seen: occurrence };
        entries.push({
          cursor: encodeRuntimeCursor(next),
          at: parsed.at,
          line: parsed.line,
          replica: pod.metadata.name,
          ...(pod.metadata.labels?.['spindrift.dev/deploy']
            ? {
                deployId: pod.metadata.labels['spindrift.dev/deploy'] as string,
              }
            : {}),
        });
      }
    }

    return {
      kind: 'stream',
      entries,
      // Always return the normalized per-pod offsets. A pod can retain its
      // name while its log is truncated after restart; preserving the older
      // cursor in that case would skip the beginning of the new log.
      cursor: entries.at(-1)?.cursor ?? encodeRuntimeCursor(next),
      reach: connection.logHistorySeconds ?? 0,
    };
  }

  /**
   * Start one run of the job this ref placed (§7, §17).
   *
   * A Job created from the CronJob's own `jobTemplate`, **owned by that
   * CronJob**. Both halves are load-bearing. Creating from the template rather
   * than un-suspending is what makes this run *now* instead of at the next
   * scheduled time — which for an unscheduled job is a date that never occurs.
   * And the owner reference is what makes §7's "a scheduled run and a manual
   * run are the same object with a field flipped" true from the reading side:
   * `getJobsToBeReconciled` selects the controller ref, so a manual run lands
   * in `cleanupFinishedJobs` and is pruned by the same history limit rather
   * than becoming an orphan that outlives every execution beside it.
   *
   * **The reference does not make `concurrencyPolicy: Forbid` hold a manual run
   * off, and nothing here can.** The controller's Forbid check is
   * `len(cj.Status.Active) > 0`, and `Status.Active` is appended only where the
   * controller creates a Job itself — it never adopts a foreign Job into it. So
   * a run started here at 02:59:55 does not stop the `0 3 * * *` fire, and the
   * two run concurrently even though the policy says never. There is no API
   * that asks a CronJob to run now; `kubectl create job --from=cronjob/x` does
   * exactly this and does not set an owner at all. An in-flight check in
   * `runComponent` would not change it either: the fire that overlaps comes
   * from the controller, which does not consult Spindrift.
   *
   * The known cost of the reference is a `Warning UnexpectedJob "Saw a job that
   * the controller did not create or forgot"` on every sync until the run
   * finishes — `syncCronJob`'s `!found && !IsJobFinished(j)` arm. That is a
   * true statement about a Job the controller did not create, and pruning is
   * worth it.
   *
   * `blockOwnerDeletion` is deliberately absent from that reference: setting it
   * needs `update` on the owner's `finalizers` subresource wherever the
   * `OwnerReferencesPermissionEnforcement` admission plugin is on, and the
   * garbage collection this wants happens without it.
   */
  async run(target: DeployTarget, ref: DeployRef): Promise<StartedRun> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return refuse(`${targetLabel(target)} is not a Kubernetes Target`);
    }
    const api = this.api(connection);
    const placed = await this.placedJob(api, ref);
    if (placed.kind === 'none') return placed;

    const [owner] =
      (await api.list(
        {
          apiVersion: CRON_JOB.apiVersion,
          plural: CRON_JOB.plural,
          namespace: connection.namespace,
        },
        { labelSelector: placed.selector },
      )) ?? [];
    if (owner === undefined) {
      return refuse(
        `no ${CRON_JOB.kind} for ${placed.app}/${placed.component} is on this Target yet`,
      );
    }
    const template = (owner.spec as { jobTemplate?: JobTemplate } | undefined)
      ?.jobTemplate;
    if (template?.spec === undefined) {
      return refuse(
        `${CRON_JOB.kind} ${owner.metadata.name} carries no job template to run`,
      );
    }

    // The CronJob controller's own naming, at second rather than minute
    // resolution: a name derived from when the run was asked for, so a second
    // press within the same second is the *same* run rather than a second one.
    // The API server enforces that for free — see the 409 below.
    const name = workloadName(
      {
        app: owner.metadata.name,
        component: String(Math.floor(this.clock() / 1_000)),
      },
      RUN_NAME_LIMIT,
    );
    const uid = owner.metadata.uid;
    const run: KubernetesObject = {
      apiVersion: JOB.apiVersion,
      kind: JOB.kind,
      metadata: {
        name,
        namespace: connection.namespace,
        ...(template.metadata?.labels === undefined
          ? {}
          : { labels: template.metadata.labels }),
        annotations: {
          ...template.metadata?.annotations,
          [MANUAL_RUN]: 'manual',
        },
        ...(typeof uid === 'string'
          ? {
              ownerReferences: [
                {
                  apiVersion: CRON_JOB.apiVersion,
                  kind: CRON_JOB.kind,
                  name: owner.metadata.name,
                  uid,
                  controller: true,
                },
              ],
            }
          : {}),
      },
      spec: template.spec,
    };

    let created: KubernetesObject;
    try {
      created = await api.create(
        {
          apiVersion: JOB.apiVersion,
          plural: JOB.plural,
          namespace: connection.namespace,
        },
        run,
      );
    } catch (cause) {
      // The run this press names is already going. Reporting it as started is
      // the honest answer and the idempotent one: a double press produced one
      // run, which is what the operator asked for and what §6 asks of `destroy`
      // for the same reason.
      if (cause instanceof KubernetesRequestError && cause.status === 409) {
        return { kind: 'started', execution: startingRun(name) };
      }
      throw cause;
    }
    // The name the API server stored, not the one that was asked for: `create`
    // now answers with the object or raises, so this reports a run that exists.
    return { kind: 'started', execution: startingRun(created.metadata.name) };
  }

  /**
   * The runs that have happened, newest first (§17).
   *
   * Listed by the Component's own labels rather than by ownership, because a
   * Job the CronJob controller created and a Job this adapter created both
   * carry the template's labels while only the second is guaranteed to still
   * have an owner: garbage collection removes the reference before it removes
   * the object. Listing by label reads both, which is the whole question — what
   * has this Component run, however it was started.
   */
  async executions(
    target: DeployTarget,
    ref: DeployRef,
    limit = 20,
  ): Promise<JobRuns> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return refuse(`${targetLabel(target)} is not a Kubernetes Target`);
    }
    const api = this.api(connection);
    const placed = await this.placedJob(api, ref);
    if (placed.kind === 'none') return placed;

    const jobs = await api.list(
      {
        apiVersion: JOB.apiVersion,
        plural: JOB.plural,
        namespace: connection.namespace,
      },
      { labelSelector: placed.selector },
    );
    // `list` answers `null` for a `404`, which {@link KubernetesApi.list} keeps
    // apart from an empty list on purpose: it means the namespace is gone or
    // this cluster does not serve `batch/v1`. Neither is "this job has never
    // run", and `?? []` here would render both as the never-run empty state —
    // the read half of the same silent-wrong-answer `create` had. Raised so it
    // lands where a `403` on this call already lands, on `executionsOf`'s
    // `because` arm: the runs could not be read, and the Run now button stays.
    if (jobs === null) {
      throw new Error(
        `the API server answered 404 listing ${JOB.plural} in ${connection.namespace} — that namespace or ${JOB.apiVersion} is not there`,
      );
    }

    return {
      kind: 'executions',
      executions: jobs
        .map(jobExecution)
        .sort((left, right) => startedAtOf(right) - startedAtOf(left))
        .slice(0, Math.max(1, limit)),
    };
  }

  /**
   * The job this ref placed, as the labels its objects carry.
   *
   * Read off the delivery object's **values** rather than derived from the ref,
   * because the ref names the release and the workload is named by the chart —
   * `spindrift-app.fullname` truncates plainly where {@link workloadName} keeps
   * a digest, so the two names diverge for a long App and deriving one from the
   * other would be a reimplementation of a chart helper that is free to change.
   * The values are what Spindrift wrote and what the chart rendered from, so
   * they are the one place both sides agree.
   */
  private async placedJob(
    api: KubernetesApi,
    ref: DeployRef,
  ): Promise<
    | {
        readonly kind: 'job';
        readonly app: string;
        readonly component: string;
        readonly selector: string;
      }
    | Extract<JobRuns, { kind: 'none' }>
  > {
    const parsed = parseRef(ref);
    if (parsed === null) {
      return refuse('this Deploy carries no handle on what it placed');
    }
    const object = await api.get({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (object === null) {
      return refuse(`${parsed.name} is no longer on this Target`);
    }
    const app = valuesOf(parsed.flavour, object).app as
      | { name?: unknown; component?: unknown; kind?: unknown }
      | undefined;
    if (app?.kind !== 'job') {
      return refuse('this Component is not a job, so it has no runs');
    }
    if (typeof app.name !== 'string' || typeof app.component !== 'string') {
      return refuse(`${parsed.name} does not say which Component it renders`);
    }
    return {
      kind: 'job',
      app: app.name,
      component: app.component,
      // `spindrift-app.selectorLabels`, which is on every object the chart
      // renders and on every pod a run of it creates.
      selector: `app.kubernetes.io/name=${app.component},app.kubernetes.io/part-of=${app.name}`,
    };
  }

  /**
   * One pass of §13's checklist and §3's discovery, in one call (§13's one
   * loop).
   *
   * It reports **observations, never judgements**: `verifiedDeploy` and
   * `offlineDeploy` are core's conclusions, so what comes back is what was
   * seen — a policy engine's mode, the hosts an operator says this Target
   * serves — and never what either of them implies.
   */
  async inspect(target: DeployTarget): Promise<TargetInspection> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      throw new Error(`${targetLabel(target)} is not a Kubernetes Target`);
    }
    const api = this.api(connection);

    const [prerequisites, discovery] = await Promise.all([
      this.checklist(api, connection),
      this.discover(api, connection),
    ]);
    // A cluster *is* its `kubernetes` surface — there is no second service to
    // have switched off — so getting this far is the whole probe. The reads
    // above throw rather than degrade when the API server does not answer, and
    // core reads that as `undetermined`, which is the honest arm: nothing was
    // established about a cluster nobody could reach.
    return { prerequisites, discovery, surface: { kind: 'carried' } };
  }

  /**
   * Read a cluster that is not a Target yet (§13's connect, one step earlier).
   *
   * Every read is independently caught. §13's "connect always succeeds" has a
   * mirror here: **probing always answers**, and a cluster that serves Flux but
   * refuses to list its namespaces produces a screen with one field to pick
   * from and one to type, rather than an error page about a cluster that is
   * nearly ready. The one thing that is fatal is the address not answering at
   * all, because then nothing on the screen would mean anything.
   */
  async probe(apiServer: string): Promise<ClusterProbe> {
    const api = new KubernetesApi({
      apiServer,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });

    // The liveness read, and the first half of the delivery answer. `servesKind`
    // reads the discovery API, which every authenticated identity may read, so
    // a failure here is the address rather than the permissions.
    let flux: boolean;
    try {
      flux = await api.servesKind(HELM_RELEASE.apiVersion, HELM_RELEASE.kind);
    } catch (cause) {
      return {
        reachable: false,
        because: cause instanceof Error ? cause.message : String(cause),
        deliveryFlavours: [],
        namespaces: [],
        chartSources: [],
        secretStores: [],
        gateways: [],
      };
    }

    const [argo, namespaces, sources, stores, gateways] = await Promise.all([
      api
        .servesKind(APPLICATION.apiVersion, APPLICATION.kind)
        .catch(() => false),
      api.list({ apiVersion: 'v1', plural: 'namespaces' }).catch(() => null),
      // The kind this installation's own chart reference needs, and only that
      // kind: a picker offering a `GitRepository` to an installation that
      // deploys from OCI is a picker whose every option is a wrong answer.
      api.list(chartSourceKind(this.options.chart)).catch(() => null),
      api
        .list({
          apiVersion: SECRET_STORE.apiVersion,
          plural: SECRET_STORE.plural,
        })
        .catch(() => null),
      api
        .list({ apiVersion: GATEWAY.apiVersion, plural: GATEWAY.plural })
        .catch(() => null),
    ]);

    return {
      reachable: true,
      deliveryFlavours: [
        ...(flux ? (['flux-helmrelease'] as const) : []),
        ...(argo ? (['argo-application'] as const) : []),
      ],
      namespaces: (namespaces ?? []).map((item) => item.metadata.name),
      chartSources: (sources ?? []).map((item) => ({
        name: item.metadata.name,
        namespace: item.metadata.namespace ?? '',
      })),
      secretStores: (stores ?? []).map((item) => item.metadata.name),
      gateways: (gateways ?? []).map((item) => ({
        name: item.metadata.name,
        namespace: item.metadata.namespace ?? '',
        address: gatewayAddress(item),
      })),
    };
  }

  // --- apply's second half -------------------------------------------------

  /**
   * Poll the object just written until it reaches a verdict.
   *
   * The cadence is fast because the window is bounded: §6's phases come from
   * the controller, and this is the only period in which they change quickly.
   * Once the attempt ends, nothing here keeps looking — the slow cadence that
   * detects drift belongs to core's loop, and lives on `observe`.
   *
   * **The controller's sentence is emitted, not only its phase.** A Helm
   * upgrade spends most of its life in one phase while saying a series of
   * different things — pulling the chart, running the upgrade action, waiting
   * on a Deployment. Reporting only phase transitions turned two or three
   * minutes of legible progress into two events and a still screen, so every
   * change in the `Ready` condition's message becomes a log line on the
   * timeline. It is deduplicated on the message itself, so a controller
   * repeating itself every poll does not fill the log with one sentence.
   */
  private async *awaitVerdict(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
    desired: DesiredState,
    object: KubernetesObject,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const resource = resourceLabel(object);
    const deadline =
      this.clock() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // `apply` emitted APPLYING before the write. Treat that as the first
    // reported controller phase too, so an object whose status has not caught
    // up to its generation does not duplicate the event on the timeline.
    let reported: DeployPhase = 'APPLYING';
    let said: string | undefined;

    for (;;) {
      const current = await api.get({
        apiVersion: object.apiVersion,
        plural: pluralOf(connection.delivery.flavour),
        namespace: object.metadata.namespace,
        name: object.metadata.name,
      });
      const status: DeliveryStatus =
        current === null
          ? { phase: 'APPLYING' }
          : statusOf(connection.delivery.flavour, current);

      if (status.phase !== reported) {
        reported = status.phase;
        yield this.status(status.phase, {
          resource,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }

      // The progress *within* a phase, which is where a rollout spends its
      // time. Skipped on the terminal phases: `failed` writes the diagnosis
      // below and `LIVE` is the verdict, so echoing either here would put the
      // same sentence on the timeline twice.
      if (
        status.detail !== undefined &&
        status.detail !== said &&
        status.phase !== 'LIVE' &&
        status.phase !== 'FAILED'
      ) {
        said = status.detail;
        yield this.log(status.detail, resource);
      }

      if (status.phase === 'LIVE') {
        // No `url`: §9 gives a metal cluster no name of its own, so the
        // canonical name is core's to mint and never comes back across here.
        return { phase: 'LIVE', ref };
      }

      if (status.phase === 'FAILED') {
        return yield* this.failed(api, connection, desired, status, ref);
      }

      if (this.clock() >= deadline) {
        yield this.status('FAILED', { resource, reason: 'TIMEOUT' });
        return {
          phase: 'FAILED',
          ref,
          reason: 'TIMEOUT',
          detail: status.detail ?? 'the release did not settle in time',
          debug: status.debug,
        };
      }

      await this.wait();
    }
  }

  /** The read on red, once (§6), and the verdict it produces. */
  private async *failed(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
    desired: DesiredState,
    status: DeliveryStatus,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    if (status.reason !== undefined) {
      // The delivery object already said why, in terms §6 has a reason for.
      // Reading pods would add nothing a developer can act on.
      return {
        phase: 'FAILED',
        ref,
        reason: status.reason,
        ...(status.detail === undefined ? {} : { detail: status.detail }),
        debug: status.debug,
      };
    }

    const namespace = connection.namespace;
    const selector = `app.kubernetes.io/name=${desired.component},app.kubernetes.io/part-of=${desired.app}`;
    const [pods, events] = await Promise.all([
      api
        .list(
          { apiVersion: 'v1', plural: 'pods', namespace },
          { labelSelector: selector },
        )
        .catch(() => null),
      api
        .list({ apiVersion: 'v1', plural: 'events', namespace })
        .catch(() => null),
    ]);

    const diagnosis = diagnose(pods ?? [], events ?? [], status.detail);
    yield this.log(diagnosis.detail);
    return {
      phase: 'FAILED',
      ref,
      reason: diagnosis.reason,
      detail: diagnosis.detail,
      // §12: the diagnosis is stored because the platform will not keep it —
      // cluster events expire in about an hour.
      debug: { delivery: status.debug, diagnosis: diagnosis.debug },
    };
  }

  // --- inspect's two halves ------------------------------------------------

  private async checklist(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
  ): Promise<readonly PrerequisiteResult[]> {
    const delivery = connection.delivery;
    const results = new Map<string, PrerequisiteResult>();
    const set = (name: Prerequisite, met: boolean, detail?: string): void => {
      results.set(name, met ? { name, met } : { name, met: false, detail });
    };

    const kind = deliveryKind(delivery.flavour);
    const operator = await api.servesKind(kind.apiVersion, kind.kind);
    set(
      'DELIVERY_OPERATOR',
      operator,
      `this cluster does not serve ${kind.kind}: a Kubernetes Target must run Flux or Argo (§6)`,
    );

    set('CHART_SOURCE', ...(await this.chartSource(api, delivery)));

    const stores = await this.reachableSecretStores(api);
    set(
      'WRITABLE_STORE',
      stores.length > 0,
      'this cluster has no ClusterSecretStore, so config cannot be delivered',
    );

    const allowed = await this.canWriteDelivery(api, delivery);
    set(
      'OIDC_FEDERATION',
      allowed,
      `the federated identity may not create ${kind.kind}s in ${delivery.namespace}`,
    );

    const namespace = await api.get({
      apiVersion: 'v1',
      plural: 'namespaces',
      name: connection.namespace,
    });
    set(
      'VESSEL',
      namespace !== null,
      `namespace ${connection.namespace} does not exist, and Spindrift does not create it (§7)`,
    );

    set('CHART_CONTRACT', ...(await this.chartContract(api, connection)));

    return prerequisitesFor(this.adapter).map(
      (name) =>
        results.get(name) ?? {
          name,
          met: false,
          assessed: false,
          detail: 'not assessed',
        },
    );
  }

  /**
   * Whether what this Target last rendered speaks the contract this Spindrift
   * writes.
   *
   * §7: "the chart declares its own value contract and version, **read at pin
   * time**". The chart stamps that declaration onto every object it renders,
   * pod template included (`spindrift-app.contractAnnotations`), so the
   * contract a Target is actually running under is readable from the cluster
   * itself — no second channel, and `list pods` in the App namespace is a grant
   * Spindrift already holds. That matters because Spindrift's only route to a
   * remote Target is its API server: the chart's own `Chart.yaml` lives behind
   * a source-controller artifact URL inside *that* cluster, and the
   * `argo-application` flavour has no artifact at all.
   *
   * Reading the render rather than the chart is also the stronger question.
   * Skew is not "the chart is wrong" — it is a release whose stored values were
   * written under an older contract, which a correct chart cannot tell you
   * about. Helm ignores unknown values silently, so such a release applies
   * cleanly, reports green, and runs without the config it was handed.
   *
   * Pods carrying no annotation are not chart output and are ignored, which
   * also keeps a foreign pod sharing the namespace out of the verdict. An
   * empty read is met — zero rendered objects is zero skew — but a read that
   * did not happen is **not**: see below.
   *
   * ponytail: this observes the **last** render, not the next — a Target with
   * nothing deployed reads green and a skew is caught one deploy late. §7's
   * "read at pin time" wants the chart's own declaration *before* anything is
   * applied, and the artifact that carries it is pinned by the Target's own
   * `OCIRepository` consumer — but only
   * source-controller inside the Target fetches it, and the
   * `argo-application` flavour has no artifact at all. Upgrade path: pull the
   * `charts.app` artifact from the registry here and read its annotations.
   */
  private async chartContract(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
  ): Promise<[boolean, string?]> {
    // "Nothing is rendered here yet" and "I was not allowed to look" are
    // different facts and only the first one is zero skew. Collapsing them —
    // an empty array standing in for a refusal, `every` over it vacuously
    // true — is a check reporting met without ever having observed the thing
    // it names, which is the exact shape this check replaced. So an unreadable
    // pod list is a prerequisite failure naming why, and the operator whose
    // Role was never bound is told to bind it rather than told everything is
    // fine.
    const unreadable = (why: string): [boolean, string] => [
      false,
      `Spindrift could not read the pods in ${connection.namespace} (${why}), so the value contract this Target renders under is unknown`,
    ];

    let pods: KubernetesObject[] | null;
    try {
      pods = await api.list({
        apiVersion: 'v1',
        plural: 'pods',
        namespace: connection.namespace,
      });
    } catch (cause) {
      return unreadable(
        cause instanceof KubernetesRequestError
          ? `the API server answered ${cause.status}`
          : String(cause),
      );
    }
    if (pods === null) return unreadable('the API server does not serve them');

    // Only what is desired *now* counts. A terminated pod is the residue of a
    // render that is over, so a Completed run of a job would otherwise hold a
    // Target red until the CronJob next fired; and of what is left only the
    // newest pod of each Component counts, so a rolling update reads the
    // render that is replacing the old one rather than reading both at once
    // and calling the overlap skew.
    //
    // Filtered here rather than by `fieldSelector` because the grouping has to
    // happen in this process anyway and a vessel namespace holds tens of pods,
    // not thousands.
    const newest = new Map<string, { contract: string; at: string }>();
    for (const pod of pods) {
      const contract =
        pod.metadata.annotations?.['spindrift.dev/values-contract'];
      if (contract === undefined) continue;
      const phase = (pod.status as { phase?: string } | undefined)?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue;
      // `spindrift-app.selectorLabels` — one App's one Component, and the one
      // grouping the chart itself guarantees is on every pod it renders.
      const labels = pod.metadata.labels ?? {};
      const component = `${labels['app.kubernetes.io/part-of']}/${labels['app.kubernetes.io/name']}`;
      const at = String(pod.metadata.creationTimestamp ?? '');
      const seen = newest.get(component);
      if (seen === undefined || at > seen.at) {
        newest.set(component, { contract, at });
      }
    }

    const found = [...new Set([...newest.values()].map((pod) => pod.contract))];
    // Met with nothing to say, rather than a sentence about a contract nobody
    // named: this Target has rendered nothing under the App chart.
    if (found.length === 0) return [true];

    return [
      found.every((contract) => contract === VALUES_CONTRACT),
      `this Target is running objects rendered under value contract ${found.join(', ')}; this Spindrift renders ${VALUES_CONTRACT}`,
    ];
  }

  /**
   * Whether the chart's source exists where the Target says it does, and
   * serves the chart this installation declares.
   */
  private async chartSource(
    api: KubernetesApi,
    delivery: KubernetesDelivery,
  ): Promise<[boolean, string?]> {
    if (delivery.flavour === 'argo-application') {
      // Argo resolves the repository itself, with credentials Spindrift never
      // sees, so there is nothing here to read. The honest check is that a
      // repository was named at all; a wrong one surfaces as a sync error on
      // the first deploy.
      return [
        delivery.repoUrl.length > 0,
        'this Target names no repository to fetch the App chart from',
      ];
    }
    // Whichever kind this installation's chart reference implies, and never
    // both: a cluster that carries a `GitRepository` of that name while the
    // installation deploys from OCI is a cluster this Target cannot deploy to,
    // and reading the wrong kind would report it green.
    const kind = chartSourceKind(this.options.chart);
    const source = await api.get({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: delivery.sourceRef.namespace,
      name: delivery.sourceRef.name,
    });
    if (source === null) {
      return [
        false,
        `this cluster has no ${kind.kind} ${delivery.sourceRef.namespace}/${delivery.sourceRef.name} to fetch the App chart from`,
      ];
    }
    // In the artifact form the reference the installation *declares* and the
    // artifact every Component *pulls* live in two places: `charts.app` names
    // the first, the source object's own `url` names the second, and the
    // rendered `chartRef` carries only the object. So a Target whose
    // `OCIRepository` points at another registry deploys a different chart
    // under this installation's declaration, and nothing else would say so.
    // The repository form has no such gap — the path is written into the
    // release itself.
    const url = (source.spec as { url?: string } | undefined)?.url;
    if (kind === OCI_REPOSITORY && url !== this.options.chart) {
      return [
        false,
        `${kind.kind} ${delivery.sourceRef.namespace}/${delivery.sourceRef.name} serves ${url ?? 'no artifact'}, not the ${this.options.chart} this installation declares`,
      ];
    }
    return [true];
  }

  /**
   * Whether the federated identity may write the delivery object.
   *
   * A `SelfSubjectAccessReview` is the one call that answers §13's "OIDC both
   * ways" without holding a credential: the API server answers about whoever
   * the request authenticated as, which is exactly what federation produced.
   */
  private async canWriteDelivery(
    api: KubernetesApi,
    delivery: KubernetesDelivery,
  ): Promise<boolean> {
    const kind = deliveryKind(delivery.flavour);
    const [group] = kind.apiVersion.split('/');
    try {
      const review = await api.create(
        {
          apiVersion: 'authorization.k8s.io/v1',
          plural: 'selfsubjectaccessreviews',
        },
        {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          metadata: { name: '' },
          spec: {
            resourceAttributes: {
              namespace: delivery.namespace,
              verb: 'create',
              group,
              resource: pluralOf(delivery.flavour),
            },
          },
        },
      );
      const status = review.status as { allowed?: boolean } | undefined;
      return status?.allowed === true;
    } catch {
      return false;
    }
  }

  private async reachableSecretStores(
    api: KubernetesApi,
  ): Promise<readonly StoreAdapter[]> {
    const stores = await api
      .list({
        apiVersion: SECRET_STORE.apiVersion,
        plural: SECRET_STORE.plural,
      })
      .catch(() => null);
    if (stores === null) return [];

    const found = new Set<StoreAdapter>();
    for (const store of stores) {
      const spec = store.spec as
        | { provider?: Record<string, unknown> }
        | undefined;
      for (const provider of Object.keys(spec?.provider ?? {})) {
        const adapter = STORE_PROVIDERS[provider];
        if (adapter !== undefined) found.add(adapter);
      }
    }
    return [...found];
  }

  private async discover(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
  ): Promise<TargetDiscovery> {
    const [nodes, storageClasses, postgres, valkey, egress, policy, stores] =
      await Promise.all([
        api.list({ apiVersion: 'v1', plural: 'nodes' }).catch(() => null),
        api
          .list({ apiVersion: 'storage.k8s.io/v1', plural: 'storageclasses' })
          .catch(() => null),
        api.servesKind(
          ENGINE_KINDS.postgres.apiVersion,
          ENGINE_KINDS.postgres.kind,
        ),
        api.servesKind(
          ENGINE_KINDS.valkey.apiVersion,
          ENGINE_KINDS.valkey.kind,
        ),
        api.servesKind(EGRESS_POLICY.apiVersion, EGRESS_POLICY.kind),
        this.policyEngine(api),
        this.reachableSecretStores(api),
      ]);

    const capacity = nodeCapacity(nodes ?? []);
    return {
      arch: capacity.arch,
      gpu: capacity.gpu,
      resourceCeiling: capacity.ceiling,
      persistence: (storageClasses ?? []).length > 0,
      postgres,
      valkey,
      egressFiltering: egress,
      policyEngine: policy,
      // §18: how far back a tail can honestly reach. The log store sits beside
      // the cluster rather than in it, so this is the operator's statement and
      // an unstated one is zero rather than a guess.
      logHistorySeconds: connection.logHistorySeconds ?? 0,
      servedHosts: connection.servedHosts ?? [],
      reachableRegistries: connection.reachableRegistries ?? [],
      reachableSecretStores: stores,
    };
  }

  /**
   * What the policy engine was found doing — installed, and in which mode.
   *
   * §32: `verifiedDeploy` "must discover **enforcing** mode, not merely
   * installed — under an audit-only policy a green deploy proves nothing". The
   * conclusion is core's to draw, so this reports both fields and neither
   * implication.
   */
  private async policyEngine(api: KubernetesApi): Promise<PolicyEngineState> {
    const installed = await api.servesKind(POLICY.apiVersion, POLICY.kind);
    if (!installed) return { installed: false, mode: null };

    const policies = await api
      .list({ apiVersion: POLICY.apiVersion, plural: POLICY.plural })
      .catch(() => null);
    const enforcing = (policies ?? []).some((policy) => {
      const spec = policy.spec as
        | {
            validationFailureAction?: string;
            rules?: { validate?: { failureAction?: string } }[];
          }
        | undefined;
      if (spec?.validationFailureAction === 'Enforce') return true;
      return (spec?.rules ?? []).some(
        (rule) => rule.validate?.failureAction === 'Enforce',
      );
    });
    return { installed: true, mode: enforcing ? 'ENFORCE' : 'AUDIT' };
  }

  // --- plumbing ------------------------------------------------------------

  private api(connection: KubernetesAdapterConnection): KubernetesApi {
    return new KubernetesApi({
      apiServer: connection.apiServer,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(
    target: DeployTarget,
  ): KubernetesAdapterConnection | null {
    return target.connection.adapter === 'kubernetes'
      ? target.connection
      : null;
  }

  private deliveryObject(
    connection: KubernetesAdapterConnection,
    desired: DesiredState,
    image: string,
  ): KubernetesObject {
    const name = releaseName(desired);
    const values = chartValues(desired, connection, image);
    const labels = {
      'app.kubernetes.io/managed-by': 'spindrift',
      'app.kubernetes.io/part-of': desired.app,
      'app.kubernetes.io/name': desired.component,
    };

    if (connection.delivery.flavour === 'argo-application') {
      return argoApplication({
        name,
        namespace: connection.delivery.namespace,
        destinationNamespace: connection.namespace,
        server: connection.delivery.server,
        project: connection.delivery.project,
        repoUrl: connection.delivery.repoUrl,
        revision: connection.delivery.revision,
        path: this.options.chart,
        labels,
        values,
      });
    }

    return helmRelease({
      name,
      namespace: connection.delivery.namespace,
      targetNamespace: connection.namespace,
      chart: this.options.chart,
      sourceRef: connection.delivery.sourceRef,
      labels,
      values,
    });
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

/** The half of a CronJob a run is made from. */
interface JobTemplate {
  readonly metadata?: {
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: Record<string, unknown>;
}

/** A refusal in the vocabulary both run verbs answer in (§17). */
function refuse(because: string): Extract<JobRuns, { kind: 'none' }> {
  return { kind: 'none', because };
}

/**
 * A run that has just been asked for.
 *
 * `running` with no start time, which is what it is: the API server has the
 * Job and the controller has not created a pod for it yet. Reporting anything
 * else would be this adapter guessing at a status it can read a moment later.
 */
function startingRun(name: string): JobExecution {
  return { name, outcome: 'running', startedAt: null };
}

/**
 * One Job as a run (§17).
 *
 * `Complete` and `Failed` are the only conditions that end a Job; everything
 * else on the list — `SuccessCriteriaMet`, `FailureTarget`, `Suspended` — is
 * the controller narrating, and a run narrating is a run still going.
 */
function jobExecution(job: KubernetesObject): JobExecution {
  const status = job.status as
    | {
        startTime?: string;
        conditions?: {
          type?: string;
          status?: string;
          reason?: string;
          message?: string;
        }[];
      }
    | undefined;
  const terminal = (status?.conditions ?? []).find(
    (condition) =>
      condition.status === 'True' &&
      (condition.type === 'Complete' || condition.type === 'Failed'),
  );
  const at = status?.startTime ?? job.metadata.creationTimestamp;
  const detail = terminal?.message ?? terminal?.reason;
  return {
    name: job.metadata.name,
    outcome:
      terminal === undefined
        ? 'running'
        : terminal.type === 'Complete'
          ? 'passed'
          : 'failed',
    startedAt: typeof at === 'string' ? new Date(at) : null,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** What a run sorts by. A run with no start time yet is the newest there is. */
function startedAtOf(execution: JobExecution): number {
  return execution.startedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

interface RuntimePosition {
  readonly at: string;
  readonly seen: number;
}

function runtimeCursor(
  cursor: string | undefined,
): Record<string, RuntimePosition> {
  if (cursor === undefined) return {};
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, RuntimePosition] => {
          const value = entry[1];
          return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as { at?: unknown }).at === 'string' &&
            typeof (value as { seen?: unknown }).seen === 'number' &&
            Number.isInteger((value as { seen: number }).seen) &&
            (value as { seen: number }).seen >= 0
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

function encodeRuntimeCursor(cursor: Record<string, RuntimePosition>): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function runtimePodIdentity(pod: KubernetesObject): string {
  const uid =
    typeof pod.metadata.uid === 'string' ? pod.metadata.uid : pod.metadata.name;
  const statuses = (
    pod.status as {
      containerStatuses?: { name?: string; restartCount?: number }[];
    } | null
  )?.containerStatuses;
  const app = statuses?.find((status) => status.name === 'app');
  return `${pod.metadata.name}:${uid}:${app?.restartCount ?? 0}`;
}

function runtimeLine(raw: string): {
  at: Date;
  cursorAt: string;
  line: string;
} {
  const separator = raw.indexOf(' ');
  if (separator > 0) {
    const timestamp = new Date(raw.slice(0, separator));
    if (!Number.isNaN(timestamp.getTime())) {
      return {
        at: timestamp,
        cursorAt: timestamp.toISOString(),
        line: raw.slice(separator + 1),
      };
    }
  }
  return { at: new Date(0), cursorAt: new Date(0).toISOString(), line: raw };
}

// --- flavour-shaped helpers ------------------------------------------------

type Flavour = KubernetesDelivery['flavour'];

function deliveryKind(flavour: Flavour): {
  apiVersion: string;
  kind: string;
} {
  return flavour === 'argo-application'
    ? { apiVersion: APPLICATION.apiVersion, kind: APPLICATION.kind }
    : { apiVersion: HELM_RELEASE.apiVersion, kind: HELM_RELEASE.kind };
}

function apiVersionOf(flavour: Flavour): string {
  return deliveryKind(flavour).apiVersion;
}

function pluralOf(flavour: Flavour): string {
  return flavour === 'argo-application'
    ? APPLICATION.plural
    : HELM_RELEASE.plural;
}

function statusOf(flavour: Flavour, object: KubernetesObject): DeliveryStatus {
  return flavour === 'argo-application'
    ? applicationStatus(object)
    : helmReleaseStatus(object);
}

/**
 * The values the delivery object was applied with — what the chart rendered.
 *
 * The one read of them, because the two flavours keep them in different places
 * and a second branch could only ever read one of the two wrongly.
 */
function valuesOf(
  flavour: Flavour,
  object: KubernetesObject,
): Record<string, unknown> {
  return flavour === 'argo-application'
    ? applicationValues(object)
    : helmReleaseValues(object);
}

/** The digest the delivery object was applied with — what is serving. */
function appliedDigest(flavour: Flavour, object: KubernetesObject): string {
  const app = valuesOf(flavour, object).app as
    | { artifactDigest?: string }
    | undefined;
  return app?.artifactDigest ?? '';
}

/** The longest name an object may carry, which every adapter shortens to. */
const RELEASE_NAME_LIMIT = 63;

/** One release per (Component, Target), so a re-deploy is an upgrade. */
function releaseName(desired: DesiredState): string {
  return workloadName(desired, RELEASE_NAME_LIMIT);
}

function resourceLabel(object: KubernetesObject): string {
  return `${object.kind}/${object.metadata.namespace}/${object.metadata.name}`;
}

/**
 * The adapter's own handle on what `apply` placed — opaque to core (§6).
 *
 * The flavour is part of it because an operator may change a Target's flavour,
 * and a ref that did not say which object it named would then be read against
 * the wrong kind.
 */
function refOf(flavour: Flavour, object: KubernetesObject): DeployRef {
  return `${flavour}:${object.metadata.namespace}/${object.metadata.name}`;
}

interface ParsedRef {
  flavour: Flavour;
  namespace: string;
  name: string;
}

function parseRef(ref: DeployRef): ParsedRef | null {
  const [flavour, path] = ref.split(':', 2);
  if (path === undefined) return null;
  if (flavour !== 'argo-application' && flavour !== 'flux-helmrelease') {
    return null;
  }
  const [namespace, name] = path.split('/', 2);
  if (namespace === undefined || name === undefined) return null;
  return { flavour, namespace, name };
}

/** A write that never landed, in §6's vocabulary. */
function writeFailure(
  cause: unknown,
  ref: DeployRef,
): Extract<DeployVerdict, { phase: 'FAILED' }> {
  if (cause instanceof KubernetesRequestError) {
    // A 4xx is the cluster refusing this object — an admission webhook, a
    // quota, an invalid spec — which §6 puts under one reason and blames on the
    // developer. Three of them are not that, and a 5xx is not either.
    //
    // 401 and 403 are Spindrift's own credential. A **404 on a write is the
    // address, never the object**: a server-side apply creates what is not
    // there, so the only things that can be missing are the namespace or the
    // API group — the Target, which the operator configured, not the spec the
    // developer wrote. Indicting the developer for a namespace that was deleted
    // sends them reading their chart values, and §6 calls blame the most useful
    // thing the UI knows. All three are `TARGET_UNREACHABLE`'s platform.
    const platformFailure =
      cause.status === 401 || cause.status === 403 || cause.status === 404;
    const rejected = cause.status >= 400 && cause.status < 500;
    return {
      phase: 'FAILED',
      ref,
      reason: rejected && !platformFailure ? 'REJECTED' : 'TARGET_UNREACHABLE',
      detail: cause.body || cause.message,
      debug: { status: cause.status, url: cause.url },
    };
  }
  return {
    phase: 'FAILED',
    ref,
    reason: 'TARGET_UNREACHABLE',
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * The address a Gateway answers on, or null while it has none.
 *
 * The first `IPAddress` entry, and deliberately not a `Hostname` one: what
 * reads this is `platform.dns.privateAddress`, which the App chart publishes as
 * an A record. A gateway whose only address is a name has nothing to put there,
 * and saying so leaves the field for the operator rather than filling it with
 * something the record cannot hold.
 */
function gatewayAddress(gateway: KubernetesObject): string | null {
  const status = gateway.status as
    | { addresses?: { type?: string; value?: string }[] }
    | undefined;
  const address = (status?.addresses ?? []).find(
    (entry) => entry.type !== 'Hostname' && (entry.value ?? '') !== '',
  );
  return address?.value ?? null;
}

/** What the nodes say this Target can run (§3's discovered half). */
function nodeCapacity(nodes: readonly KubernetesObject[]): {
  arch: readonly string[];
  gpu: boolean;
  ceiling: { cpu?: string; memory?: string };
} {
  const arch = new Set<string>();
  let gpu = false;
  let cpu: number | null = null;
  let memory: number | null = null;

  for (const node of nodes) {
    const labels = node.metadata.labels ?? {};
    const architecture = labels['kubernetes.io/arch'];
    if (architecture !== undefined) arch.add(architecture);

    const status = node.status as
      | { allocatable?: Record<string, string> }
      | undefined;
    const allocatable = status?.allocatable ?? {};
    if (Number(allocatable['nvidia.com/gpu'] ?? '0') > 0) gpu = true;

    const nodeCpu = cores(allocatable.cpu);
    if (nodeCpu !== null) cpu = Math.max(cpu ?? 0, nodeCpu);
    const nodeMemory = bytes(allocatable.memory);
    if (nodeMemory !== null) memory = Math.max(memory ?? 0, nodeMemory);
  }

  return {
    arch: [...arch].sort(),
    gpu,
    // The ceiling is the largest single workload the Target will admit (§3),
    // which is one node's allocatable — never the sum, because nothing here
    // schedules across nodes.
    ceiling: {
      ...(cpu === null ? {} : { cpu: String(cpu) }),
      ...(memory === null
        ? {}
        : { memory: `${Math.floor(memory / 1024 ** 2)}Mi` }),
    },
  };
}

function cores(quantity: string | undefined): number | null {
  if (quantity === undefined) return null;
  const millis = quantity.endsWith('m');
  const value = Number(millis ? quantity.slice(0, -1) : quantity);
  if (Number.isNaN(value)) return null;
  return millis ? value / 1000 : value;
}

const SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

function bytes(quantity: string | undefined): number | null {
  if (quantity === undefined) return null;
  const match = quantity.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
  if (!match) return null;
  const scale = match[2] === '' ? 1 : SUFFIXES[match[2] as string];
  if (scale === undefined) return null;
  return Number(match[1]) * scale;
}
