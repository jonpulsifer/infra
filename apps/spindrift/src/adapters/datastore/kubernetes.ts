/**
 * Datastores on a Kubernetes Target: a server-side apply of an operator's
 * custom resource, then a poll. The operator on the far side is the controller.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { isLabel } from '../../domain/naming.ts';
import {
  datastoreNamespaceFor,
  type KubernetesAdapterConnection,
  targetLabel,
} from '../../domain/target.ts';
import type {
  DeployPhase,
  DeployTarget,
  FailureReason,
} from '../deploy/contract.ts';
import {
  type Fetcher,
  KubernetesApi,
  type KubernetesObject,
  type TokenProvider,
} from '../deploy/kubernetes/api.ts';
import { REJECTION_EVENTS } from '../deploy/kubernetes/diagnose.ts';
import type {
  DatastoreAdapter,
  DatastoreConnection,
  DatastoreEngine,
  DatastoreRef,
  DatastoreRequest,
  DatastoreState,
} from './contract.ts';

/**
 * The operator serving each engine; capability discovery probes these same
 * kinds. `podLabel` is an operator convention whose value is the resource's
 * name. If an operator renames it, policies select nothing and deny holds.
 */
export const ENGINE_KINDS = {
  postgres: {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    plural: 'clusters',
    podLabel: 'cnpg.io/cluster',
  },
  valkey: {
    apiVersion: 'valkey.io/v1alpha1',
    kind: 'ValkeyCluster',
    plural: 'valkeyclusters',
    podLabel: 'valkey.io/cluster',
  },
} as const satisfies Record<
  DatastoreEngine,
  { apiVersion: string; kind: string; plural: string; podLabel: string }
>;

const NETWORK_POLICY = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  plural: 'networkpolicies',
} as const;

/**
 * Both operators suffix this name for child objects and pods; 50 leaves room
 * for every suffix. Refused, never truncated, because a human typed it.
 */
const NAME_LIMIT = 50;

/** The Valkey operator's `resourcePrefix` on everything it creates. */
const VALKEY_RESOURCE_PREFIX = 'valkey-';

export interface KubernetesDatastoreOptions {
  /** Minted per request, never stored. */
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}

/** Raised when core asks for something this adapter cannot write. */
export class DatastoreRequestError extends Error {
  override readonly name = 'DatastoreRequestError';
}

export class KubernetesDatastoreAdapter implements DatastoreAdapter {
  readonly adapter: TargetAdapter = 'kubernetes';
  readonly engines: readonly DatastoreEngine[] = ['postgres', 'valkey'];

  constructor(private readonly options: KubernetesDatastoreOptions) {}

  async provision(
    target: DeployTarget,
    request: DatastoreRequest,
  ): Promise<DatastoreRef> {
    const connection = connectionOf(target);
    if (connection === null) {
      throw new DatastoreRequestError(
        `${targetLabel(target)} is not a Kubernetes Target`,
      );
    }
    if (!isLabel(request.name) || request.name.length > NAME_LIMIT) {
      throw new DatastoreRequestError(
        `"${request.name}" is not a usable datastore name: one DNS label of at most ${NAME_LIMIT} characters`,
      );
    }

    // Never an App's namespace: a Datastore outlives its Apps. A ref naming
    // another namespace stays there, since CloudNativePG cannot move a PVC.
    const namespace = datastoreNamespaceFor(connection);
    const object = this.object(namespace, request);
    // Server-side apply keeps this idempotent without a read-first check that
    // would race the operator.
    await this.api(connection).apply(
      object,
      ENGINE_KINDS[request.engine].plural,
    );
    return refOf(request.engine, namespace, request.name);
  }

  async observe(
    target: DeployTarget,
    ref: DatastoreRef,
  ): Promise<DatastoreState | null> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return null;

