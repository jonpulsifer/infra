/**
 * The deploy adapter contract. Verbs are one shot: reconciliation lives in
 * core, and `observe` is a poll because core decides when to look. On red an
 * adapter reads pods, events or the cloud log once to fill in the detail.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { TargetInspection } from '../../domain/capabilities.ts';
import type { ArtifactType, DesiredState } from '../../domain/desired-state.ts';
import type {
  AdapterConnection,
  KubernetesDeliveryFlavour,
} from '../../domain/target.ts';

export interface DeployTarget {
  /** The Vessel's name, for labels only. Adapters never dispatch on it. */
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  /**
   * Passed per call because one adapter serves every Target of its type. Never
   * a credential: auth is minted per request and injected at construction.
   */
  readonly connection: AdapterConnection;
}

/** The adapter's handle on what `apply` placed. Core never parses it. */
export type DeployRef = string;

export const DEPLOY_PHASES = [
  'PENDING',
  'APPLYING',
  'WAITING',
  'LIVE',
  'FAILED',
] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

export type TerminalPhase = Extract<DeployPhase, 'LIVE' | 'FAILED'>;

/**
 * Shared with builds, so the timeline has one vocabulary. Free text goes in
 * `detail` and the raw payload in `debug`, never in a reason.
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

export const BLAMES = ['developer', 'platform'] as const;

export type Blame = (typeof BLAMES)[number];

/**
 * Adapters report a reason and never a blame, so two adapters cannot disagree.
 * `null`: a timeout indicts nobody.
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

export function blameFor(reason: FailureReason): Blame | null {
  return BLAME[reason];
}

function unreachable(value: never): never {
  throw new Error(`unhandled failure reason: ${String(value)}`);
}

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
 * The attempt-scoped log `apply` streams. A running app's stdout never goes
 * here: it is unbounded and the attempt must end. `tail` reads it instead.
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
      resource?: string;
      reason?: FailureReason;
      /** Adapters may leave it unset; core sets it from {@link BLAME}. */
      blame?: Blame | null;
      detail?: string;
    };

/** `apply` never throws: a thrown error has no reason and so no blame. */
export type DeployVerdict =
  | {
      phase: 'LIVE';
      ref: DeployRef;
      /** Set only where the platform names the canonical address itself. */
      url?: string;
      /**
       * Where a DNS record for a platform-served name should point. Absent
       * when this Target publishes no record, which is not a fault.
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
      /** The sentence the developer reads. */
      detail?: string;
      /** The raw platform payload, kept for the operator. */
      debug?: unknown;
    };

/** What `observe` reports: the platform's current answer, not core's memory. */
export interface ObservedState {
  ref: DeployRef;
  phase: DeployPhase;
  /** The digest serving now. Core reports drift and never corrects it. */
  artifactDigest: string;
  reason?: FailureReason;
  detail?: string;
  /** The raw payload behind a `FAILED`, kept since pods and events expire. */
  debug?: unknown;
  /**
   * The schedule a separately placed trigger holds; `null` means nothing fires
   * it. Absent where no separate trigger exists, as on Kubernetes.
   */
  schedule?: string | null;
}

export interface RuntimeLogSubject {
  readonly app: string;
  readonly component: string;
  /**
   * A job run's name, narrowing the tail to that run. Adapters concatenate it
   * into a filter or selector, so every caller must validate it first.
   */
  readonly execution?: string;
}

export interface JobExecution {
  /** The backend's name for this run, which a tail reads logs by. Opaque. */
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'running';
  /** `null` while the run has not started. */
  readonly startedAt: Date | null;
  readonly detail?: string;
}

/**
 * `env` is appended after the template's own variables, so it overrides them.
 * Adapters report the names they set, never the values.
 */
export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export type StartedRun =
  | { readonly kind: 'started'; readonly execution: JobExecution }
  | { readonly kind: 'none'; readonly because: string };

export type Restarted =
  | {
      readonly kind: 'restarted';
      /** The sentence the timeline gets: what was stamped, and what rolls. */
      readonly detail: string;
    }
  | { readonly kind: 'none'; readonly because: string };

/**
 * Stamped on the workload template with the request time. A template change is
 * what makes the platform roll, so each restart needs a new value.
 */
export const RESTART_STAMP = 'spindrift.dev/restarted-at';

export type JobRuns =
  | {
      readonly kind: 'executions';
      /** Newest first. */
      readonly executions: readonly JobExecution[];
    }
  | { readonly kind: 'none'; readonly because: string };

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
 * What a cluster reports before it is a Target, as choices for the operator.
 * Fields degrade to empty instead of throwing, since partial RBAC is normal.
 */
export interface ClusterProbe {
  /** False only when the address did not answer at all. */
  readonly reachable: boolean;
  /** Present exactly when `reachable` is false. */
  readonly because?: string;
  /** Delivery flavours this cluster serves a CRD for. */
  readonly deliveryFlavours: readonly KubernetesDeliveryFlavour[];
  readonly namespaces: readonly string[];
  /** Flux sources of the kind the installation's `charts.app` names. */
  readonly chartSources: readonly { name: string; namespace: string }[];
  readonly secretStores: readonly string[];
  /** The address is the same fact `platform.dns.privateAddress` needs. */
  readonly gateways: readonly {
    name: string;
    namespace: string;
    address: string | null;
  }[];
}

/** `apply` yields the timeline and returns the verdict. */
export interface DeployAdapter {
  readonly adapter: TargetAdapter;

  /** Placement filters on this; any other artifact in `apply` is `INTERNAL`. */
  readonly artifactTypes: readonly ArtifactType[];

  /**
   * Core re-runs `apply` from the top after a crash or lease reclaim, so a
   * second call with the same `DesiredState` must converge on one placement.
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
   * Removes what the adapter made for the whole App, such as a namespace. Only
   * App delete calls it. Idempotent; throws naming what it could not remove.
   */
  sweepApp?(target: DeployTarget, app: string): Promise<void>;

  /**
   * Starts one run of the job this ref placed. A backend with no job answers
   * `none`; a far-side failure throws.
   */
  run(
    target: DeployTarget,
    ref: DeployRef,
    options?: RunOptions,
  ): Promise<StartedRun>;

  /**
   * Stamps {@link RESTART_STAMP} so the platform replaces the running process.
   * A backend with nothing to restart answers `none`; a far-side fault throws.
   */
  restart(target: DeployTarget, ref: DeployRef): Promise<Restarted>;

  /**
   * Reads run history from the platform; nothing is stored. `limit` bounds the
   * page, not the history the platform keeps.
   */
  executions(
    target: DeployTarget,
    ref: DeployRef,
    limit?: number,
  ): Promise<JobRuns>;

  /**
   * The cursor is platform-owned and survives a restart. A backend with no
   * runtime output answers `none`, never an empty stream.
   */
  tail(
    target: DeployTarget,
    subject: RuntimeLogSubject,
    options?: RuntimeLogTailOptions,
  ): Promise<RuntimeLogPage>;

  /**
   * Reports observations only; core derives the judgements. Throws on error,
   * and core catches it so connecting a Target always succeeds.
   */
  inspect(target: DeployTarget): Promise<TargetInspection>;

  /** Reads a backend before it is a Target. Only the cluster adapter can. */
  probe?(apiServer: string): Promise<ClusterProbe>;
}
