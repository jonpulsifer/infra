/**
 * The Kubernetes deploy adapter: applies a Flux `HelmRelease` or Argo
 * `Application` through the API, then polls it for a bounded window. It never
 * watches: a watch across a WAN tunnel can die while still looking connected.
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
  appNamespaceFor,
  type KubernetesAdapterConnection,
  type KubernetesDelivery,
  namespaceRefusal,
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
  JobExecution,
  JobRuns,
  ObservedState,
  Restarted,
  RunOptions,
  RuntimeLogEntry,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
  StartedRun,
} from '../contract.ts';
import { RESTART_STAMP } from '../contract.ts';
import { type DeployEvents, deployEvents, internalFailure } from '../events.ts';
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
  argoChartRef,
  argoRepository,
} from './argo-application.ts';
import { diagnose, evidence } from './diagnose.ts';
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

export interface KubernetesAdapterOptions {
  /**
   * The installation's `charts.app`: an `oci://` artifact or a repository path.
   * Every chart source read and write goes through `chartSourceKind`.
   */
  readonly chart: string;
  /** Mints a bearer token per request. Never a stored credential. */
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT`. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const RUNTIME_LOG_LIMIT_BYTES = 256 * 1024;

/** `ClusterSecretStore` provider keys, mapped to store adapters. */
const STORE_PROVIDERS: Record<string, StoreAdapter> = {
  onepassword: 'onepassword',
  gcpsm: 'gcp-secret-manager',
};

/** Imported so the kind discovered is the kind the datastore adapter writes. */
const ENGINE_KINDS = DATASTORE_ENGINE_KINDS;

/** The policy engine `verifiedDeploy` is derived from. */
const POLICY = {
  apiVersion: 'kyverno.io/v1',
  kind: 'ClusterPolicy',
  plural: 'clusterpolicies',
} as const;

/** The CNI object that means egress can be filtered by name. */
const EGRESS_POLICY = {
  apiVersion: 'cilium.io/v2',
  kind: 'CiliumNetworkPolicy',
} as const;

const SECRET_STORE = {
  apiVersion: 'external-secrets.io/v1',
  kind: 'ClusterSecretStore',
  plural: 'clustersecretstores',
} as const;

const CRON_JOB = {
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  plural: 'cronjobs',
} as const;

const JOB = { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs' } as const;

/** The Job controller's run label; the unprefixed twin is deprecated. */
const JOB_NAME_LABEL = 'batch.kubernetes.io/job-name';

/** What `kubectl create job --from` marks a run somebody asked for. */
const MANUAL_RUN = 'cronjob.kubernetes.io/instantiate';

/** Parameter names only, never values: the timeline shows this. */
const RUN_WITH = 'spindrift.dev/run-with';

/** A pod adds six characters to its Job's name and must fit a DNS label (63). */
const RUN_NAME_LIMIT = 57;

/** Copied by prefix, so enforce, audit, warn and version pins carry over. */
const POD_SECURITY_PREFIX = 'pod-security.kubernetes.io/';

/** Read only by {@link KubernetesDeployAdapter.probe}. */
const GATEWAY = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'Gateway',
  plural: 'gateways',
} as const;

export class KubernetesDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'kubernetes';
  readonly artifactTypes: readonly ArtifactType[] = ['image'];

  private readonly events: DeployEvents;

  constructor(private readonly options: KubernetesAdapterOptions) {
    this.events = deployEvents(options.now);
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return internalFailure('this Target is not a Kubernetes Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `kubernetes does not accept a ${desired.artifact.type} artifact`,
      );
    }
    const image = imageReference(desired, connection.reachableRegistries ?? []);
    if (image === null) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure('the artifact carries no address to pull it by');
    }

    // Both halves of the name are human-chosen, so an illegal combination is
    // refused, never truncated into a name the operator cannot find.
    const refusal = namespaceRefusal(connection, desired.app);
    if (refusal !== null) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(refusal);
    }

    const api = this.api(connection);
    const admission = await this.admissionLabels(api, connection);
    const object = this.deliveryObject(connection, desired, image, admission);
    const ref = refOf(connection.delivery.flavour, object);

    yield this.events.status('APPLYING', { resource: resourceLabel(object) });
    try {
      // Before the release, and only on Flux: Argo creates its namespace.
      if (connection.delivery.flavour === 'flux-helmrelease') {
        await this.ensureNamespace(
          api,
          appNamespaceFor(connection, desired.app),
          admission,
        );
      }
      await api.apply(object, pluralOf(connection.delivery.flavour));
    } catch (cause) {
      const verdict = writeFailure(cause, ref);
      yield this.events.status('FAILED', { reason: verdict.reason });
      return verdict;
    }
    yield this.events.log(
      `applied ${resourceLabel(object)}`,
      resourceLabel(object),
    );

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

    const api = this.api(connection);
    const object = await api.get({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (object === null) return null;

    const status = await this.workloadStatus(
      api,
      parsed.flavour,
      object,
      statusOf(parsed.flavour, object),
    );
    return {
      ref,
      phase: status.phase,
      artifactDigest: appliedDigest(parsed.flavour, object),
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
      ...(status.debug === undefined ? {} : { debug: status.debug }),
    };
  }

  /**
   * Flux's `Ready` judges the last reconcile, not a crash since, so a ready
   * service still fails when its Deployment reports `Available=False`.
   */
  private async workloadStatus(
    api: KubernetesApi,
    flavour: Flavour,
    object: KubernetesObject,
    status: DeliveryStatus,
  ): Promise<DeliveryStatus> {
    if (status.phase !== 'LIVE') return status;
    const placed = placedWorkload(flavour, object);
    if (placed === null || placed.kind === 'job') return status;

    const [deployment] =
      (await api
        .list(
          {
            apiVersion: 'apps/v1',
            plural: 'deployments',
            namespace: placed.namespace,
          },
          { labelSelector: placed.selector },
        )
        .catch(() => null)) ?? [];
    if (deployment === undefined) return status;
    // Only an explicit `False`: a condition not yet written would have
    // `diagnose` blame the developer for an empty pod list.
    const available = conditionOf(deployment, 'Available');
    if (available?.status !== 'False') return status;

    const { pods, events } = await this.readOnRed(
      api,
      placed.namespace,
      placed.selector,
    );
    const diagnosis = diagnose(
      pods,
      events,
      available.message ?? 'the workload is no longer available',
    );
    return {
      phase: 'FAILED',
      reason: diagnosis.reason,
      detail: diagnosis.detail,
      debug: {
        delivery: status.debug,
        workload: conditionsOf(deployment),
        diagnosis: diagnosis.debug,
      },
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const parsed = parseRef(ref);
    if (parsed === null) return;
    await this.api(connection).delete({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
  }

  /**
   * Deletes the App's namespace, which no ref names and nothing else collects.
   * Refuses one without our managed-by label: an operator declared that one.
   */
  async sweepApp(target: DeployTarget, app: string): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const name = appNamespaceFor(connection, app);
    const api = this.api(connection);
    const namespace = await api.get({
      apiVersion: 'v1',
      plural: 'namespaces',
      name,
    });
    // Gone, or never created because the write path refused the name.
    if (namespace === null) return;
    const labels = (namespace.metadata?.labels ?? {}) as Record<string, string>;
    if (labels['app.kubernetes.io/managed-by'] !== 'spindrift') {
      throw new Error(
        `namespace ${name} carries no app.kubernetes.io/managed-by=spindrift, so it is not Spindrift's to delete`,
      );
    }
    await api.delete({ apiVersion: 'v1', plural: 'namespaces', name });
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
    // A run's pods also carry the Component's labels, so one more term narrows
    // the tail to that run.
    const selector = [
      `app.kubernetes.io/name=${subject.component}`,
      `app.kubernetes.io/part-of=${subject.app}`,
      ...(subject.execution === undefined
        ? []
        : [`${JOB_NAME_LABEL}=${subject.execution}`]),
    ].join(',');
    // Not namespaced: a tail has no ref to say which namespace the release
    // chose, and the selector already names one Component.
    const pods =
      (await api.list(
        { apiVersion: 'v1', plural: 'pods' },
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
      // The pod's own namespace, because the list above was not namespaced.
      const text = await api.logs(
        pod.metadata.namespace ?? '',
        pod.metadata.name,
        {
          container: 'app',
          timestamps: true,
          ...(prior === undefined
            ? { tailLines: limit }
            : { sinceTime: prior.at }),
          limitBytes: RUNTIME_LOG_LIMIT_BYTES,
        },
      );
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
      // Always the normalized offsets, which drop positions for pods that are
      // gone or restarted.
      cursor: entries.at(-1)?.cursor ?? encodeRuntimeCursor(next),
      reach: connection.logHistorySeconds ?? 0,
    };
  }

  /**
   * Creates a Job from the CronJob's `jobTemplate`, owned by the CronJob so its
   * history limit prunes it. `Forbid` concurrency cannot hold a manual run off.
   */
  async run(
    target: DeployTarget,
    ref: DeployRef,
    options: RunOptions = {},
  ): Promise<StartedRun> {
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
          namespace: placed.namespace,
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

    // Named by the second it was asked for, so a double press in one second
    // is one run: the second create gets a 409.
    const name = workloadName(
      {
        app: owner.metadata.name,
        component: String(Math.floor(this.events.now() / 1_000)),
      },
      RUN_NAME_LIMIT,
    );
    const uid = owner.metadata.uid;
    const parameters = Object.entries(options.env ?? {});
    const run: KubernetesObject = {
      apiVersion: JOB.apiVersion,
      kind: JOB.kind,
      metadata: {
        name,
        namespace: placed.namespace,
        ...(template.metadata?.labels === undefined
          ? {}
          : { labels: template.metadata.labels }),
        annotations: {
          ...template.metadata?.annotations,
          [MANUAL_RUN]: 'manual',
          ...(parameters.length === 0
            ? {}
            : { [RUN_WITH]: parameters.map(([key]) => key).join(', ') }),
        },
        // The controller warns UnexpectedJob until the run ends. No
        // `blockOwnerDeletion`: it needs finalizer rights on the CronJob.
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
      spec:
        parameters.length === 0
          ? template.spec
          : withRunEnv(template.spec, parameters),
    };

    let created: KubernetesObject;
    try {
      created = await api.create(
        {
          apiVersion: JOB.apiVersion,
          plural: JOB.plural,
          namespace: placed.namespace,
        },
        run,
      );
    } catch (cause) {
      // This second's run already exists: a double press is one run.
      if (cause instanceof KubernetesRequestError && cause.status === 409) {
        return { kind: 'started', execution: startingRun(name) };
      }
      throw cause;
    }
    return { kind: 'started', execution: startingRun(created.metadata.name) };
  }

  /**
   * Re-applies the delivery object with `shared.podAnnotations[RESTART_STAMP]`
   * set, which the chart puts on the pod template. Jobs are refused.
   */
  async restart(target: DeployTarget, ref: DeployRef): Promise<Restarted> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return refuse(`${targetLabel(target)} is not a Kubernetes Target`);
    }
    const parsed = parseRef(ref);
    if (parsed === null) {
      return refuse('this Deploy carries no handle on what it placed');
    }
    const api = this.api(connection);
    const object = await api.get({
      apiVersion: apiVersionOf(parsed.flavour),
      plural: pluralOf(parsed.flavour),
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (object === null) {
      return refuse(`${parsed.name} is no longer on this Target`);
    }
    const values = valuesOf(parsed.flavour, object);
    if ((values.app as { kind?: unknown } | undefined)?.kind === 'job') {
      return refuse(
        'this Component is a job, which has runs rather than a process to restart',
      );
    }

    const at = new Date(this.events.now()).toISOString();
    const shared = (values.shared ?? {}) as Record<string, unknown>;
    const podAnnotations = (shared.podAnnotations ?? {}) as Record<
      string,
      string
    >;
    // `withValues` keeps `resourceVersion`, so a deploy landing between the
    // read and this write gets a 409, never the old digest re-applied.
    await api.apply(
      withValues(parsed.flavour, object, {
        ...values,
        shared: {
          ...shared,
          podAnnotations: { ...podAnnotations, [RESTART_STAMP]: at },
        },
      }),
      pluralOf(parsed.flavour),
    );
    return {
      kind: 'restarted',
      detail: `${resourceLabel(object)} stamped ${RESTART_STAMP}=${at}; the controller is replacing the pods`,
    };
  }

  /** Listed by label, which every run carries however it was started. */
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
        namespace: placed.namespace,
      },
      { labelSelector: placed.selector },
    );
    // `null` means the namespace or `batch/v1` is missing, not that the job
    // never ran, so it throws as a 403 would.
    if (jobs === null) {
      throw new Error(
        `the API server answered 404 listing ${JOB.plural} in ${placed.namespace} — that namespace or ${JOB.apiVersion} is not there`,
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
   * Read off the delivery object's values: the chart's fullname truncates
   * differently from {@link workloadName}, so the ref cannot derive it.
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
        readonly namespace: string;
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
    const namespace = workloadNamespace(parsed.flavour, object);
    if (namespace === null) {
      return refuse(
        `${parsed.name} does not say which namespace it renders in`,
      );
    }
    return {
      kind: 'job',
      app: app.name,
      component: app.component,
      // The chart's selector labels, on every pod a run creates.
      selector: `app.kubernetes.io/name=${app.component},app.kubernetes.io/part-of=${app.name}`,
      namespace,
    };
  }

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
    // A cluster is its only surface, so reaching here answers it. An API server
    // that does not answer throws above, and core reads that as undetermined.
    return { prerequisites, discovery, surface: { kind: 'carried' } };
  }

  /** Each read is caught alone; only an unanswered address is fatal. */
  async probe(apiServer: string): Promise<ClusterProbe> {
    const api = new KubernetesApi({
      apiServer,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });

    // Every authenticated identity may read discovery, so a failure here is
    // the address, not permissions.
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
      // Only the kind this installation's chart reference needs.
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

  /**
   * Polls the object just written until a verdict or the deadline. Each new
   * controller message becomes a log line, so progress within a phase shows.
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
      this.events.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // `apply` already emitted APPLYING, so a status lagging its generation
    // does not repeat it.
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
        yield this.events.status(status.phase, {
          resource,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }

      // Skipped on terminal phases, whose sentence the verdict carries.
      if (
        status.detail !== undefined &&
        status.detail !== said &&
        status.phase !== 'LIVE' &&
        status.phase !== 'FAILED'
      ) {
        said = status.detail;
        yield this.events.log(status.detail, resource);
      }

      if (status.phase === 'LIVE') {
        // No `url`: on a cluster, core mints the canonical name.
        return { phase: 'LIVE', ref };
      }

      if (status.phase === 'FAILED') {
        return yield* this.failed(api, connection, desired, status, ref);
      }

      if (this.events.now() >= deadline) {
        return yield* this.timedOut(
          api,
          connection,
          desired,
          status,
          ref,
          resource,
        );
      }

      await this.wait();
    }
  }

  private async *failed(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
    desired: DesiredState,
    status: DeliveryStatus,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    if (status.reason !== undefined) {
      // The delivery object already named a reason; pods would add nothing.
      return {
        phase: 'FAILED',
        ref,
        reason: status.reason,
        ...(status.detail === undefined ? {} : { detail: status.detail }),
        debug: status.debug,
      };
    }

    const { pods, events } = await this.readOnRed(
      api,
      appNamespaceFor(connection, desired.app),
      componentSelector(desired.app, desired.component),
    );
    const diagnosis = diagnose(pods, events, status.detail);
    yield this.events.log(diagnosis.detail);
    return {
      phase: 'FAILED',
      ref,
      reason: diagnosis.reason,
      detail: diagnosis.detail,
      debug: { delivery: status.debug, diagnosis: diagnosis.debug },
    };
  }

  /**
   * Reads pods and events as a failure does, minus {@link diagnose}'s fallback,
   * so with no evidence the verdict stays `TIMEOUT`.
   */
  private async *timedOut(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
    desired: DesiredState,
    status: DeliveryStatus,
    ref: DeployRef,
    resource: string,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const { pods, events } = await this.readOnRed(
      api,
      appNamespaceFor(connection, desired.app),
      componentSelector(desired.app, desired.component),
    );
    const found = evidence(pods, events, status.detail);

    yield this.events.status('FAILED', {
      resource,
      reason: found?.reason ?? 'TIMEOUT',
    });

    if (found === null) {
      return {
        phase: 'FAILED',
        ref,
        reason: 'TIMEOUT',
        detail: status.detail ?? 'the release did not settle in time',
        debug: status.debug,
      };
    }

    yield this.events.log(found.detail);
    return {
      phase: 'FAILED',
      ref,
      reason: found.reason,
      detail: found.detail,
      debug: { delivery: status.debug, diagnosis: found.debug },
    };
  }

  /** A list that throws reads as empty, so the verdict is never lost. */
  private async readOnRed(
    api: KubernetesApi,
    namespace: string,
    selector: string,
  ): Promise<{
    readonly pods: readonly KubernetesObject[];
    readonly events: readonly KubernetesObject[];
  }> {
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
    return { pods: pods ?? [], events: events ?? [] };
  }

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

    // Every App namespace copies its admission labels from the Target's
    // declared namespace, so that namespace must exist and carry them.
    const admission = await this.admissionLabels(api, connection);
    set(
      'VESSEL',
      Object.keys(admission).length > 0,
      `namespace ${connection.namespace} is absent or carries no ${POD_SECURITY_PREFIX} labels, and it is what every App namespace's admission policy is copied from (§7)`,
    );

    set('CHART_CONTRACT', ...(await this.chartContract(api)));

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
   * Whether running pods were rendered under this build's value contract. Helm
   * ignores unknown values, so a skewed release would otherwise deploy green.
   *
   * ponytail: reads the last render, so skew shows one deploy late. Upgrade:
   * pull the `charts.app` artifact here and read its annotations before apply.
   */
  private async chartContract(api: KubernetesApi): Promise<[boolean, string?]> {
    // Unreadable pods fail the check: only an empty read is zero skew.
    const unreadable = (why: string): [boolean, string] => [
      false,
      `Spindrift could not read this cluster's pods (${why}), so the value contract this Target renders under is unknown`,
    ];

    let pods: KubernetesObject[] | null;
    try {
      // Cluster-wide, since each App has its own namespace. Pods without the
      // chart's annotation are skipped below.
      pods = await api.list({
        apiVersion: 'v1',
        plural: 'pods',
      });
    } catch (cause) {
      return unreadable(
        cause instanceof KubernetesRequestError
          ? `the API server answered ${cause.status}`
          : String(cause),
      );
    }
    if (pods === null) return unreadable('the API server does not serve them');

    // Only the newest live pod per Component counts, so a finished job run or
    // a rolling update's old pods never read as skew.
    const newest = new Map<string, { contract: string; at: string }>();
    for (const pod of pods) {
      const contract =
        pod.metadata.annotations?.['spindrift.dev/values-contract'];
      if (contract === undefined) continue;
      const phase = (pod.status as { phase?: string } | undefined)?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue;
      // The chart's selector labels: one App's one Component.
      const labels = pod.metadata.labels ?? {};
      const component = `${labels['app.kubernetes.io/part-of']}/${labels['app.kubernetes.io/name']}`;
      const at = String(pod.metadata.creationTimestamp ?? '');
      const seen = newest.get(component);
      if (seen === undefined || at > seen.at) {
        newest.set(component, { contract, at });
      }
    }

    const found = [...new Set([...newest.values()].map((pod) => pod.contract))];
    // Nothing rendered under the App chart yet.
    if (found.length === 0) return [true];

    return [
      found.every((contract) => contract === VALUES_CONTRACT),
      `this Target is running objects rendered under value contract ${found.join(', ')}; this Spindrift renders ${VALUES_CONTRACT}`,
    ];
  }

  /** Whether the Target's chart source exists and serves the declared chart. */
  private async chartSource(
    api: KubernetesApi,
    delivery: KubernetesDelivery,
  ): Promise<[boolean, string?]> {
    if (delivery.flavour === 'argo-application') {
      // Argo fetches the chart itself, so there is no source object to read.
      // For OCI, the Target's registry must be the one the reference names.
      if (chartSourceKind(this.options.chart) === OCI_REPOSITORY) {
        const declared = argoChartRef(this.options.chart).repository;
        return [
          argoRepository(delivery.repoUrl) === declared,
          `this Target fetches the App chart from ${delivery.repoUrl.length > 0 ? delivery.repoUrl : 'no repository at all'}, not the ${declared} that serves the ${this.options.chart} this installation declares`,
        ];
      }
      return [
        delivery.repoUrl.length > 0,
        'this Target names no repository to fetch the App chart from',
      ];
    }
    // Only the kind the chart reference implies: the other kind reads green.
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
    // `chartRef` names only the object, so a mismatched `url` would deploy a
    // different chart under this installation's declaration.
    const url = (source.spec as { url?: string } | undefined)?.url;
    if (kind === OCI_REPOSITORY && url !== this.options.chart) {
      return [
        false,
        `${kind.kind} ${delivery.sourceRef.namespace}/${delivery.sourceRef.name} serves ${url ?? 'no artifact'}, not the ${this.options.chart} this installation declares`,
      ];
    }
    return [true];
  }

  /** A `SelfSubjectAccessReview` answers for the federated identity itself. */
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
      // The log store sits outside the cluster, so this is the operator's
      // statement; unstated is zero.
      logHistorySeconds: connection.logHistorySeconds ?? 0,
      servedHosts: connection.servedHosts ?? [],
      reachableRegistries: connection.reachableRegistries ?? [],
      reachableSecretStores: stores,
    };
  }

  /** Installed and mode only; core decides what either implies. */
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
    admission: Record<string, string>,
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
        destinationNamespace: appNamespaceFor(connection, desired.app),
        server: connection.delivery.server,
        project: connection.delivery.project,
        repoUrl: connection.delivery.repoUrl,
        revision: connection.delivery.revision,
        chart: this.options.chart,
        labels,
        values,
        // Argo creates the namespace with these labels. The managed-by label
        // lets `sweepApp` tell it from one an operator declared.
        namespaceMetadata: {
          ...admission,
          'app.kubernetes.io/managed-by': 'spindrift',
        },
      });
    }

    return helmRelease({
      name,
      namespace: connection.delivery.namespace,
      targetNamespace: appNamespaceFor(connection, desired.app),
      chart: this.options.chart,
      sourceRef: connection.delivery.sourceRef,
      labels,
      values,
    });
  }

  /**
   * The Pod Security labels on the Target's declared namespace, so Flux keeps
   * owning admission policy. Empty when unreadable.
   */
  private async admissionLabels(
    api: KubernetesApi,
    connection: KubernetesAdapterConnection,
  ): Promise<Record<string, string>> {
    const namespace = await api
      .get({
        apiVersion: 'v1',
        plural: 'namespaces',
        name: connection.namespace,
      })
      .catch(() => null);
    const labels = (namespace?.metadata?.labels ?? {}) as Record<
      string,
      string
    >;
    return Object.fromEntries(
      Object.entries(labels).filter(([key]) =>
        key.startsWith(POD_SECURITY_PREFIX),
      ),
    );
  }

  /**
   * Flux only, since `install.createNamespace` takes no labels. Refuses without
   * admission labels, which would admit pods the vessel should refuse.
   */
  private async ensureNamespace(
    api: KubernetesApi,
    name: string,
    admission: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(admission).length === 0) {
      throw new Error(
        `no ${POD_SECURITY_PREFIX} labels could be read from the Target's declared namespace, so an App namespace created now would admit pods this vessel refuses`,
      );
    }
    await api.apply(
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name,
          labels: {
            ...admission,
            'app.kubernetes.io/managed-by': 'spindrift',
            'app.kubernetes.io/part-of': 'spindrift',
          },
        },
      },
      'namespaces',
    );
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

