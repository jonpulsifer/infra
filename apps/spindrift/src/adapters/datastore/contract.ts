/**
 * The datastore adapter contract (§11).
 *
 * ```
 * provision(target, request) -> DatastoreRef
 * observe(target, ref)       -> current state
 * destroy(target, ref)
 * ```
 *
 * **A lifecycle and no stream.** §6's deploy contract yields a timeline because
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
 * - `redis://<host>:<port>` — there is no credential to reference, because the
 *   engine as this platform runs it authenticates nobody. The address is not a
 *   secret and pretending it is would mean writing a Secret that holds a
 *   hostname. The scheme names the wire protocol rather than the server: this
 *   string is handed to an App as `REDIS_URL`, and node-redis, ioredis and
 *   redis-py all reject a scheme they do not recognise, so `valkey://` would be
 *   a reference no client could open.
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

  /**
   * Admit exactly these network locations to this datastore, and nobody else.
   *
   * The half of isolation core holds. A Datastore lives in no App's namespace
   * — that is the whole reason it is top-level — so nothing in the backend can
   * see which App is attached to it; that is a row core owns, and this is how
   * core states it. What a "network location" is belongs to the backend: on a
   * cluster it is a namespace name, and the caller derives it the same way the
   * delivery path does.
   *
   * **Replace, never add.** The list is the whole permitted set, so an empty
   * one means "admit nobody" — a detached Datastore, which is the ordinary
   * state of one whose App was deleted. A verb pair would leave the revoke to
   * a caller that may never run.
   *
   * **Idempotent, and called on a schedule.** The datastore loop calls this
   * when what core knows disagrees with what it last said, calls it again
   * after a failure, and calls it again on a slow cadence to re-assert what it
   * already said — so writing the same permission twice must be the same as
   * writing it once.
   *
   * **`false` means nothing was established**, which is not the same as a
   * failure: a backend can hold a ref it has no boundary to write around — one
   * placed before this Target had a datastore namespace, say — and the honest
   * answer is that the permitted set is still whatever it was. The caller
   * records what it was told only when this returns `true`, because the column
   * it records into claims a fact about the far side.
   *
   * Optional, like {@link DatastoreAdapter.describe}, and for a sharper
   * reason: a backend whose reachability is not an object — a cloud database
   * behind a project's own network rules — has nothing here to write, and a
   * stub that threw would turn "this backend isolates differently" into a
   * failed pass every fifteen seconds.
   */
  permit?(
    target: DeployTarget,
    ref: DatastoreRef,
    namespaces: readonly string[],
  ): Promise<boolean>;

  /**
   * The backend's own object, verbatim, for a reader — or `null` where there is
   * nothing to read.
   *
   * **The far side's document, never core's memory of it.** `observe` already
   * answers "is it up" and deliberately reduces a whole resource to a phase and
   * a sentence; this is the resource. The two are separate because reducing is
   * what the loop wants and the whole document is what a person diagnosing one
   * wants, and a screen that re-derived the second from the first would be
   * showing a manifest Spindrift composed rather than the one the operator is
   * reconciling. `storageGiB` is not even stored (`createDatastore`: "no size
   * on the row"), so core could not compose an honest one if it tried.
   *
   * Optional, and absent is a real answer: the cloud backend provisions through
   * an API that hands back no document of this kind, and `null` from a backend
   * that has one means the object is gone. A caller renders both as "nothing to
   * show" and neither as an error.
   *
   * `unknown` because core never predicates on it — it is serialized and shown,
   * exactly like `deploys.debug`.
   */
  describe?(target: DeployTarget, ref: DatastoreRef): Promise<unknown>;
}
