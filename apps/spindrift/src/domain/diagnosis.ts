/**
 * What a red Deploy remembers. Cluster events and cloud logs expire, so the
 * diagnosis, with its raw `debug` payload, is stored on the Deploy row.
 */
import {
  type Blame,
  blameFor,
  type DeployPhase,
  type DeployVerdict,
  type FailureReason,
} from '../adapters/deploy/contract.ts';

export interface Diagnosis {
  readonly reason: FailureReason;
  /** Derived from the reason. `null` only for `TIMEOUT`. */
  readonly blame: Blame | null;
  readonly detail: string | null;
  /** The raw platform payload, verbatim. */
  readonly debug: unknown;
}

export function diagnosisOf(verdict: DeployVerdict): Diagnosis | null {
  if (verdict.phase === 'LIVE') return null;
  return {
    reason: verdict.reason,
    blame: blameFor(verdict.reason),
    detail: verdict.detail ?? null,
    debug: verdict.debug ?? null,
  };
}

/**
 * Never includes `exposure`: the previous release is still serving, so a failed
 * deploy leaves the App exactly as reachable as it was.
 */
export function failureColumns(diagnosis: Diagnosis): {
  phase: 'FAILED';
  reason: FailureReason;
  blame: Blame | null;
  detail: string | null;
  debug: unknown;
} {
  return {
    phase: 'FAILED',
    reason: diagnosis.reason,
    blame: diagnosis.blame,
    detail: diagnosis.detail,
    debug: diagnosis.debug,
  };
}

/**
 * Only a `LIVE` Deploy can drift. A delivery object the platform refuses to
 * apply has drifted even when the observed digest matches.
 */
export function hasDrifted(args: {
  readonly phase: DeployPhase;
  /** The digest the Deploy's Build named. */
  readonly desiredDigest: string;
  /** What `observe` says is serving, or `null` when nothing is. */
  readonly observedDigest: string | null;
  /** What the delivery object reports now; `phase` is where this attempt ended. */
  readonly observedPhase?: DeployPhase;
  /** `null` when the Component declares no schedule. */
  readonly desiredSchedule?: string | null;
  /** `ObservedState.schedule`, forwarded as is. */
  readonly observedSchedule?: string | null;
}): boolean {
  if (args.phase !== 'LIVE') return false;
  if (args.observedDigest === null) return true;
  if (args.observedPhase === 'FAILED') return true;
  if (scheduleDrift(args) !== null) return true;
  return args.observedDigest !== args.desiredDigest;
}

/**
 * What the schedule disagrees about, in a sentence, or `null` when it agrees.
 * An absent `observedSchedule` means the backend has no separate firing half.
 */
export function scheduleDrift(args: {
  readonly desiredSchedule?: string | null;
  readonly observedSchedule?: string | null;
}): string | null {
  if (args.observedSchedule === undefined) return null;
  const desired = args.desiredSchedule ?? null;
  if (desired === args.observedSchedule) return null;
  if (args.observedSchedule === null) {
    return `nothing is firing this job — it declares the schedule "${desired}", and the platform holds none`;
  }
  return desired === null
    ? `this job declares no schedule, and the platform is still firing it on "${args.observedSchedule}"`
    : `this job declares the schedule "${desired}", and the platform is firing it on "${args.observedSchedule}"`;
}