interface JobTemplate {
  readonly metadata?: {
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: Record<string, unknown>;
}

/**
 * Appended after the template's `env`: a duplicated name resolves to its last
 * entry. Every container, since guessing which is the workload is worse.
 */
function withRunEnv(
  spec: Record<string, unknown>,
  parameters: readonly (readonly [string, string])[],
): Record<string, unknown> {
  const pod = (spec.template as { spec?: Record<string, unknown> } | undefined)
    ?.spec;
  const containers = pod?.containers;
  if (!Array.isArray(containers)) return spec;
  const env = parameters.map(([name, value]) => ({ name, value }));
  return {
    ...spec,
    template: {
      ...(spec.template as Record<string, unknown>),
      spec: {
        ...pod,
        containers: containers.map((container: Record<string, unknown>) => ({
          ...container,
          env: [...(Array.isArray(container.env) ? container.env : []), ...env],
        })),
      },
    },
  };
}

function refuse(because: string): Extract<JobRuns, { kind: 'none' }> {
  return { kind: 'none', because };
}

/** No start time yet: the controller has not created a pod. */
function startingRun(name: string): JobExecution {
  return { name, outcome: 'running', startedAt: null };
}

/** Only `Complete` and `Failed` end a Job; other conditions mean it runs. */
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
  const ranWith = job.metadata.annotations?.[RUN_WITH];
  const ended = terminal?.message ?? terminal?.reason;
  const detail = [
    ...(ranWith === undefined ? [] : [`ran with ${ranWith}`]),
    ...(ended === undefined ? [] : [ended]),
  ].join(' · ');
  return {
    name: job.metadata.name,
    outcome:
      terminal === undefined
        ? 'running'
        : terminal.type === 'Complete'
          ? 'passed'
          : 'failed',
    startedAt: typeof at === 'string' ? new Date(at) : null,
    ...(detail === '' ? {} : { detail }),
  };
}

