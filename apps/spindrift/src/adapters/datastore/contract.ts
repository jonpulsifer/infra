/**
 * The datastore adapter contract (§11).
 *
 * ```
 * provision(target, request) -> DatastoreRef
 * observe(target, ref)       -> current state
 * destroy(target, ref)
 * ```
 *
 * **Three verbs and no stream.** §6's deploy contract yields a timeline because
 * a deploy is something a developer is watching; a Datastore is provisioned once
 * and then outlives every App attached to it (§2: "deleting an App detaches its
 * Datastores and never cascades"). There is nothing for a timeline to be
 * attached to — no attempt, no build, no event log — so `provision` is one write
 * and core polls {@link DatastoreAdapter.observe} exactly the way it polls a
 * deploy's `observe`. Reconciliation still lives above this seam.
 *
 * **The vocabulary is borrowed, not invented.** {@link DatastoreState} reports
 * §6's `DeployPhase` and `FailureReason` rather than a parallel set, for §6's
 * own stated reason: "one shared vocabulary, not one per contract — the user
 * sees a single timeline and must not meet two vocabularies along it." A
 * database that will not come up and a service that will not come up read the
 * same way, which is the point.
 *
 * **Only `managed` Datastores reach here.** §11 gives two provenances "differing
 * only in who authors the URL": an `external` Datastore *is* its authored
 * connection reference, so there is nothing for an adapter to provision, observe
 * or destroy. Core never constructs a request for one.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type {
  DeployPhase,
  DeployTarget,
  FailureReason,
} from '../deploy/contract.ts';

/** §11: "for two wire protocols" — named for what this platform runs behind each. */
export type DatastoreEngine = 'postgres' | 'valkey';

/**
 * The adapter's own handle on what `provision` created.
 *
 * Opaque to core, exactly like `DeployRef`: core stores it on the Datastore row
 * and hands it back. A core that parsed it would be a core that knew a backend's
 * naming scheme, and the two backends here name things nothing like each other —
 * one is a namespaced Kubernetes object, the other a project-scoped cloud
 * resource path.
 */
export type DatastoreRef = string;

/** What core asks for. Every field is Spindrift's, none is a backend's. */
export interface DatastoreRequest {
  /**
   * The Datastore's name (§11: "Top-level and attached, not a field").
   *
   * Top-level is why there is no App here: a Datastore survives detachment, so
   * naming its backend object after whatever App happened to be attached when it
   * was created would leave a resource named for a relationship that has ended.
   */
  readonly name: string;
  readonly engine: DatastoreEngine;
  /**
   * Durable storage, in GiB. Every backend demands a size and none of them
   * agrees on a default worth inheriting, so core states one.
   */
  readonly storageGiB: number;
}

/**
 * Where the credential lives — **never the credential** (§11).
 *
 * §11: "an in-cluster secret reference in-cluster... a pinned store reference
 * everywhere else." Two shapes travel over this seam, distinguished by scheme,
 * and both are references rather than values:
 *
 * - `secret://<container>/<item>` — the backend generated a credential and put
 *   it somewhere the Target can already read. A cluster's Secret, a project's
 *   Secret Manager entry.
 * - `valkey://<host>:<port>` — there is no credential to reference, because the
 *   engine as this platform runs it authenticates nobody. The address is not a
 *   secret and pretending it is would mean writing a Secret that holds a
 *   hostname.
 *
 * A string rather than a union because that is what `datastores.connection_ref`
 * stores and what an `external` Datastore's human author writes into the same
 * column. One column, one shape, and the scheme says which kind it is.
 */
export type DatastoreConnection = string;

/** What `observe` reports: the platform's current answer, not core's memory. */
export interface DatastoreState {
  readonly ref: DatastoreRef;
  readonly phase: DeployPhase;
  readonly reason?: FailureReason;
  readonly detail?: string;
  /**
   * The connection reference, or `null` while there is not one yet.
   *
   * `null` is the ordinary state of a datastore mid-provision — the operator has
   * not generated the credential — and core stores it only once it is non-null.
   * A caller that treats `null` as failure would fail every healthy provision.
   */
  readonly connection: DatastoreConnection | null;
}

/**
 * One backend's datastore lifecycle.
 *
 * Keyed by `TargetAdapter` like the deploy registry, and for the same §13
 * reason: a Target has exactly one adapter type, and §11's "delivery follows the
 * Datastore's placement" means a Datastore lives on a Target. A second key would
 * only be able to disagree with the first.
 */
export interface DatastoreAdapter {
  /** The Target adapter type this drives, in the vocabulary Targets are seeded with. */
  readonly adapter: TargetAdapter;

  /**
   * Engines this backend can provision.
   *
   * Declared rather than assumed, because it is not the same question as §3's
   * `postgres`/`valkey` capability. That one asks whether a *particular cluster*
   * serves the operator; this one asks whether the code driving it knows how to
   * write the object at all. Placement needs both, and an engine outside this
   * list reaching `provision` is a core bug rather than a Target's shortcoming.
   */
  readonly engines: readonly DatastoreEngine[];

  /**
   * Create the datastore and return the handle to it.
   *
   * Idempotent: provisioning a datastore that already exists returns the same
   * ref rather than a second resource. Errors are **thrown**, not reported as a
   * failed state — there is no attempt log for a reason and a blame to be
   * written onto, and core catches this the same way it catches `inspect`.
   */
  provision(
    target: DeployTarget,
    request: DatastoreRequest,
  ): Promise<DatastoreRef>;

  /** The current state, or `null` when nothing is there. */
  observe(
    target: DeployTarget,
    ref: DatastoreRef,
  ): Promise<DatastoreState | null>;

  /** Idempotent: destroying what is already gone succeeds (§6). */
  destroy(target: DeployTarget, ref: DatastoreRef): Promise<void>;
}
