/**
 * Failure verdicts and checklist order shared by the cloud deploy adapters.
 * Only what holds for any HTTP control plane lives here.
 */
import type {
  Prerequisite,
  PrerequisiteResult,
} from '../../../domain/capabilities.ts';
import { prerequisitesFor } from '../../../domain/capabilities.ts';
import type { DeployRef, DeployVerdict } from '../contract.ts';
import type { CloudResponse } from './http.ts';

export type CloudFailure = Extract<CloudResponse<unknown>, { ok: false }>;

/**
 * A step returns its refusal instead of throwing, so the status and reason
 * that decide the blame survive.
 */
export type Outcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: CloudFailure };

/**
 * A success whose body lacks what was asked for. `transport`, since there is
 * no status to reason about.
 */
export function missing(message: string): CloudFailure {
  return { ok: false, kind: 'transport', message };
}

/**
 * No status, a 401/403 or a 5xx is `TARGET_UNREACHABLE`, blamed on the
 * platform. Any other 4xx is `REJECTED`: changing the request answers it.
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
 * In the adapter type's declared order, which the UI shows. An item no probe
 * answered is filled in as unmet and unassessed.
 */
export function orderedChecklist(
  results: readonly PrerequisiteResult[],
  adapter: Parameters<typeof prerequisitesFor>[0],
): readonly PrerequisiteResult[] {
  const found = new Map<Prerequisite, PrerequisiteResult>(
    results.map((result) => [result.name, result]),
  );
  return prerequisitesFor(adapter).map(
    (name) =>
      found.get(name) ?? {
        name,
        met: false,
        assessed: false,
        detail: 'not assessed',
      },
  );
}