/** A run with no start time yet sorts as the newest. */
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

function valuesOf(
  flavour: Flavour,
  object: KubernetesObject,
): Record<string, unknown> {
  return flavour === 'argo-application'
    ? applicationValues(object)
    : helmReleaseValues(object);
}

/**
 * Sends back only name, labels and spec, never server-owned fields, plus
 * `resourceVersion` as the precondition `restart` relies on.
 */
function withValues(
  flavour: Flavour,
  object: KubernetesObject,
  values: Record<string, unknown>,
): KubernetesObject {
  const { name, namespace, labels, resourceVersion } = object.metadata;
  const spec = (object.spec ?? {}) as Record<string, unknown>;
  const source = (spec.source ?? {}) as Record<string, unknown>;
  const helm = (source.helm ?? {}) as Record<string, unknown>;
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    metadata: {
      name,
      ...(namespace === undefined ? {} : { namespace }),
      ...(labels === undefined ? {} : { labels }),
      ...(typeof resourceVersion === 'string' ? { resourceVersion } : {}),
    },
    spec:
      flavour === 'argo-application'
        ? {
            ...spec,
            source: { ...source, helm: { ...helm, valuesObject: values } },
          }
        : { ...spec, values },
  };
}

/** Read off the object: a release may predate per-App namespaces. */
function workloadNamespace(
  flavour: Flavour,
  object: KubernetesObject,
): string | null {
  const spec = object.spec as
    | {
        targetNamespace?: unknown;
        destination?: { namespace?: unknown };
      }
    | undefined;
  const stated =
    flavour === 'argo-application'
      ? spec?.destination?.namespace
      : spec?.targetNamespace;
  return typeof stated === 'string' && stated.length > 0 ? stated : null;
}

