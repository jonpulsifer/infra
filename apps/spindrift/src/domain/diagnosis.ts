/**
 * What a red Deploy remembers (§6, §12).
 *
 * §6: "**Spindrift diagnoses on red**: on failure or stall it reads pods and
 * events (or the cloud log) **once** and fills in the detail."
 *
 * The adapter does that read — it is the only thing that knows what a pod is —
 * and this module is what makes the answer outlive it. §12 states the reason
 * plainly: **the platform will not keep it.** Cluster events expire in about an
 * hour, a Cloud Run revision's logs roll, and a developer who opens the deploy
 * screen the next morning would otherwise find a red Deploy with no explanation
 * and no way to get one back. So the diagnosis is denormalized onto the Deploy
 * row at the moment it is drawn, and every read after that is a read of core's
 * own storage rather than a second trip to a backend that has forgotten.
 *
 * That is also the reason `debug` is stored verbatim. The closed `reason` is
 * what the UI keys on and what a test asserts; the raw payload is for the
 * operator who needs to know which admission webhook, and it is precisely the
 * thing that no longer exists an hour later.
 *
 * **Blame is derived, never taken.** §6: an adapter "reports a reason and never
 * a blame... so two adapters cannot disagree about who a failure indicts."
 */
import {
  type Blame,
  blameFor,
  type DeployPhase,
  type DeployVerdict,
  type FailureReason,
} from '../adapters/deploy/contract.ts';

/** The columns a red Deploy carries, as one value. */
export interface Diagnosis {
  readonly reason: FailureReason;
  /** Derived from the reason via §6's table. `null` only for `TIMEOUT`. */
  readonly blame: Blame | null;
  /** The sentence the developer reads, in the platform's own words. */
  readonly detail: string | null;
  /** The raw platform payload, kept for the operator (§6, §12). */
  readonly debug: unknown;
}

/**
 * Draw the diagnosis from a terminal verdict.
 *
 * `null` for a green verdict, which is not the same as an empty diagnosis: a
 * Deploy that succeeded has nothing to explain, and writing a row of nulls would
 * make "was this ever diagnosed" unanswerable.
 */
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
 * The columns a failed attempt writes, and **nothing else**.
 *
 * Named as its own function because of what it must not contain. §9: "**exposure
 * never mutates on red**" — a failed deploy leaves the App exactly as reachable
 * as it was, because the previous release is still serving and quietly making it
 * unreachable would turn one failed deploy into an outage. There is no `exposure`
 * key here, and there is no code path that adds one: a red Deploy updates its own
 * verdict columns and stops.
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
 * Whether what is running is what was asked for (§6).
 *
 * "**Drift is detected and surfaced, never silently corrected** — a visible state
 * with a one-click re-converge." So this returns an answer and takes no action,
 * and nothing downstream of it applies anything: the re-converge is an ordinary
 * Deploy that a person presses, which is the same path every other change takes.
 *
 * Drift is only meaningful for a Deploy that reached `LIVE`. A Deploy still
 * converging has not drifted; it has not arrived.
 */
export function hasDrifted(args: {
  readonly phase: DeployPhase;
  /** The digest the Deploy's Build named. */
  readonly desiredDigest: string;
  /** The digest `observe` says is actually serving, or `null` when nothing is. */
  readonly observedDigest: string | null;
}): boolean {
  if (args.phase !== 'LIVE') return false;
  if (args.observedDigest === null) return true;
  return args.observedDigest !== args.desiredDigest;
}
