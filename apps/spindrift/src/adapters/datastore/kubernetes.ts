/**
 * Datastores on a Kubernetes Target (§11).
 *
 * Two engines, two operators, one adapter — because §13 gives a Target exactly
 * one adapter type and both operators are reached through the same API server
 * with the same projected token. Splitting them would mean two registry keys for
 * one Target, and the registry has no way to choose between them.
 *
 * **Spindrift writes a custom resource and stops.** §19's rule for the delivery
 * path holds here for the same reason: "no CRD, no informer, no controller-
 * runtime." The operator on the far side is the controller. What this adapter
 * does is a server-side apply and a poll, which is what {@link KubernetesApi}
 * already is.
 *
 * **{@link ENGINE_KINDS} is why this file is also read by the deploy adapter.**
 * §3's `postgres`/`valkey` capability is discovered by asking the cluster whether
 * it serves these kinds, and provisioning writes those same kinds. Two tables
 * would be two chances to name a different operator than the fleet runs — which
 * is exactly what had happened: discovery probed an operator no cluster here
 * installs, so the cache engine discovered `false` forever and every placement
 * asking for it was a non-candidate with a reason that pointed nowhere.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { isLabel } from '../../domain/naming.ts';
import {
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
import type {
  DatastoreAdapter,
  DatastoreConnection,
  DatastoreEngine,
  DatastoreRef,
  DatastoreRequest,
  DatastoreState,
} from './contract.ts';

/**
 * The operator each engine is served by, on the clusters this fleet runs.
 *
 * `postgres` is CloudNativePG, `valkey` is the Valkey project's own operator.
 * Each engine is named for the software this platform runs rather than for a
 * protocol family, so an engine value can never name a product no Target in the
 * fleet is able to provision.
 */
export const ENGINE_KINDS = {
  postgres: {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    plural: 'clusters',
  },
  valkey: {
    apiVersion: 'valkey.io/v1alpha1',
    kind: 'ValkeyCluster',
    plural: 'valkeyclusters',
  },
} as const satisfies Record<
  DatastoreEngine,
  { apiVersion: string; kind: string; plural: string }
>;

/**
 * How long a name may be before its backend starts colliding.
 *
 * Both operators derive child object names by suffixing this one — CNPG's
 * `-rw`/`-app` services and secrets, the Valkey operator's per-node objects —
 * and a Kubernetes object name caps at 253 with far tighter limits on the
 * StatefulSet pods underneath. 50 leaves room for every suffix either operator
 * appends.
 *
 * **Refused rather than truncated.** `workload-name.ts` shortens a name core
 * derived from two others, which is a name no human chose; a Datastore's name
 * *is* what a human typed (§11: top-level), so silently renaming it would leave
 * an operator looking in the cluster for something that is not there.
 */
const NAME_LIMIT = 50;

