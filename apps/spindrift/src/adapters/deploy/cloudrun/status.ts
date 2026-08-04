/**
 * What a Cloud Run Service or Job says, in §6's vocabulary rather than its own.
 *
 * §6 gives the user **one shared vocabulary** along one timeline, so the
 * runtime's condition states and reason enums never reach core. This is the
 * translation, and it is a pure function over the document for the same reason
 * the Kubernetes flavours' translations are: the interesting cases are the ones
 * where the platform is precise about *why*, and a test should be able to hand
 * them over one at a time.
 *
 * **Status comes from the resource, not from the apply.** A Service accepted by
 * the API has not started anything and neither has an accepted Job:
 * `terminalCondition` is what turns pending into a verdict, which is why §6's
 * phases come from the platform and never from core's idea of readiness. Both
 * resources report it in the same shape, so one reading serves both — the
 * documents differ in what they *are*, not in how they say whether they are
 * ready.
 */
import type { DeployPhase, FailureReason } from '../contract.ts';

/**
 * What every workload this adapter places says about itself.
 *
 * A Service and a Job report readiness identically — one `terminalCondition`
 * and a list of `conditions`, in the same vocabulary — which is why
 * {@link cloudRunStatus} takes both and there is no second translation table.
 * A Job's readiness is its own conditions, not a Service's revisions and
 * traffic, and this is the part of the Service reading that never depended on
 * either.
 */
export interface CloudRunConditions {
  readonly terminalCondition?: CloudRunCondition;
  readonly conditions?: readonly CloudRunCondition[];
}

/** The template both documents end in, whatever they wrap it in. */
export interface CloudRunTaskTemplate {
  readonly containers?: readonly { readonly image?: string }[];
}

/**
 * The fields this adapter reads back off a Service or a Job.
 *
 * One interface rather than two because the difference between the documents is
 * one level of nesting and one absent field, and both are read by code that has
 * a ref rather than a kind: `observe` and `destroy` are handed an opaque handle
 * (§6) and no Component.
 *
 * `uri` is a Service's — a Job has no address, and reading it off a Job document
 * yields `undefined`, which is exactly the answer core wants for something
 * nothing routes to. `template.template` is a Job's — a Service's
 * `TaskTemplate` has no such member, which is what makes {@link servingDigest}
 * able to tell the shapes apart without being told.
 */
export interface CloudRunWorkload extends CloudRunConditions {
  readonly uri?: string;
  readonly template?: CloudRunTaskTemplate & {
    readonly template?: CloudRunTaskTemplate;
  };
}

/** One condition, as much of it as this adapter reads. */
export interface CloudRunCondition {
  readonly type?: string;
  readonly state?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly revisionReason?: string;
  readonly executionReason?: string;
}

/** The translated verdict, in the shape core reads. */
export interface CloudRunStatus {
  phase: DeployPhase;
  reason?: FailureReason;
  detail?: string;
  debug?: unknown;
}

/**
 * Reasons the runtime gives, mapped to §6's closed set.
 *
 * The group that matters most is the first: every one of them is the artifact
 * being unpullable, which §6 blames on the **platform**. That is the case §6
 * singles out — "the build is green and every instinct wrongly says *look at my
 * app*" — and it is the whole reason this table is written out rather than
 * collapsed into a default.
 */
const REASONS: Readonly<Record<string, FailureReason>> = {
  CONTAINER_MISSING: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_IMAGE_UNAUTHORIZED: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_IMAGE_AUTHORIZATION_CHECK_FAILED: 'ARTIFACT_UNAVAILABLE',
  CONTAINER_PERMISSION_DENIED: 'ARTIFACT_UNAVAILABLE',

  PROGRESS_DEADLINE_EXCEEDED: 'TIMEOUT',

  HEALTH_CHECK_CONTAINER_ERROR: 'UNHEALTHY',

  // Admission-shaped refusals: an org policy, a key the project may not use, a
  // limit already reached. §6 puts all of them under one reason, and blames the
  // developer, because every one of them is answered by changing the request.
  ENCRYPTION_KEY_PERMISSION_DENIED: 'REJECTED',
  ACTIVE_REVISION_LIMIT_REACHED: 'REJECTED',
  MIN_INSTANCES_NOT_PROVISIONED: 'REJECTED',
};

/**
 * The state values a terminal condition can hold.
 *
 * `CONDITION_RECONCILING` and `CONDITION_PENDING` are both "still going"; the
 * runtime distinguishes them and core does not, because §6's `WAITING` covers
 * exactly the period in which neither answer has arrived.
 */
const SUCCEEDED = 'CONDITION_SUCCEEDED';
const FAILED = 'CONDITION_FAILED';

/** Translate one Service or Job document into §6's phase and reason. */
export function cloudRunStatus(service: CloudRunConditions): CloudRunStatus {
  const terminal = service.terminalCondition;
  if (terminal === undefined) {
    // Applied, and the runtime has not yet said anything about it.
    return { phase: 'WAITING' };
  }

  if (terminal.state === SUCCEEDED) return { phase: 'LIVE' };

  if (terminal.state !== FAILED) {
    return {
      phase: 'WAITING',
      ...(terminal.message === undefined ? {} : { detail: terminal.message }),
    };
  }

  // The runtime reports a failure in up to three places and only some of them
  // are set for any one failure, so all three are consulted in the order that
  // puts the most specific first. A reason nobody set leaves `reason` unmapped,
  // which is handled below rather than guessed at here.
  const stated =
    terminal.revisionReason ?? terminal.executionReason ?? terminal.reason;
  const mapped = stated === undefined ? undefined : REASONS[stated];
  const failing = failingCondition(service);

  return {
    phase: 'FAILED',
    // §6's Covers column puts "revision will not start" under `STARTUP_FAILED`,
    // which is what an unrecognised failure of a revision is: the runtime said
    // the rollout failed, and the least wrong thing to tell a developer is that
    // their revision did not come up.
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

/** The first non-terminal condition that is itself failing, for its message. */
function failingCondition(
  service: CloudRunConditions,
): CloudRunCondition | undefined {
  return (service.conditions ?? []).find(
    (condition) => condition.state === FAILED,
  );
}

/**
 * The digest actually placed, as the workload still carries it.
 *
 * Read off the template's image rather than off the latest ready revision or
 * the latest execution, because the template is what core wrote and what drift
 * is measured against. An image with no digest yields an empty string, which
 * compares unequal to every desired digest — drift is surfaced rather than
 * assumed away (§6).
 *
 * **The inner template first, because only a Job has one.** A Service's
 * `template` is the task template; a Job's `template` is an `ExecutionTemplate`
 * whose own `template` is. A `TaskTemplate` has no `template` member at all, so
 * the inner read is present exactly when the document is a Job — which is why
 * this needs no kind handed to it, and why `observe` can answer a ref whose
 * collection it has only just parsed.
 */
export function servingDigest(workload: CloudRunWorkload): string {
  const template = workload.template?.template ?? workload.template;
  const image = template?.containers?.[0]?.image ?? '';
  const at = image.lastIndexOf('@');
  return at === -1 ? '' : image.slice(at + 1);
}
