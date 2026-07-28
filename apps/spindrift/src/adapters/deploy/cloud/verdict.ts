/**
 * What the two cloud deploy adapters conclude from a refused call, and how a
 * checklist is ordered.
 *
 * Both were written twice before this file existed, identically, which is the
 * signal that they are properties of the *contract* rather than of either
 * backend: §6's failure vocabulary is closed and shared, so two adapters
 * mapping a `403` differently would put two meanings on one word in a UI that
 * shows the user one timeline.
 *
 * Nothing backend-specific lives here. A cloud API's own reason codes are read
 * by the adapter that knows them — `cloudrun/status.ts` for a revision's
 * condition, `cloud/checklist.ts` for a probe's refusal — and only the part
 * that is the same for any HTTP control plane is shared.
 */
import type {
  Prerequisite,
  PrerequisiteResult,
} from '../../../domain/capabilities.ts';
import { prerequisitesFor } from '../../../domain/capabilities.ts';
import type { DeployRef, DeployVerdict } from '../contract.ts';
import type { CloudResponse } from './http.ts';

/** A refusal, as {@link CloudHttp} hands one back. */
export type CloudFailure = Extract<CloudResponse<unknown>, { ok: false }>;

/**
 * A call that never landed, in §6's vocabulary.
 *
 * Two lines separate three quite different situations, and the split is §6's
 * blame column rather than an HTTP convention:
 *
 * - **No status at all** — the socket died, DNS failed, the uplink is down.
 *   Unambiguously the Target being unreachable.
 * - **A 4xx that is not an auth failure** — the project refusing this document:
 *   an org policy, a quota, an invalid spec. §6 puts all of those under
 *   `REJECTED` and blames the developer, because every one is answered by
 *   changing the request.
 * - **An auth failure or a 5xx** — the project being unavailable to Spindrift,
 *   which indicts the platform and not the person deploying.
 */
export function cloudWriteFailure(
  failure: CloudFailure,
  ref: DeployRef,
): Extract<DeployVerdict, { phase: 'FAILED' }> {
  if (failure.kind === 'transport') {
    return {
      phase: 'FAILED',
      ref,
      reason: 'TARGET_UNREACHABLE',
      detail: failure.message,
    };
  }
  const rejected = failure.status >= 400 && failure.status < 500;
  const authFailure = failure.status === 401 || failure.status === 403;
  return {
    phase: 'FAILED',
    ref,
    reason: rejected && !authFailure ? 'REJECTED' : 'TARGET_UNREACHABLE',
    detail: failure.message,
    debug: { status: failure.status, reason: failure.reason },
  };
}

/**
 * A checklist in its adapter type's declared order (§13).
 *
 * The order is the one the UI shows, so it belongs to the adapter type rather
 * than to whichever probe happened to answer first. An item nobody answered is
 * filled in as unmet: `deriveHealth` reads an unanswered row as unmet anyway,
 * and saying "not assessed" is more useful than a row that is silently absent.
 */
export function orderedChecklist(
  results: readonly PrerequisiteResult[],
  adapter: Parameters<typeof prerequisitesFor>[0],
): readonly PrerequisiteResult[] {
  const found = new Map<Prerequisite, PrerequisiteResult>(
    results.map((result) => [result.name, result]),
  );
  return prerequisitesFor(adapter).map(
    (name) => found.get(name) ?? { name, met: false, detail: 'not assessed' },
  );
}
