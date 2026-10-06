/**
 * What every build route shares: the green and red results and the bounded
 * poll loop. The clock and sleep are injectable, so test builds take no time.
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

export type Sleeper = (milliseconds: number) => Promise<void>;

export const realSleeper: Sleeper = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface PollingOptions {
  readonly intervalMs?: number;
  /** Bounds the build, so a backend that never finishes ends in `TIMEOUT`. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: Sleeper;
}

/** Attentive without hammering a CI's API. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Long enough for a cold container build, short enough to not hang a screen. */
export const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60_000;

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

  expired(): boolean {
    return (
      this.options.now().getTime() - this.startedAt >= this.options.timeoutMs
    );
  }

  tick(): Promise<void> {
    return this.options.sleep(this.options.intervalMs);
  }
}

export function deadlineFrom(options: PollingOptions = {}): Deadline {
  return new Deadline({
    intervalMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? realSleeper,
  });
}

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
    buildkitProvenanceRef: null,
    sbomRef: null,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(debug === undefined ? {} : { debug }),
  };
}

/**
 * The echoed bundle digest must match the dispatched one. That catches a stale
 * bundle or a crossed report, and cannot catch a runner that lies.
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
    buildkitProvenanceRef: report.buildkitProvenanceRef ?? null,
    sbomRef: report.sbomRef ?? null,
  };
}