export interface KubernetesDatastoreOptions {
  /** Minted per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
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

    const object = this.object(connection.namespace, request);
    // Server-side apply, so re-provisioning an existing datastore converges on
    // the same object rather than creating a second one — the idempotence the
    // contract promises, kept by the API server rather than by a read-first
    // check that would race the operator.
    await this.api(connection).apply(
      object,
      ENGINE_KINDS[request.engine].plural,
    );
    return refOf(request.engine, connection.namespace, request.name);
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
    // Reported only once the datastore can actually serve. Mid-provision both
    // operators have written *some* of the objects a reference would name, and
    // handing core a reference to a half-built credential would let an App be
    // configured against one.
    const connectionRef =
      status.phase === 'LIVE' ? await this.connectionFor(api, parsed) : null;

    return {
      ref,
      phase: status.phase,
      connection: connectionRef,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
    };
  }

  async destroy(target: DeployTarget, ref: DatastoreRef): Promise<void> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return;

    const kind = ENGINE_KINDS[parsed.engine];
    // `KubernetesApi.delete` swallows the `404`, so destroying what is already
    // gone succeeds. The operator garbage-collects the children it owns.
    await this.api(connection).delete({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: parsed.namespace,
      name: parsed.name,
    });
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

    // No `storageClass` in either spec: the cluster's default is the operator's
    // own answer to where a volume lives, and naming one here would be an
    // installation fact (§20) in the software rather than in the manifest.
    if (request.engine === 'postgres') {
      return {
        apiVersion: kind.apiVersion,
        kind: kind.kind,
        metadata,
        // ponytail: one instance, no scheduled backup — a datastore that
        // survives a node reboot, not one that survives losing the node. Raise
        // `instances` and add `backup.barmanObjectStore` once a Datastore is
        // worth an object store, and put both on the request rather than here.
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
      // One shard, no replicas: a single primary, which is what `instances: 1`
      // is on the other engine. `persistence` is set rather than omitted so a
      // restarted node comes back with its data — the operator's default is
      // ephemeral, and a Datastore that empties on a reschedule is a cache
      // wearing a Datastore's name.
      spec: {
        shards: 1,
        replicas: 0,
        persistence: { size },
        // Restricted Pod Security, stated here because nothing else states it.
        // `spindrift-apps` enforces the `restricted` standard, and the Valkey
        // operator sets no security context of its own — it copies
        // `podSecurityContext` through and leaves the container's empty — so a
        // ValkeyCluster written without this creates its StatefulSet, has every
        // pod refused by admission, and sits in `WAITING` with the only useful
        // sentence on an object the adapter never reads. CloudNativePG needs no
        // equivalent: it sets a compliant context itself.
        //
        // `runAsUser` is not redundant beside `runAsNonRoot`. The valkey image
        // has no `USER` and drops from root in its entrypoint, so the kubelet
        // would refuse it as root-by-image with nothing but the flag. 999/1000
        // is the `valkey` user that image creates, so the data directory it
        // wants and the identity it runs as agree.
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 999,
          runAsGroup: 1000,
          // The volume, group-owned so the same identity can write it.
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        // The two fields `restricted` demands that exist only on a container.
        // A strategic merge patch onto the operator's own container, which it
        // names `server` — everything else about it is left to the operator.
        containers: [
          {
            name: 'server',
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
      },
    };
  }

  /**
   * §11's connection reference, in whichever shape this engine has one.
   *
   * The two differ because the backends do, not because the contract is loose:
   * CloudNativePG generates a credential and puts it in a Secret, and the Valkey
   * operator authenticates nobody unless an ACL user is declared. A `secret://`
   * reference to a Secret holding only a hostname would be a lie about what is
   * protected.
   */
  private async connectionFor(
    api: KubernetesApi,
    parsed: ParsedRef,
  ): Promise<DatastoreConnection | null> {
    if (parsed.engine === 'postgres') {
      // CloudNativePG names the application credential `<cluster>-app` and puts
      // `uri`, `host`, `port`, `dbname`, `username` and `password` in it.
      //
      // Asserted rather than read back, and the caller is why: this is only
      // reached at `phase === 'LIVE'`, which for this engine *is* CNPG's
      // `Ready=True` condition — written downstream of the bootstrap that
      // creates the Secret. A `get` here could only ever confirm what the
      // condition already stated, and it would cost the one grant this whole
      // design exists to avoid: RBAC matches `resourceNames` literally, so
      // reading `<cluster>-app` means reading every Secret in the namespace.
      return `secret://${parsed.namespace}/${parsed.name}-app`;
    }
    // The Valkey operator fronts a cluster with a Service of the same name.
    // Confirmed against the cluster rather than asserted, because this is the
    // one fact here that is a naming convention rather than a documented API
    // field — and `services: get` is a grant that names an ordinary object.
    const service = await api.get({
      apiVersion: 'v1',
      plural: 'services',
      namespace: parsed.namespace,
      name: parsed.name,
    });
    // `redis://`, not `valkey://`. This fills `REDIS_URL` (the variable is fixed
    // by engine), and every client that reads it — node-redis, ioredis,
    // redis-py — parses `redis://` and rejects a scheme it does not know. A
    // scheme naming the server would be honest and unusable.
    return service === null
      ? null
      : `redis://${parsed.name}.${parsed.namespace}.svc:6379`;
  }
}

/** What a status read concluded, in §6's shared vocabulary. */
interface EngineStatus {
  phase: DeployPhase;
  reason?: FailureReason;
  detail?: string;
}

/**
 * CloudNativePG's verdict.
 *
 * The `Ready` condition rather than `status.phase`, because the phase is a
 * human sentence ("Cluster in healthy state") that the operator is free to
 * reword; the condition is the API. A cluster that has not written one yet is
 * still coming up, which is `WAITING` and not a failure.
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
 * The Valkey operator's verdict, off `status.state`.
 *
 * `Degraded` is the one terminal answer here: the operator uses it for a cluster
 * it cannot finish forming, and unlike a deploy there is no timeout above this
 * seam to eventually call it. `UNHEALTHY` is §6's reason for readiness that
 * never passed, which is exactly what this is.
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

/** `<engine>/<namespace>/<name>` — opaque to core, parsed only here. */
function refOf(
  engine: DatastoreEngine,
  namespace: string,
  name: string,
): DatastoreRef {
  return `${engine}/${namespace}/${name}`;
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
 * The name as a bare SQL identifier.
 *
 * A Datastore name is a DNS label, so it may hold hyphens; an unquoted Postgres
 * identifier may not. Substituting rather than quoting keeps the database name
 * something a developer can type into `psql` without remembering it was created
 * with quotes.
 */
function identifier(name: string): string {
  return name.replace(/-/g, '_');
}
