/**
 * The deploy adapter contract (§6).
 *
 * ```
 * apply(target, DesiredState) -> stream<DeployEvent> -> terminal verdict
 * observe(target, ref)        -> current state
 * destroy(target, ref)
 * ```
 *
 * The verbs are one shot and imperative: **reconciliation lives in core, above
 * this seam.** Every backend self-heals below it, so an adapter never holds a
 * workload up — it puts it there and reports honestly. That is also why
 * `observe` is poll shaped rather than a watch: core decides when to look.
 *
 * Status is the platform's verdict and Spindrift's explanation. Phase
 * transitions come from the controller or platform API, never from Spindrift
 * reimplementing readiness — but on red the adapter reads pods and events (or
 * the cloud log) **once** and fills in the detail. A read on red, not a
 * continuous watch (§6).
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { TargetInspection } from '../../domain/capabilities.ts';
import type { ArtifactType, DesiredState } from '../../domain/desired-state.ts';
import type {
  AdapterConnection,
  KubernetesDeliveryFlavour,
} from '../../domain/target.ts';

/**
 * What the verbs need to name a Target. The Target model (§13) carries
 * capabilities and connection material as well; this is the narrow view the
 * contract takes, because a Target has exactly one adapter type and the adapter
 * is constructed against the connection.
 */
export interface DeployTarget {
  /**
   * The boundary this Target is a surface on, by name.
   *
   * Half of the identity, and the half an adapter never dispatches on. It is
   * here so an adapter that has to name the Target it was handed can say
   * `<vessel>/<adapter>` — see `targetLabel` — rather than repeat a string core
   * had constructed for it.
   */
  readonly vessel: string;
  /** Exactly one adapter type per Target (§13), and the other half of its identity. */
  readonly adapter: TargetAdapter;
  /**
   * How this Target is reached, in its adapter's own terms (§13).
   *
   * One adapter instance serves every Target of its type, so the connection
   * travels with the call rather than with the construction. The alternative —
   * an adapter per Target held in the registry — would make the registry a
   * factory over live connection state, and would still have to be rebuilt
   * whenever an operator reconnected one.
   *
   * **One flat object, composed from two rows.** Core stores the surface's
   * facts on the Target and the boundary's on its Vessel, and `deployTargetOf`
   * assembles them before the call. An adapter is handed what it always was,
   * and is deliberately not told which row each field came from — where the
   * facts are *kept* is core's normalization, not this seam's business.
   *
   * **Never a credential** (§13: "one auth mode — native OIDC federation,
   * nothing stored"). What authorizes a call is minted per request by whatever
   * federates, and is injected when the adapter is constructed.
   */
  readonly connection: AdapterConnection;
}

/**
 * The adapter's own handle on what `apply` placed. Opaque to core, which stores
 * it and hands it back to `observe` and `destroy` — the seam would leak a
 * backend's naming scheme if core ever parsed it.
 */
export type DeployRef = string;

/**
 * §6's phase progression:
 *
 * ```
 * PENDING -> APPLYING -> WAITING -> LIVE | FAILED
 * ```
 */
export const DEPLOY_PHASES = [
  'PENDING',
  'APPLYING',
  'WAITING',
  'LIVE',
  'FAILED',
] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

/** The two phases a stream may end on. */
export type TerminalPhase = Extract<DeployPhase, 'LIVE' | 'FAILED'>;

/**
 * The closed reason set a `FAILED` carries (§6).
 *
 * **One shared vocabulary**, not one per contract: the user sees a single
 * timeline and must not meet two vocabularies along it. `BUILD_FAILED` is on
 * this list for exactly that reason — a reason that cannot apply to a phase
 * simply never occurs there (§6, folding in §10's eighth reason).
 *
 * The union is closed on purpose. Free text lives in `detail`, and the raw
 * platform payload in `debug`; neither is ever an identity a test or the UI can
 * key on.
 */