/** The chart's selector labels, on every object it renders. */
function componentSelector(app: string, component: string): string {
  return `app.kubernetes.io/name=${component},app.kubernetes.io/part-of=${app}`;
}

/** Read off the values for the same reason as `placedJob`. */
function placedWorkload(
  flavour: Flavour,
  object: KubernetesObject,
): {
  readonly kind: string;
  readonly namespace: string;
  readonly selector: string;
} | null {
  const app = valuesOf(flavour, object).app as
    | { name?: unknown; component?: unknown; kind?: unknown }
    | undefined;
  const namespace = workloadNamespace(flavour, object);
  if (
    typeof app?.name !== 'string' ||
    typeof app.component !== 'string' ||
    namespace === null
  ) {
    return null;
  }
  return {
    kind: typeof app.kind === 'string' ? app.kind : 'service',
    namespace,
    selector: componentSelector(app.name, app.component),
  };
}

interface ObjectCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

function conditionsOf(object: KubernetesObject): ObjectCondition[] {
  const status = object.status as
    | { conditions?: ObjectCondition[] }
    | undefined;
  return status?.conditions ?? [];
}

function conditionOf(
  object: KubernetesObject,
  type: string,
): ObjectCondition | null {
  return conditionsOf(object).find((entry) => entry.type === type) ?? null;
}

