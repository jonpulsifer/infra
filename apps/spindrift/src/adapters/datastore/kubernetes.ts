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
 * The operator each engine is served by, on the clusters this fleet runs.
 *
 * `postgres` is CloudNativePG, `valkey` is the Valkey project's own operator.
 * Each engine is named for the software this platform runs rather than for a
 * protocol family, so an engine value can never name a product no Target in the
 * fleet is able to provision.
 *
 * `podLabel` is how a policy names one datastore's pods, and it is an
 * *operator convention* rather than an API this file can hold either operator
 * to — the same class of fact {@link VALKEY_RESOURCE_PREFIX} carries, measured
 * the same way, on a live cluster. Both stamp it with the custom resource's own
 * name as the value. An operator that renames one fails closed: the policy
 * selects no pods, the namespace's default-deny still isolates them, and the
 * attached App loses its own datastore loudly rather than the namespace being
 * silently opened.
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

/**
 * The API path for a NetworkPolicy, which is not a kind this adapter provisions.
 *
 * Kept out of {@link ENGINE_KINDS} deliberately: that table is one row per
 * engine and this is one object for both.
 */
const NETWORK_POLICY = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  plural: 'networkpolicies',
} as const;

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

/**
 * What the Valkey operator prefixes everything it creates with.
 *
 * `resourcePrefix` in the operator's own `internal/controller/utils.go`. Named
 * here because two places need it and neither is allowed to guess: the address
 * a Datastore hands out, and the Service that address is confirmed against.
 */
