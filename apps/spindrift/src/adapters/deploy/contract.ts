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
import type { TargetConnection } from '../../domain/target.ts';

/**
 * What the verbs need to name a Target. The Target model (§13) carries
 * capabilities and connection material as well; this is the narrow view the
 * contract takes, because a Target has exactly one adapter type and the adapter
 * is constructed against the connection.
 */
export interface DeployTarget {
  /** Stable identifier, unique within the installation. */
  readonly name: string;
  /** Exactly one adapter type per Target (§13). */
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
   * **Never a credential** (§13: "one auth mode — native OIDC federation,
   * nothing stored"). What authorizes a call is minted per request by whatever
   * federates, and is injected when the adapter is constructed.
   */
  readonly connection: TargetConnection;
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

  apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void>;

  /** The current state, or `null` when nothing is there. */
  observe(target: DeployTarget, ref: DeployRef): Promise<ObservedState | null>;

  /** Idempotent: destroying what is already gone succeeds. */
  destroy(target: DeployTarget, ref: DeployRef): Promise<void>;

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
}
