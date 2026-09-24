/**
 * A Cloud Run Service's or Job's conditions, translated into the shared deploy
 * phases and reasons. The phase comes from the resource's `terminalCondition`,
 * never from the API having accepted the apply.
 */
import type { DeployPhase, FailureReason } from '../contract.ts';

/** A Service and a Job report readiness in the same shape. */
export interface CloudRunConditions {
  readonly terminalCondition?: CloudRunCondition;
  readonly conditions?: readonly CloudRunCondition[];
}

/** The `TaskTemplate` both documents end in. */
export interface CloudRunTaskTemplate {
  readonly containers?: readonly { readonly image?: string }[];
}

/**
 * A Service or a Job, read by code holding a ref and no kind. Only a Service
 * has `uri`; only a Job has `template.template`.
 */
export interface CloudRunWorkload extends CloudRunConditions {
  readonly uri?: string;
  readonly template?: CloudRunTaskTemplate & {
    readonly template?: CloudRunTaskTemplate;
  };
}

export interface CloudRunCondition {
  readonly type?: string;
  readonly state?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly revisionReason?: string;
  readonly executionReason?: string;
}

export interface CloudRunStatus {
  phase: DeployPhase;
  reason?: FailureReason;
  detail?: string;
  debug?: unknown;
}

/**
 * The first group is an unpullable artifact: the platform's fault, even with
 * the build green.
 */
const REASONS: Readonly<Record<string, FailureReason>> = {
  CONTAINER_MISSING: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_IMAGE_UNAUTHORIZED: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_IMAGE_AUTHORIZATION_CHECK_FAILED: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_PERMISSION_DENIED: 'ARTIFACT_UNAVAILABLE',

  PROGRESS_DEADLINE_EXCEEDED: 'TIMEOUT',

  HEALTH_CHECK_CONTAINER_ERROR: 'UNHEALTHY',

  // Refusals answered by changing the request: an org policy, a key the
  // project may not use, a limit already reached.
  ENCRYPTION_KEY_PERMISSION_DENIED: 'REJECTED',
  ACTIVE_REVISION_LIMIT_REACHED: 'REJECTED',
  MIN_INSTANCES_NOT_PROVISIONED: 'REJECTED',
};

/** Any other state, pending or reconciling, is still `WAITING`. */
const SUCCEEDED = 'CONDITION_SUCCEEDED';
const FAILED = 'CONDITION_FAILED';

export function cloudRunStatus(service: CloudRunConditions): CloudRunStatus {
  const terminal = service.terminalCondition;
  if (terminal === undefined) {
    return { phase: 'WAITING' };
  }

  if (terminal.state === SUCCEEDED) return { phase: 'LIVE' };

  if (terminal.state !== FAILED) {
    return {
      phase: 'WAITING',
      ...(terminal.message === undefined ? {} : { detail: terminal.message }),
    };
  }

  // Only some of the three reason fields are set per failure; most specific
  // first.
  const stated =
    terminal.revisionReason ?? terminal.executionReason ?? terminal.reason;
  const mapped = stated === undefined ? undefined : REASONS[stated];
  const failing = failingCondition(service);

  return {
    phase: 'FAILED',
    // An unrecognised failure is a revision that did not come up.
    reason: mapped ?? 'STARTUP_FAILED',
    detail:
      terminal.message ??
      failing?.message ??
      (stated === undefined
        ? 'the runtime reported the rollout failed and gave no reason'
        : `the runtime reported ${stated}`),
    debug: {
      terminalCondition: terminal,
      ...(failing === undefined ? {} : { condition: failing }),
    },
  };
}

/** The first failing non-terminal condition, for its message. */
function failingCondition(
  service: CloudRunConditions,
): CloudRunCondition | undefined {
  return (service.conditions ?? []).find(
    (condition) => condition.state === FAILED,
  );
}

/**
 * Off the template, which core wrote and drift is measured against. An image
 * with no digest yields an empty string, so drift is surfaced. Only a Job has
 * an inner `template`, so reading it first needs no kind.
 */
export function servingDigest(workload: CloudRunWorkload): string {
  const template = workload.template?.template ?? workload.template;
  const image = template?.containers?.[0]?.image ?? '';
  const at = image.lastIndexOf('@');
  return at === -1 ? '' : image.slice(at + 1);
}
