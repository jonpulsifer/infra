/**
 * What the three build routes share, which is less than it looks.
 *
 * The three backends have nothing in common mechanically — a workflow dispatch,
 * a cloud API, a Kubernetes Job — so this module holds only the parts that are
 * the *contract's* shape rather than any backend's: how a green result is
 * assembled from a runner's report, how a red one is assembled from a reason,
 * and how a poll loop is bounded.
 *
 * **Waiting is injected, not imported.** Every route polls, and a test that
 * polls in real time is a test that takes a real minute — so the clock and the
 * sleep are constructor material for all three, and a test drives a whole build
 * to its verdict in microseconds without a single fake timer.
 */
import type { FailureReason } from '../deploy/contract.ts';
import type {
  BuildLevel,
  BuildLogs,
  BuildResult,
  BuildSource,
  BuildSpec,
} from './contract.ts';
import type { BuildReport } from './report.ts';

/** Sleeps for a while. Injected so a test's build takes no wall-clock time. */
export type Sleeper = (milliseconds: number) => Promise<void>;

/** The real one, which {@link deadlineFrom} falls back to when none is given. */
export const realSleeper: Sleeper = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** How a route paces itself, and when it gives up. */
export interface PollingOptions {
  /** How long between reads of the backend's status. */
  readonly intervalMs?: number;
  /**
   * How long a build may run before the route reports `TIMEOUT`.
   *
   * A route must have one: a backend that never reaches a terminal state would
   * otherwise leave the Build `RUNNING` forever, and §6's `TIMEOUT` — the one
   * reason that indicts nobody — is exactly the verdict for that.
   */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: Sleeper;
}

/** A poll interval that reads as attentive without hammering a CI's API. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Long enough for a cold container build, short enough to not hang a screen. */
export const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60_000;

/** The bounded loop all three routes wait in. */
export class Deadline {
  private readonly startedAt: number;

  constructor(
    private readonly options: Required<
      Pick<PollingOptions, 'intervalMs' | 'timeoutMs'>
    > & {
      readonly now: () => Date;
      readonly sleep: Sleeper;
    },
  ) {
    this.startedAt = options.now().getTime();
  }

  /** Whether the budget is spent. Checked before each read, never after. */
  expired(): boolean {
    return (
      this.options.now().getTime() - this.startedAt >= this.options.timeoutMs
    );
  }

  /** Wait one interval. */
  tick(): Promise<void> {
    return this.options.sleep(this.options.intervalMs);
  }
}

/** Build a {@link Deadline} from whatever the caller supplied. */
export function deadlineFrom(options: PollingOptions = {}): Deadline {
  return new Deadline({
    intervalMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? realSleeper,
  });
}

/**
 * A red verdict.
 *
 * Every field of the failure arm is filled here rather than at each call site,
 * because the arm's whole job is to be impossible to confuse with a green one:
 * `artifact`, `provenance`, and `baseDigest` are `null` on it by construction,
 * and a route that wants to report a digest has to say `SUCCEEDED` to do it.
 */
export function buildFailed(
  logs: BuildLogs,
  reason: FailureReason,
  detail?: string,
  debug?: unknown,
): BuildResult {
  return {
    status: 'FAILED',
    artifact: null,
    logs,
    provenance: null,
    baseDigest: null,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(debug === undefined ? {} : { debug }),
  };
}

/**
 * A green verdict, from what a runner reported.
 *
 * **The bundle digest is checked, not copied**, and what that check is worth is
 * worth being exact about. §16 makes the digest "a build parameter on every
 * route" so that the source receipt and the provenance document have a join,
 * and every route here does hand it to the runner and compare what comes back.
 * What it catches is a runner that built something other than what it was
 * dispatched — a stale cached bundle, a mis-wired route, a report from another
 * build. What it does **not** catch is a runner that lies, because the value it
 * echoes is the value it was given.
 *
 * **The honest gap, and it is Task 26's**: `statement` below is the runner's
 * own account of itself, not an attestation anything verified. §16 wants core
 * to "verify the build backend's provenance against the Target's minimum level
 * **before** signing", and doing that means fetching the attestation the
 * builder attached to the artifact and checking it — none of which happens
 * here. Until it does, a green Build carries a claim rather than evidence.
 */
export function buildSucceeded(input: {
  readonly source: BuildSource;
  readonly spec: BuildSpec;
  readonly logs: BuildLogs;
  readonly level: BuildLevel;
  readonly report: BuildReport;
}): BuildResult {
  const { source, spec, logs, level, report } = input;

  if (report.bundleDigest !== source.bundleDigest) {
    return buildFailed(
      logs,
      'INTERNAL',
      `the runner reported a build of bundle ${report.bundleDigest} but was handed ${source.bundleDigest}`,
    );
  }

  return {
    status: 'SUCCEEDED',
    artifact: {
      type: spec.artifactType,
      digest: report.digest,
      refs: [...report.refs],
    },
    logs,
    provenance: {
      bundleDigest: source.bundleDigest,
      claimedLevel: level,
      statement: report.statement ?? null,
    },
    baseDigest: report.baseDigest,
  };
}
