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
  PREREQUISITES,
  type PrerequisiteResult,
  type TargetDiscovery,
  type TargetInspection,
} from '../../../domain/capabilities.ts';
import type {
  ArtifactType,
  DesiredState,
} from '../../../domain/desired-state.ts';
import type {
  KubernetesConnection,
  KubernetesDelivery,
} from '../../../domain/target.ts';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  FailureReason,
  ObservedState,
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
  GIT_REPOSITORY,
  HELM_RELEASE,
  helmRelease,
  helmReleaseStatus,
  helmReleaseValues,
} from './flux-helmrelease.ts';
import type { DeliveryStatus } from './status.ts';
import { chartValues, imageReference, VALUES_CONTRACT } from './values.ts';

/** What the adapter needs that a Target's connection does not carry. */
export interface KubernetesAdapterOptions {
  /**
   * The chart, as this installation names it (§20's `charts.app`). A path
   * inside the Target's configured repository until the OCI swap.
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

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/** Which store a `ClusterSecretStore`'s provider key names (§10). */
const STORE_PROVIDERS: Record<string, StoreAdapter> = {
  onepassword: 'onepassword',
  gcpsm: 'gcp-secret-manager',
};

/** The CRDs a datastore engine is discovered by (§3, §11). */
const ENGINE_KINDS = {
  postgres: { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster' },
  redis: { apiVersion: 'redis.redis.opstreelabs.in/v1beta2', kind: 'Redis' },
} as const;

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
    const image = imageReference(desired);
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
      throw new Error(`${target.name} is not a Kubernetes Target`);
    }
    const api = this.api(connection);

    const [prerequisites, discovery] = await Promise.all([
      this.checklist(api, connection),
      this.discover(api, connection),
    ]);
    return { prerequisites, discovery };
  }

  // --- apply's second half -------------------------------------------------

  /**
   * Poll the object just written until it reaches a verdict.
   *
   * The cadence is fast because the window is bounded: §6's phases come from
   * the controller, and this is the only period in which they change quickly.
   * Once the attempt ends, nothing here keeps looking — the slow cadence that
   * detects drift belongs to core's loop, and lives on `observe`.
   */
  private async *awaitVerdict(
    api: KubernetesApi,
    connection: KubernetesConnection,
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
    connection: KubernetesConnection,
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
    connection: KubernetesConnection,
  ): Promise<readonly PrerequisiteResult[]> {
    const delivery = connection.delivery;
    const results = new Map<string, PrerequisiteResult>();
    const set = (
      name: (typeof PREREQUISITES)[number],
      met: boolean,
      detail?: string,
    ): void => {
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

    // §7: the chart declares its own value contract, read at pin time. Until
    // the OCI swap the pin is a branch, so skew is **detected** here rather
    // than prevented — the operator states what the pinned chart declares, and
    // a mismatch becomes a prerequisite failure in the existing grammar.
    const pinned = connection.chartContract;
    set(
      'CHART_CONTRACT',
      pinned === VALUES_CONTRACT,
      `the App chart at this Target declares value contract ${pinned}; this Spindrift renders ${VALUES_CONTRACT}`,
    );

    return PREREQUISITES.map(
      (name) =>
        results.get(name) ?? {
          name,
          met: false,
          detail: 'not assessed',
        },
    );
  }

  /** Whether the chart's source exists where the Target says it does. */
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
    const source = await api.get({
      apiVersion: GIT_REPOSITORY.apiVersion,
      plural: GIT_REPOSITORY.plural,
      namespace: delivery.sourceRef.namespace,
      name: delivery.sourceRef.name,
    });
    return [
      source !== null,
      `this cluster has no ${GIT_REPOSITORY.kind} ${delivery.sourceRef.namespace}/${delivery.sourceRef.name} to fetch the App chart from`,
    ];
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
      const status = review?.status as { allowed?: boolean } | undefined;
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
    connection: KubernetesConnection,
  ): Promise<TargetDiscovery> {
    const [nodes, storageClasses, postgres, redis, egress, policy, stores] =
      await Promise.all([
        api.list({ apiVersion: 'v1', plural: 'nodes' }).catch(() => null),
        api
          .list({ apiVersion: 'storage.k8s.io/v1', plural: 'storageclasses' })
          .catch(() => null),
        api.servesKind(
          ENGINE_KINDS.postgres.apiVersion,
          ENGINE_KINDS.postgres.kind,
        ),
        api.servesKind(ENGINE_KINDS.redis.apiVersion, ENGINE_KINDS.redis.kind),
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
      redis,
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

  private api(connection: KubernetesConnection): KubernetesApi {
    return new KubernetesApi({
      apiServer: connection.apiServer,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): KubernetesConnection | null {
    return target.connection.adapter === 'kubernetes'
      ? target.connection
      : null;
  }

  private deliveryObject(
    connection: KubernetesConnection,
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

/** The digest the delivery object was applied with — what is serving. */
function appliedDigest(flavour: Flavour, object: KubernetesObject): string {
  const values =
    flavour === 'argo-application'
      ? applicationValues(object)
      : helmReleaseValues(object);
  const app = values.app as { artifactDigest?: string } | undefined;
  return app?.artifactDigest ?? '';
}

/** One release per (Component, Target), so a re-deploy is an upgrade. */
function releaseName(desired: DesiredState): string {
  return `${desired.app}-${desired.component}`.slice(0, 63);
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
    // quota, an invalid spec — which §6 puts under one reason. A 5xx or an
    // auth failure is the cluster being unavailable to Spindrift, which is a
    // different blame entirely.
    const rejected = cause.status >= 400 && cause.status < 500;
    const authFailure = cause.status === 401 || cause.status === 403;
    return {
      phase: 'FAILED',
      ref,
      reason: rejected && !authFailure ? 'REJECTED' : 'TARGET_UNREACHABLE',
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