    const kind = ENGINE_KINDS[parsed.engine];
    const api = this.api(connection);
    const object = await api.get({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (object === null) return null;

    const status =
      parsed.engine === 'postgres'
        ? postgresStatus(object)
        : valkeyStatus(object);
    // Only once LIVE, so no App is configured against a half-built credential.
    const connectionRef =
      status.phase === 'LIVE' ? await this.connectionFor(api, parsed) : null;

    // An operator whose pods admission refuses still reports itself working, so
    // a refusal event outranks its status line. The phase stays as it is.
    const detail =
      status.phase === 'LIVE'
        ? status.detail
        : ((await this.refusal(api, parsed)) ?? status.detail);

    return {
      ref,
      phase: status.phase,
      connection: connectionRef,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  /**
   * Unfiltered: the operator's status says why it is not LIVE, and no field
   * holds a credential, since CloudNativePG only names its Secret.
   */
  async describe(
    target: DeployTarget,
    ref: DatastoreRef,
  ): Promise<KubernetesObject | null> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return null;

    const kind = ENGINE_KINDS[parsed.engine];
    return await this.api(connection).get({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: parsed.namespace,
      name: parsed.name,
    });
  }

  async destroy(target: DeployTarget, ref: DatastoreRef): Promise<void> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return;

    const kind = ENGINE_KINDS[parsed.engine];
    // `KubernetesApi.delete` tolerates a 404. The operator garbage-collects the
    // children it owns.
    await this.api(connection).delete({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: parsed.namespace,
      name: parsed.name,
    });
    // Nothing garbage-collects the policy. Outside the datastore namespace the
    // Role grants no networkpolicies, and a 403 would make the row undeletable.
    if (parsed.namespace !== datastoreNamespaceFor(connection)) return;
    await this.api(connection).delete({
      ...NETWORK_POLICY,
      namespace: parsed.namespace,
      name: policyName(parsed.name),
    });
  }

  /**
   * An ingress-only NetworkPolicy per Datastore, over the deny floor the
   * installation ships in the datastore namespace. `false` for a ref in any
   * other namespace: it has no floor, and the Role there cannot write policies.
   */
  async permit(
    target: DeployTarget,
    ref: DatastoreRef,
    namespaces: readonly string[],
  ): Promise<boolean> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return false;
    if (parsed.namespace !== datastoreNamespaceFor(connection)) return false;

    const ownPods = {
      matchLabels: { [ENGINE_KINDS[parsed.engine].podLabel]: parsed.name },
    };

    const api = this.api(connection);
    if (namespaces.length === 0) {
      // Deleted, because an empty `from` reads like a truncated policy.
      //
      // ponytail: this also drops the sibling grant, so a detached multi-pod
      // datastore would lose replication. Every Datastore is one instance.
      await api.delete({
        ...NETWORK_POLICY,
        namespace: parsed.namespace,
        name: policyName(parsed.name),
      });
      return true;
    }

    await api.apply(
      {
        apiVersion: NETWORK_POLICY.apiVersion,
        kind: NETWORK_POLICY.kind,
        metadata: {
          name: policyName(parsed.name),
          namespace: parsed.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'spindrift',
            'app.kubernetes.io/part-of': 'spindrift',
          },
        },
        spec: {
          podSelector: ownPods,
          // Ingress only: an egress rule would cut off CloudNativePG's instance
          // manager and the operators' DNS.
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                // Its own pods only, for replication and the cluster bus.
                // A bare `podSelector: {}` would open every App's Valkey to
                // the others.
                { podSelector: ownPods },
                ...namespaces.map((namespace) => ({
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': namespace },
                  },
                })),
              ],
            },
          ],
        },
      },
      NETWORK_POLICY.plural,
    );
    return true;
  }

  /**
   * The newest warning event refusing one of this datastore's objects, in the
   * cluster's words. Never throws: a failed read leaves the operator's status.
   */
  private async refusal(
    api: KubernetesApi,
    parsed: ParsedRef,
  ): Promise<string | undefined> {
    const events = await api
      .list({ apiVersion: 'v1', plural: 'events', namespace: parsed.namespace })
      .catch(() => null);
    if (events === null) return undefined;

    // Both operators name children after the resource, Valkey behind a prefix,
    // which keeps a neighbour's refusal out of this `detail`.
    const stems = [parsed.name, `${VALKEY_RESOURCE_PREFIX}${parsed.name}`];
    const refusals = (events as readonly RefusalEvent[]).filter((event) => {
      const involved = event.involvedObject?.name;
      return (
        event.type === 'Warning' &&
        event.reason !== undefined &&
        REJECTION_EVENTS.has(event.reason) &&
        involved !== undefined &&
        stems.some(
          (stem) => involved === stem || involved.startsWith(`${stem}-`),
        )
      );
    });
    if (refusals.length === 0) return undefined;

    // Newest wins. Both timestamp fields are RFC 3339 in UTC, so they order as
    // strings.
    let latest = refusals[0]!;
    for (const event of refusals) {
      if (timeOf(event) > timeOf(latest)) latest = event;
    }
    return latest.message ?? latest.reason;
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

  private object(
    namespace: string,
    request: DatastoreRequest,
  ): KubernetesObject {
    const kind = ENGINE_KINDS[request.engine];
    const metadata = {
      name: request.name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'spindrift',
        'app.kubernetes.io/name': request.name,
      },
    };
    const size = `${request.storageGiB}Gi`;

    // No `storageClass`: the cluster default decides, and naming one would put
    // an installation fact in the software.
    if (request.engine === 'postgres') {
      return {
        apiVersion: kind.apiVersion,
        kind: kind.kind,
        metadata,
        // ponytail: one instance, no scheduled backup. Raise `instances` and
        // add `backup.barmanObjectStore`, on the request, once one needs it.
        spec: {
          instances: 1,
          bootstrap: {
            initdb: {
              database: identifier(request.name),
              owner: identifier(request.name),
            },
          },
          storage: { size },
        },
      };
    }
    return {
      apiVersion: kind.apiVersion,
      kind: kind.kind,
      metadata,
      // A single primary, like `instances: 1`. `persistence` is set because the
      // operator's default is ephemeral.
      spec: {
        shards: 1,
        replicas: 0,
        persistence: { size },
        // The namespace enforces restricted Pod Security and the operator
        // sets no security context, so without this every pod is refused.
        //
        // `runAsUser` because the valkey image has no `USER` and would be
        // refused as root. 999/1000 is the valkey user that image creates.
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 999,
          runAsGroup: 1000,
          // The volume, group-owned so the same identity can write it.
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        // Container-only fields `restricted` demands. The operator builds two
        // containers; the exporter sidecar has its own field, below.
        containers: [
          {
            name: 'server',
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
        // Off: the pod block runs every container as the valkey uid, which the
        // exporter image has no reason to accept. `enabled` has no CRD default.
        exporter: { enabled: false },
      },
    };
  }

  private async connectionFor(
    api: KubernetesApi,
    parsed: ParsedRef,
  ): Promise<DatastoreConnection | null> {
    if (parsed.engine === 'postgres') {
      // CNPG's app Secret, asserted unread: LIVE is Ready, written after
      // bootstrap, and a read grant would cover every Secret.
      return `secret://${parsed.namespace}/${parsed.name}-app`;
    }
    // The operator's Service name is a convention, so it is confirmed: a
    // wrong guess reports no connection, never a dead address.
    const service = `${VALKEY_RESOURCE_PREFIX}${parsed.name}`;
    const found = await api.get({
      apiVersion: 'v1',
      plural: 'services',
      namespace: parsed.namespace,
      name: service,
    });
    // `redis://`: this fills `REDIS_URL`, and its clients reject `valkey://`.
    return found === null
      ? null
      : `redis://${service}.${parsed.namespace}.svc:6379`;
  }
}

interface RefusalEvent {
  type?: string;
  reason?: string;
  message?: string;
  /** Core v1 events, which both operators write. */
  lastTimestamp?: string;
  /** Set instead by writers through `events.k8s.io`. */
  eventTime?: string;
  involvedObject?: { name?: string };
}

/** Empty when neither stamp is set, which sorts below every stamped event. */
function timeOf(event: RefusalEvent): string {
  return event.lastTimestamp ?? event.eventTime ?? '';
}

interface EngineStatus {
  phase: DeployPhase;
  reason?: FailureReason;
  detail?: string;
}

/**
 * The `Ready` condition, because `status.phase` is prose the operator may
 * reword. No condition yet means still coming up.
 */
function postgresStatus(object: KubernetesObject): EngineStatus {
  const status = object.status as
    | {
        phase?: string;
        conditions?: { type?: string; status?: string; message?: string }[];
      }
    | undefined;
  const ready = (status?.conditions ?? []).find(
    (condition) => condition.type === 'Ready',
  );
  if (ready?.status === 'True') return { phase: 'LIVE' };
  if (ready?.status === 'False') {
    return {
      phase: 'WAITING',
      ...(ready.message === undefined ? {} : { detail: ready.message }),
    };
  }
  return { phase: 'WAITING' };
}

/**
 * `Degraded` is terminal: the operator cannot form the cluster, and nothing in
 * core times a datastore out.
 */
function valkeyStatus(object: KubernetesObject): EngineStatus {
  const status = object.status as
    | { state?: string; reason?: string; message?: string }
    | undefined;
  const detail = status?.message ?? status?.reason;
  if (status?.state === 'Ready') return { phase: 'LIVE' };
  if (status?.state === 'Degraded') {
    return {
      phase: 'FAILED',
      reason: 'UNHEALTHY',
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return {
    phase: 'WAITING',
    ...(detail === undefined ? {} : { detail }),
  };
}

interface ParsedRef {
  engine: DatastoreEngine;
  namespace: string;
  name: string;
}

/** `<engine>/<namespace>/<name>`, parsed only in this file. */
function refOf(
  engine: DatastoreEngine,
  namespace: string,
  name: string,
): DatastoreRef {
  return `${engine}/${namespace}/${name}`;
}

/**
 * Datastore names are unique per vessel, so these cannot collide. The prefix
 * sets them apart from the floor beside them.
 */
function policyName(name: string): string {
  return `spindrift-${name}`;
}

function parseRef(ref: DatastoreRef): ParsedRef | null {
  const [engine, namespace, name, ...rest] = ref.split('/');
  if (rest.length > 0 || namespace === undefined || name === undefined) {
    return null;
  }
  if (engine !== 'postgres' && engine !== 'valkey') return null;
  return { engine, namespace, name };
}

function connectionOf(
  target: DeployTarget,
): KubernetesAdapterConnection | null {
  return target.connection.adapter === 'kubernetes' ? target.connection : null;
}

/**
 * A DNS label may hold hyphens and a bare Postgres identifier may not.
 * Substituted so nobody has to quote the name in `psql`.
 */
function identifier(name: string): string {
  return name.replace(/-/g, '_');
}