export const FAILURE_REASONS = [
  'BUILD_FAILED',
  'ARTIFACT_UNAVAILABLE',
  'REJECTED',
  'STARTUP_FAILED',
  'UNHEALTHY',
  'TIMEOUT',
  'TARGET_UNREACHABLE',
  'INTERNAL',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Who a failure indicts. §6: **blame is the most useful thing the UI knows** —
 * justified hardest by `ARTIFACT_UNAVAILABLE`, where the build is green and
 * every instinct wrongly says "look at my app".
 */
export const BLAMES = ['developer', 'platform'] as const;

export type Blame = (typeof BLAMES)[number];

/**
 * §6's blame column, verbatim. `TIMEOUT` is a dash there and `null` here: a
 * deploy that never reached a terminal state within budget indicts nobody, and
 * saying so is more useful than guessing.
 *
 * | Reason | Blame | Covers |
 * | --- | --- | --- |
 * | `BUILD_FAILED` | developer | compile error, failed build step |
 * | `ARTIFACT_UNAVAILABLE` | platform | image pull failure, registry auth, missing object |
 * | `REJECTED` | developer | admission webhook, invalid spec, quota, org policy |
 * | `STARTUP_FAILED` | developer | crash loop, exits non-zero, revision will not start |
 * | `UNHEALTHY` | developer | readiness never passed |
 * | `TIMEOUT` | — | no terminal state within budget |
 * | `TARGET_UNREACHABLE` | platform | credentials expired, cluster down, API unreachable |
 * | `INTERNAL` | platform | adapter bug |
 *
 * An adapter reports a reason and never a blame: blame is derived here so that
 * two adapters cannot disagree about who a failure indicts.
 */
export const BLAME = {
  BUILD_FAILED: 'developer',
  ARTIFACT_UNAVAILABLE: 'platform',
  REJECTED: 'developer',
  STARTUP_FAILED: 'developer',
  UNHEALTHY: 'developer',
  TIMEOUT: null,
  TARGET_UNREACHABLE: 'platform',
  INTERNAL: 'platform',
} as const satisfies Record<FailureReason, Blame | null>;

/** The blame §6's table assigns a reason, or `null` where the table is a dash. */
export function blameFor(reason: FailureReason): Blame | null {
  return BLAME[reason];
}

/** The union is closed; a value outside it is a compile error, not a branch. */
function unreachable(value: never): never {
  throw new Error(`unhandled failure reason: ${String(value)}`);
}

/**
 * The Covers column of §6's table, verbatim.
 *
 * This is the one switch over the reason union, and it is exhaustive: the
 * `unreachable` call fails to type-check the moment a ninth reason is added
 * without a case here, which is what keeps the vocabulary closed in practice
 * rather than only in the type.
 */
export function reasonCovers(reason: FailureReason): string {
  switch (reason) {
    case 'BUILD_FAILED':
      return 'compile error, failed build step';
    case 'ARTIFACT_UNAVAILABLE':
      return 'image pull failure, registry auth, missing object';
    case 'REJECTED':
      return 'admission webhook, invalid spec, quota, org policy';
    case 'STARTUP_FAILED':
      return 'crash loop, exits non-zero, revision will not start';
    case 'UNHEALTHY':
      return 'readiness never passed';
    case 'TIMEOUT':
      return 'no terminal state within budget';
    case 'TARGET_UNREACHABLE':
      return 'credentials expired, cluster down, API unreachable';
    case 'INTERNAL':
      return 'adapter bug';
    default:
      return unreachable(reason);
  }
}

/**
 * What travels on the attempt-scoped event log while `apply` runs (§6): log
 * lines and status events `{phase, resource?, reason?, blame?}`. The UI
 * subscribes once and Build writes to the same stream.
 *
 * **A running app's stdout is not on this log** — it is unbounded, and an
 * unbounded log would mean the attempt never ends (§6). Runtime output is the
 * second pipe (§17).
 */
export type DeployEvent =
  | {
      type: 'log';
      at: Date;
      line: string;
      /** Which resource produced the line, where the backend says. */
      resource?: string;
    }
  | {
      type: 'status';
      at: Date;
      phase: DeployPhase;
      /** What buys the per-resource feel at three fidelities (§6). */
      resource?: string;
      reason?: FailureReason;
      /**
       * Derived from {@link BLAME}. An adapter may leave it unset; core stamps
       * it so the log and the verdict cannot disagree.
       */
      blame?: Blame | null;
      detail?: string;
    };

/**
 * What a stream ends on. `apply` does not throw: an adapter that cannot place
 * the workload says so as a `FAILED` verdict, because a thrown error has no
 * reason and therefore no blame.
 */
export type DeployVerdict =
  | {
      phase: 'LIVE';
      ref: DeployRef;
      /**
       * The canonical address, where the platform gives one of its own — on
       * those Targets the platform's name *is* the canonical, so it comes back
       * across this seam rather than being handed in (§9).
       */
      url?: string;
      /**
       * Where a record for a name this platform serves should point (§9).
       *
       * Absent from every Target core mints the canonical for — a cluster
       * publishes its own record as part of the release, so there is nothing
       * for this seam to report back. Present on a platform-named Target
       * exactly when that platform hands back an address a CNAME can point
       * at; absent where it cannot (`static`'s Firebase Hosting needs an A
       * record and TXT verification, `cloudrun` has no custom-domain path
       * here), which `deploy-loop.ts` reads as "this Target publishes no
       * record for the name" rather than as a fault.
       */
      address?: {
        readonly recordType: 'CNAME';
        readonly target: string;
        readonly proxied: boolean;
      };
    }
  | {
      phase: 'FAILED';
      /** Present when something was placed before the failure. */
      ref?: DeployRef;
      reason: FailureReason;
      /** Free text: the sentence the developer reads. */
      detail?: string;
      /** The raw platform payload, kept for the operator (§6). */
      debug?: unknown;
    };

/** What `observe` reports: the platform's current answer, not core's memory. */
export interface ObservedState {
  ref: DeployRef;
  phase: DeployPhase;
  /**
   * The digest actually serving. Core compares it against the desired row to
   * detect drift, which is **surfaced, never silently corrected** (§6).
   */
  artifactDigest: string;
  reason?: FailureReason;
  detail?: string;
  /**
   * The cadence something is actually firing this placement on (§6, §7).
   *
   * A placement is not always one object. On `cloudrun` a scheduled job is a
   * Job *and* a Cloud Scheduler job in front of it, and the second one can be
   * deleted out of band while the first still reads back perfectly — so a
   * digest is not the whole answer to "is what was asked for still there".
   *
   * Three states, and the third is the reason this is optional rather than
   * `string | null`:
   *
   * - a **string** — the expression the backend holds.
   * - **`null`** — the backend was asked, and nothing fires it.
   * - **absent** — there is no separate firing half to be absent. Every
   *   service, and every Kubernetes placement: a CronJob lives inside the
   *   release Flux reconciles, so it is already covered by the digest read,
   *   and reporting `null` for it would mark every service drifted forever.
   *
   * **Reported, never judged.** Whether `null` is the honest state or a
   * schedule somebody deleted is a comparison against the Component's
   * declaration, which only core holds — the same rule `inspect` follows, so
   * that two adapters cannot draw the conclusion differently.
   */
  schedule?: string | null;
}

/** The Component-following runtime pipe (§17), distinct from attempt events. */
export interface RuntimeLogSubject {
  readonly app: string;
  readonly component: string;
  /**
   * One run of a job, when the question is about a run rather than the
   * Component (§17).
   *
   * A job's output does not belong to the Component the way a service's does.
   * "What is this Component saying now" has no answer for a job — nothing is
   * running most of the time — and merging every run's lines into one tail
   * would answer a question nobody asked, with last night's failure
   * interleaved into this morning's. So the subject narrows: the name is one
   * {@link JobExecution}'s, and the page is that run's lines and no other's.
   *
   * Absent for a service, which is the ordinary case and the reason this is
   * optional rather than a second method. The two differ by one clause in a
   * selector or a filter, and a second method would have had to restate the
   * cursor, the paging and the reach that make this one honest.
   *
   * **A run name, checked before it gets here.** Adapters put it into a query
   * language by concatenation — a Cloud Logging filter, a label selector — so a
   * caller that lets a request body reach this field unchecked hands the far
   * side a filter of the caller's choosing. `src/web/streams.ts` is the one
   * boundary this crosses from a browser and it is checked there; a second
   * caller owes the same check.
   */
  readonly execution?: string;
}

/**
 * One run of a job, as the backend reports it (§17).
 *
 * §17: "**A job is not a stream but a list of executions.** An execution
 * terminates, so it is attempt-shaped." Which is why this carries an outcome
 * rather than a {@link DeployPhase}: a run that ended is not a workload that
 * went `FAILED`, and borrowing the deploy vocabulary would put "the release is
 * down" and "last night's backup exited 1" under the same word.
 *
 * The `name` is the backend's own and is deliberately not parsed by core: it is
 * what {@link RuntimeLogSubject.execution} is filled with, so the only thing it
 * owes anyone is naming the same run twice.
 */
export interface JobExecution {
  /** The backend's own name for this run — what a tail reads its logs by. */
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'running';
  /** When the platform says it started, or `null` while it has not. */
  readonly startedAt: Date | null;
  /** The sentence a reader gets, where the backend offers one. */
  readonly detail?: string;
}

/**
 * What one run is started with, beyond the template it is made from (§17).
 *
 * `env` is the job story's "restore from snapshot X" knob: plain variables the
 * adapter appends to the run's container *after* the template's own, so a
 * name the template already sets is read as this run's value. Which is why
 * core refuses a name the placed workload already delivers (§10) before it
 * gets here — an override of a sealed reference would put the value inline in
 * a platform object. Adapters report the **names** on the run they started,
 * never the values: the timeline is read back from the platform and a value
 * there is a value in every log of it.
 */
export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** What starting a run produced, or why this backend had nothing to start. */
export type StartedRun =
  | { readonly kind: 'started'; readonly execution: JobExecution }
  | { readonly kind: 'none'; readonly because: string };

/** What a restart did, or why this backend had nothing to restart. */
export type Restarted =
  | {
      readonly kind: 'restarted';
      /** The sentence the timeline gets: what was stamped, and what rolls. */
      readonly detail: string;
    }
  | { readonly kind: 'none'; readonly because: string };

/**
 * The annotation a restart stamps on the workload's template.
 *
 * One key for both image backends, so an operator reading a pod template or
 * a revision finds the same word either side of the seam, under the prefix
 * the chart already stamps its own pod label with. The value is the time the
 * restart was asked for, which is what makes a second press a second rollout
 * rather than a no-op: the platforms roll on a template *change*, and a stamp
 * that stayed equal would be no change at all.
 */
export const RESTART_STAMP = 'spindrift.dev/restarted-at';

/** The runs that have happened, or why this backend has none to report. */
export type JobRuns =
  | {
      readonly kind: 'executions';
      /** Newest first — the order the screen reads them in. */
      readonly executions: readonly JobExecution[];
    }
  | { readonly kind: 'none'; readonly because: string };

/** One line from one replica, with the backend's durable resume position. */
export interface RuntimeLogEntry {
  readonly cursor: string;
  readonly at: Date;
  readonly line: string;
  readonly replica: string;
  readonly deployId?: string;
}

export interface RuntimeLogTailOptions {
  /** Opaque backend cursor returned by a prior page. */
  readonly after?: string;
  /** Bounded buffering: a page can never grow without limit. */
  readonly limit?: number;
}

export type RuntimeLogPage =
  | {
      readonly kind: 'stream';
      readonly entries: readonly RuntimeLogEntry[];
      readonly cursor: string | null;
      /** Seconds of history the Target says this tail can reach. */
      readonly reach: number;
    }
  | {
      readonly kind: 'none';
      readonly because: string;
    };

/**
 * What a cluster says about itself **before** it is a Target (§13).
 *
 * `inspect` cannot answer this: it takes a `DeployTarget`, and a `DeployTarget`
 * carries the very connection facts — namespace, delivery flavour, chart source
 * — an operator is here to choose. So a probe is the read that runs one step
 * earlier, against nothing but an address, and everything it returns is a
 * **list to pick from** rather than a verdict.
 *
 * Every field degrades to empty rather than throwing. A cluster that answers
 * some reads and refuses others is the ordinary state of a cluster whose
 * `spindrift-target` RBAC has not been merged yet, and a probe that gave up on
 * the first `403` would report nothing about a cluster that is nearly ready.
 * The screen says what was found; what was not found is the operator's to type.
 */
export interface ClusterProbe {
  /** False when the address did not answer at all — the one hard failure. */
  readonly reachable: boolean;
  /** Why it did not answer. Present exactly when `reachable` is false. */
  readonly because?: string;
  /** Delivery flavours this cluster serves a CRD for (§6). */
  readonly deliveryFlavours: readonly KubernetesDeliveryFlavour[];
  /** Namespaces that exist. Spindrift never creates one (§7). */
  readonly namespaces: readonly string[];
  /**
   * Sources the App chart could be fetched from — the Flux source objects of
   * whichever kind this installation's `charts.app` reference names.
   */
  readonly chartSources: readonly { name: string; namespace: string }[];
  /** `ClusterSecretStore`s config could be delivered through (§10). */
  readonly secretStores: readonly string[];
  /**
   * Gateways routes could attach to, with the address each answers on.
   *
   * The address is the same fact `platform.dns.privateAddress` needs, which is
   * why it is read here rather than asked for: an operator who picks a gateway
   * has already said where private traffic lands.
   */
  readonly gateways: readonly {
    name: string;
    namespace: string;
    address: string | null;
  }[];
}

/**
 * One backend, one artifact shape family, three verbs.
 *
 * `apply` is written as a generator because §6's contract is literally a stream
 * that resolves to a terminal verdict: the yielded values are the timeline, the
 * return value is the verdict.
 */
export interface DeployAdapter {
  /** Which adapter type this is — the same vocabulary Targets are seeded with. */
  readonly adapter: TargetAdapter;

  /**
   * The artifact types this backend accepts (§6's table: `kubernetes` and
   * `cloudrun` take an image, `static` takes files). Declaring it is what makes
   * "each backend declares which artifact types it accepts" mean something —
   * placement filters on it, and an artifact outside it reaching `apply` is a
   * core bug, reported as `INTERNAL` rather than rendered.
   */
  readonly artifactTypes: readonly ArtifactType[];

  /**
   * Place the desired state, streaming the attempt to a terminal verdict.
   *
   * **Re-applying one `DesiredState` leaves one placement.** Core re-runs
   * `apply` from the top rather than resuming — a lease reclaim, a crashed
   * reconciler, a rollout replacing the pod mid-apply all land here — so a
   * second call with the same `DesiredState` must converge on the object the
   * first call placed, never mint a sibling. How each backend earns that is
   * its own: `kubernetes` and `cloudrun` name the far-side object after the
   * Component, so a re-apply is a server-side apply of the same name; `static`
   * releases atomically onto one site; `vercel` and `cloudflare-pages` are
   * offered no name to converge on — the platform mints a new deployment per
   * create — so each queries for the deployment carrying its Deploy's marker
   * before creating one. That query-then-create is **not atomic**: those two
   * platforms give no unique-name constraint to lean on, so the guarantee
   * there is a bounded window, stated in each adapter's header, not an
   * impossibility.
   */
  apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void>;

  /** The current state, or `null` when nothing is there. */
  observe(target: DeployTarget, ref: DeployRef): Promise<ObservedState | null>;

  /** Idempotent: destroying what is already gone succeeds. */
  destroy(target: DeployTarget, ref: DeployRef): Promise<void>;

  /**
   * Remove what this adapter made for the *App* rather than for a placement,
   * once every one of its placements is gone (§13).
   *
   * `destroy` addresses a ref, and a ref names one placement. An adapter that
   * also has to mint a container for the App — the Kubernetes one creates the
   * App's namespace, because `HelmRelease.spec.install.createNamespace` takes
   * no metadata to put admission labels in — has nothing a ref names to take
   * that container away with, so deleting every placement leaves it behind
   * forever. This is the seam for it, and it is optional because it is the
   * Kubernetes adapter's problem alone: every other backend's refs cover
   * everything it created.
   *
   * **Only `deleteApp` calls it.** `unplaceComponent` removes one Component of
   * an App that goes on existing, and its siblings live in the same container.
   *
   * Idempotent, like `destroy`: sweeping what is already gone succeeds. It
   * throws to say what it could not remove, and `deleteApp` names that rather
   * than failing the delete.
   */
  sweepApp?(target: DeployTarget, app: string): Promise<void>;

  /**
   * Start one run of the job this ref names, now (§7, §17).
   *
   * **Why a verb and not a mode on `apply`.** §7: "a job always renders a
   * `CronJob`, suspended when unscheduled… `apply` for a job therefore becomes
   * two acts." `apply` is convergent and core re-applies it whenever desired
   * state moves, so a run folded into it would fire on a reach change, on a
   * config edit, on a rollback. The two acts have different arity — the object
   * is placed once and run any number of times — and one method cannot have
   * both.
   *
   * **Why a ref and not a `DesiredState`.** What is being run is what `apply`
   * placed, not a description core assembled a second time. Handing this a
   * `DesiredState` would let a run execute an image the Component is not
   * serving, which is exactly the kind of divergence storing the ref exists to
   * prevent.
   *
   * **Why it refuses rather than throws.** §13's "connect always succeeds" is
   * core's promise in one direction and this is the same promise in the other:
   * an adapter that has no job to run says so in a sentence, the way `tail`'s
   * `none` arm does, because "a website cannot be run" is a fact about the
   * backend and not an exception. A far side that *is* asked correctly and
   * fails — the API refused, the cluster is unreachable — throws, exactly as
   * `tail` does, because that is a fault and not an answer.
   *
   * `options.env` travels as {@link RunOptions} says; a backend that has no
   * job to run refuses exactly as it does without it.
   */
  run(
    target: DeployTarget,
    ref: DeployRef,
    options?: RunOptions,
  ): Promise<StartedRun>;

  /**
   * Replace the running process of what this ref placed, keeping everything
   * else the same (§6).
   *
   * **Why a verb and not a deploy.** A deploy is an intent to change the
   * desired row, and redeploying what is already desired is refused as
   * `UNCHANGED` — correctly, because nothing about the description moved. A
   * wedged process is not a change in what is desired; it is the platform's
   * copy of it gone stale, and the act that fixes it has to be sayable
   * without lying about the desired state. So this stamps the workload's
   * template with {@link RESTART_STAMP} and lets the platform roll: on a
   * cluster that is the chart's pod-template annotation, on the cloud runtime
   * a new revision of the same image. Nothing here re-renders the release —
   * a config or datastore change still arrives on the next Deploy.
   *
   * **Same shape as `run`.** A ref rather than a `DesiredState`, because what
   * is being bounced is what is placed; a refusal in a sentence for a backend
   * that has nothing to restart — a file tree has no process — and a throw
   * for a far side that was asked correctly and failed. Every adapter answers
   * it, so core can call it without asking which one it is holding.
   */
  restart(target: DeployTarget, ref: DeployRef): Promise<Restarted>;

  /**
   * The runs that have happened, newest first (§17).
   *
   * The second half of the same seam, split along the line `apply` and
   * `observe` are already split along: one member acts, one member reads. A run
   * nobody can see afterwards is not something an operator can be given, so
   * this is not an extra — it is what makes the verb above mean anything.
   *
   * **Read from the platform, never stored.** §17 fixes the history asymmetry
   * between backends "by rendering a larger history limit, not by storing logs
   * — configure the platform, don't build it", so the depth is the CronJob's
   * `successfulJobsHistoryLimit` on one backend and the runtime's own retention
   * on the other. `limit` is a page size, not that depth: it bounds what is
   * asked for and says nothing about what is kept.
   */
  executions(
    target: DeployTarget,
    ref: DeployRef,
    limit?: number,
  ): Promise<JobRuns>;

  /**
   * Read a bounded page of service output from the platform (§17).
   *
   * The cursor is platform-owned and survives a web/reconciler restart. Static
   * hosting returns the explicit `none` arm; it never masquerades as an empty
   * stream.
   *
   * A subject naming an `execution` asks the narrower question — one run's
   * lines rather than the Component's — and it is the only way a job's output
   * is readable, because a job's entries belong to the run that wrote them.
   */
  tail(
    target: DeployTarget,
    subject: RuntimeLogSubject,
    options?: RuntimeLogTailOptions,
  ): Promise<RuntimeLogPage>;

  /**
   * One pass of §13's prerequisite checklist and §3's capability discovery.
   *
   * A fourth verb rather than a fourth contract, because the thing that knows
   * how to ask a backend whether its policy engine is enforcing is the same
   * thing that knows how to place a workload on it — and §13 gives a Target
   * exactly one adapter type, so a second registry keyed the same way would
   * only be able to disagree with this one.
   *
   * It reports **observations, never judgements**: `verifiedDeploy` and
   * `offlineDeploy` are absent from {@link TargetInspection} on purpose, both
   * derived in core (§32, §33) so two adapters cannot draw the conclusion
   * differently. Errors are thrown rather than reported — §13's "connect always
   * succeeds" is core's promise to the operator, and core keeps it by catching
   * this, not by asking every adapter to.
   */
  inspect(target: DeployTarget): Promise<TargetInspection>;

  /**
   * Read a backend that is not a Target yet, so a connect can offer choices.
   *
   * Optional, and absent is the honest answer for two of the three adapters: a
   * cloud project's connection facts are a project id and two API roots, none
   * of which the project can be asked for before it is named. Only a cluster
   * has a discovery API to enumerate itself with, so only the cluster adapter
   * implements this — and an optional method with one implementation is
   * smaller than a second registry that could only ever hold the same one.
   */
  probe?(apiServer: string): Promise<ClusterProbe>;
}