const VALKEY_RESOURCE_PREFIX = 'valkey-';

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

    // Never an App's namespace (§11). A Datastore outlives every App attached
    // to it, which is the whole reason it is a top-level noun, so it cannot
    // live in a namespace named for one of them. A Datastore provisioned
    // before this carries its old namespace in its own ref and is still
    // observed and destroyed there — nothing moves, because there is no move
    // verb and CloudNativePG will not relocate a PVC.
    const namespace = datastoreNamespaceFor(connection);
    const object = this.object(namespace, request);
    // Server-side apply, so re-provisioning an existing datastore converges on
    // the same object rather than creating a second one — the idempotence the
    // contract promises, kept by the API server rather than by a read-first
    // check that would race the operator.
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
    // Reported only once the datastore can actually serve. Mid-provision both
    // operators have written *some* of the objects a reference would name, and
    // handing core a reference to a half-built credential would let an App be
    // configured against one.
    const connectionRef =
      status.phase === 'LIVE' ? await this.connectionFor(api, parsed) : null;

    // The read on red, for a datastore (§6). Both operators report their own
    // reconcile, and an operator whose StatefulSet is being refused by
    // admission does not consider that its own failure — it says it is still
    // working, forever, while the only useful sentence in the cluster sits on
    // an object neither status read looks at. So a warning refusing one of this
    // datastore's own objects outranks the operator's status line.
    //
    // Read only when the phase is not `LIVE`, so a healthy installation pays
    // nothing; the loop already selects unsettled rows only. And it changes
    // nothing but the sentence: a pod refused admission is not terminal — fix
    // the manifest and the next apply admits it — so `WAITING` stays `WAITING`
    // and no new verdict is invented here.
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
   * The CR as the API server holds it — spec, status and all.
   *
   * Unfiltered on purpose. The operator's `status` is where the answer to
   * "why is this WAITING" actually lives, and the spec beside it is what
   * `provision` wrote plus every default the operator filled in. Neither
   * carries a credential: CloudNativePG puts the password in a Secret and
   * names it here, which is the reference §11 already says core may hold.
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
    // `KubernetesApi.delete` swallows the `404`, so destroying what is already
    // gone succeeds. The operator garbage-collects the children it owns.
    await this.api(connection).delete({
      apiVersion: kind.apiVersion,
      plural: kind.plural,
      namespace: parsed.namespace,
      name: parsed.name,
    });
    // The policy is nobody's child — it selects the datastore's pods rather
    // than being owned by the custom resource — so nothing garbage-collects it.
    // Deleted here rather than given an `ownerReference`, which would need the
    // CR's UID read back before every write for a policy that denies rather
    // than admits when it is left behind.
    await this.api(connection).delete({
      ...NETWORK_POLICY,
      namespace: parsed.namespace,
      name: policyName(parsed.name),
    });
  }

  /**
   * Admit exactly these namespaces to this datastore's pods.
   *
   * The exception on top of the deny floor the installation ships in the
   * datastore namespace (`clusters/base/platform/spindrift-target/`). One
   * object per Datastore, named after it, selecting its own pods by the
   * operator's cluster label — so a policy widened for one Datastore cannot
   * widen its neighbour, and a Datastore with no App attached has no object at
   * all rather than one admitting an empty list.
   *
   * **A vanilla `NetworkPolicy`, not a `CiliumNetworkPolicy`.** The chart
   * reaches for the Cilium kind for one reason — a gateway's data plane is an
   * identity no selector can name — and no gateway fronts a datastore. Every
   * selector here is a namespace name and a pod label, which the portable kind
   * expresses, and every Target's CNI enforces.
   *
   * **Ingress only, and no `ports`.** Egress here would be the policy taking
   * away CloudNativePG's instance manager and both operators' DNS, and the
   * pods listen on their engine's port and nothing else — pinning ports would
   * add a second per-engine table that must stay in step with the first, to
   * refuse traffic no pod would answer anyway.
   *
   * A Datastore whose ref names a namespace this Target does not provision
   * into is one placed before `spindrift-datastores` existed. Nothing is
   * written for it: there is no floor in `spindrift-apps` for an exception to
   * sit on, and the identity's Role there is read-and-remove only by design.
   */
  async permit(
    target: DeployTarget,
    ref: DatastoreRef,
    namespaces: readonly string[],
  ): Promise<void> {
    const connection = connectionOf(target);
    const parsed = parseRef(ref);
    if (connection === null || parsed === null) return;
    if (parsed.namespace !== datastoreNamespaceFor(connection)) return;

    const api = this.api(connection);
    if (namespaces.length === 0) {
      // Detached: the object goes away rather than being applied with an empty
      // `from`, which reads identically to a policy somebody truncated.
      await api.delete({
        ...NETWORK_POLICY,
        namespace: parsed.namespace,
        name: policyName(parsed.name),
      });
      return;
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
          podSelector: {
            matchLabels: {
              [ENGINE_KINDS[parsed.engine].podLabel]: parsed.name,
            },
          },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: namespaces.map((namespace) => ({
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': namespace },
                },
              })),
            },
          ],
        },
      },
      NETWORK_POLICY.plural,
    );
  }

  /**
   * The most recent warning refusing one of this datastore's own objects.
   *
   * **Events rather than the child workload's status**, which was the other
   * candidate. Events are one mechanism for both engines and for the failure
   * modes neither operator models — a quota, a policy engine, a scheduler with
   * nowhere to put the pod — and they are what a human runs `kubectl describe`
   * for. Reading each operator's child workload instead would need a table of
   * child kinds and names per operator, which is wrong the first time an
   * operator renames one. `events: list` in this namespace is already granted
   * for the delivery path's own read on red.
   *
   * The words are the cluster's. Nothing here maps a reason onto a sentence
   * Spindrift wrote: {@link REJECTION_EVENTS} decides *which* event is a
   * refusal, and the event's own `message` is what an operator reads.
   *
   * **Never throws.** This runs on a datastore that is already not `LIVE`, and
   * a diagnosis that could not be loaded is not a reason to lose the operator's
   * status line as well.
   */
  private async refusal(
    api: KubernetesApi,
    parsed: ParsedRef,
  ): Promise<string | undefined> {
    const events = await api
      .list({ apiVersion: 'v1', plural: 'events', namespace: parsed.namespace })
      .catch(() => null);
    if (events === null) return undefined;

    // Both operators name what they create after the custom resource — CNPG
    // suffixes the cluster's own name, the Valkey operator prefixes it first
    // (`VALKEY_RESOURCE_PREFIX`). Matching on that is what keeps a neighbour's
    // refusal in a shared namespace out of this datastore's `detail`; it is a
    // narrower claim than knowing each operator's child *kinds*, because it
    // survives an operator adding one.
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

    // Most recent wins. A refusal that repeats — the fourteen `FailedCreate`s a
    // StatefulSet reported while its pods were inadmissible — is the same
    // sentence every time, and where two differ the newest is the one still
    // true. Both timestamp fields are RFC 3339 in UTC, so they order as strings.
    let latest = refusals[0]!;
    for (const event of refusals) {
      if (timeOf(event) > timeOf(latest)) latest = event;
    }
    return latest.message ?? latest.reason;
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
        // The two fields `restricted` demands that exist only on a container,
        // so the pod block above cannot supply them. Every container in the pod
        // needs them, and this operator builds **two**: `server`, patched here,
        // and the metrics exporter sidecar it adds unasked — which has its own
        // spec field rather than living in `containers`, and so is set below.
        // Admission fails the whole pod on the one that is missing them, which
        // is why hardening only the obvious container hardens nothing.
        containers: [
          {
            name: 'server',
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
        // The metrics sidecar, off — stated rather than left to the absence of
        // a field, because that absence is what turned it off by accident.
        // `enabled` has no default in the CRD, so naming `exporter` at all to
        // carry a security context was already switching it off; a reader
        // deserves to see the decision rather than infer it from a missing key.
        //
        // Off rather than hardened because hardening it is not one line: the
        // pod block above runs every container as uid 999, which is the valkey
        // user, and the exporter is a different image with no reason to accept
        // it — the operator's own hardened sample gives the two distinct uids.
        // Nothing scrapes a datastore sidecar in this fleet yet, so switching
        // it on is a change worth making when something wants the metrics, with
        // the uid question answered against a running pod rather than guessed.
        exporter: { enabled: false },
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
    // The Valkey operator fronts a cluster with a Service named for it, under
    // the prefix it gives everything it creates (`resourcePrefix = "valkey-"`
    // in the operator's `internal/controller/utils.go`, and its own e2e suite
    // reads back `service valkey-<cluster>`).
    //
    // Confirmed against the cluster rather than asserted, because this is the
    // one fact here that is a naming convention rather than a documented API
    // field — and `services: get` is a grant that names an ordinary object.
    // The confirmation is what makes a wrong guess here a Datastore that never
    // reports a connection rather than one that hands out an address nothing
    // answers on.
    const service = `${VALKEY_RESOURCE_PREFIX}${parsed.name}`;
    const found = await api.get({
      apiVersion: 'v1',
      plural: 'services',
      namespace: parsed.namespace,
      name: service,
    });
    // `redis://`, not `valkey://`. This fills `REDIS_URL` (the variable is fixed
    // by engine), and every client that reads it — node-redis, ioredis,
    // redis-py — parses `redis://` and rejects a scheme it does not know. A
    // scheme naming the server would be honest and unusable.
    return found === null
      ? null
      : `redis://${service}.${parsed.namespace}.svc:6379`;
  }
}

/** The fields a refusal is recognised and ordered by, off a core v1 `Event`. */
interface RefusalEvent {
  type?: string;
  reason?: string;
  message?: string;
  /** Set by controllers writing core v1 events, which is both operators. */
  lastTimestamp?: string;
  /** Set instead by anything writing through `events.k8s.io`. */
  eventTime?: string;
  involvedObject?: { name?: string };
}

/**
 * When an event last happened.
 *
 * Empty for an event carrying neither stamp, which sorts below every event that
 * carries one — the honest order, since an event with no time cannot be shown
 * to be the newest.
 */
function timeOf(event: RefusalEvent): string {
  return event.lastTimestamp ?? event.eventTime ?? '';
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

/**
 * The policy object's name, which is the Datastore's with a prefix.
 *
 * Unambiguous without the engine in it: `datastores_vessel_name_unique` makes
 * two Datastores of one name in one vessel impossible, so no two datastore
 * policies in a namespace can collide. Prefixed so that an operator reading
 * `kubectl get netpol` can tell the per-Datastore exceptions from the floor
 * Flux ships beside them.
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