function appliedDigest(flavour: Flavour, object: KubernetesObject): string {
  const app = valuesOf(flavour, object).app as
    | { artifactDigest?: string }
    | undefined;
  return app?.artifactDigest ?? '';
}

/** A DNS label's length limit. */
const RELEASE_NAME_LIMIT = 63;

/** One release per Component and Target, so a re-deploy is an upgrade. */
function releaseName(desired: DesiredState): string {
  return workloadName(desired, RELEASE_NAME_LIMIT);
}

function resourceLabel(object: KubernetesObject): string {
  return `${object.kind}/${object.metadata.namespace}/${object.metadata.name}`;
}

/** Carries the flavour, which an operator may change on the Target later. */
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

function writeFailure(
  cause: unknown,
  ref: DeployRef,
): Extract<DeployVerdict, { phase: 'FAILED' }> {
  if (cause instanceof KubernetesRequestError) {
    // A 4xx is the cluster refusing the object, except 401 and 403 (our
    // credential) and 404: apply creates, so the namespace or group is missing.
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

/** Never a hostname: `platform.dns.privateAddress` becomes an A record. */
function gatewayAddress(gateway: KubernetesObject): string | null {
  const status = gateway.status as
    | { addresses?: { type?: string; value?: string }[] }
    | undefined;
  const address = (status?.addresses ?? []).find(
    (entry) => entry.type !== 'Hostname' && (entry.value ?? '') !== '',
  );
  return address?.value ?? null;
}

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
    // One node's allocatable, never the sum: a pod runs on one node.
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
