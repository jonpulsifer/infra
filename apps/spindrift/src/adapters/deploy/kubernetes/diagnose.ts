/**
 * The read on red (§6).
 *
 * "**Spindrift diagnoses on red**: on failure or stall it reads pods and events
 * (or the cloud log) **once** and fills in the detail. A read on red, not a
 * continuous watch." Two facts make that read worth doing at all: the delivery
 * object says a release failed without saying why, and **cluster events expire
 * in about an hour** — §12 stores the diagnosis precisely because the platform
 * will not keep it.
 *
 * Everything here is one pass over what two API calls returned. There is no
 * retry, no second look, and no branch that waits: a diagnosis that took time
 * to gather would be a watch wearing a different name.
 */
import type { Blame, FailureReason } from '../contract.ts';
import { blameFor } from '../contract.ts';
import type { KubernetesObject } from './api.ts';

/** What one read on red concluded. */
export interface Diagnosis {
  readonly reason: FailureReason;
  readonly blame: Blame | null;
  /** The sentence the developer reads, in the platform's own words. */
  readonly detail: string;
  /** The raw payload, kept for the operator (§6, §12). */
  readonly debug: unknown;
}

/** Container-status reasons that mean the artifact never arrived. */
const ARTIFACT_WAITING = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ImageInspectError',
  'RegistryUnavailable',
]);

/** Container-status reasons that mean the artifact arrived and would not run. */
const STARTUP_WAITING = new Set([
  'CrashLoopBackOff',
  'RunContainerError',
  'CreateContainerConfigError',
  'CreateContainerError',
  'StartError',
]);

/**
 * Event reasons that mean something refused to admit the workload.
 *
 * Exported because the datastore adapter reads the same warnings for the same
 * reason — an operator whose children are refused reports that it is still
 * working, forever. One list, because a refusal is a refusal whichever
 * controller was owed the pod, and two lists would be two chances to learn
 * about a new admission verdict in only one of them.
 */
export const REJECTION_EVENTS = new Set([
  'FailedCreate',
  'Forbidden',
  'FailedScheduling',
  'PolicyViolation',
  'ExceededQuota',
]);

interface ContainerStatus {
  name?: string;
  ready?: boolean;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number; message?: string };
  };
}

interface PodEvent {
  reason?: string;
  message?: string;
  type?: string;
  involvedObject?: { kind?: string; name?: string };
}

/**
 * Decide the reason from pods and events.
 *
 * Total by construction: every read ends in a reason, and it is allowed to
 * because its caller has already been told by the delivery object that this
 * release failed. {@link evidence} is the half of this that does not need that
 * guarantee, for the one caller that does not have it.
 */
export function diagnose(
  pods: readonly KubernetesObject[],
  events: readonly KubernetesObject[],
  fallbackDetail?: string,
): Diagnosis {
  return (
    evidence(pods, events, fallbackDetail) ??
    // No pod was ever created. Something between the release and the scheduler
    // refused it — an admission webhook, a quota, an invalid spec — and §6 puts
    // all three under one reason.
    //
    // Sound only because something has already declared this release failed.
    // Absent that, "no pods" is equally "no pods *yet*", which is exactly why
    // this branch is here rather than in `evidence`.
    conclude('REJECTED', fallbackDetail ?? 'the release produced no pods', {
      pods,
      events,
    })
  );
}

/**
 * The part of the read that rests on what was observed, or `null` when nothing
 * was.
 *
 * The order is the order the evidence is trustworthy in. A container that could
 * not pull its image is the least ambiguous thing in the list, and it is also
 * the one where every instinct is wrong — §6 calls `ARTIFACT_UNAVAILABLE` the
 * hardest justification for `blame` existing, because the build is green and
 * the developer is about to go and read their own code.
 *
 * Split out from {@link diagnose} for the deadline, which is the one red this
 * module is reached on without a verdict behind it. Handing that read to
 * `diagnose` would let its last branch conclude `REJECTED` — blame
 * `developer` — from an empty pod list, and an empty pod list under a deadline
 * is usually a chart still resolving or a wedged controller. Indicting the
 * developer for a platform stall is worse than the `TIMEOUT` it replaced,
 * which at least indicts nobody.
 *
 * Every branch below names something that was seen, so each is as true at a
 * deadline as it is at a verdict.
 */
export function evidence(
  pods: readonly KubernetesObject[],
  events: readonly KubernetesObject[],
  fallbackDetail?: string,
): Diagnosis | null {
  const statuses = pods.flatMap((pod) => containerStatuses(pod));

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason !== undefined && ARTIFACT_WAITING.has(waiting.reason)) {
      return conclude(
        'ARTIFACT_UNAVAILABLE',
        waiting.message ?? waiting.reason,
        { pods, events },
      );
    }
  }

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason !== undefined && STARTUP_WAITING.has(waiting.reason)) {
      return conclude('STARTUP_FAILED', waiting.message ?? waiting.reason, {
        pods,
        events,
      });
    }
    const terminated = status.state?.terminated;
    if (terminated !== undefined && (terminated.exitCode ?? 0) !== 0) {
      return conclude(
        'STARTUP_FAILED',
        terminated.message ??
          `container ${status.name ?? 'app'} exited with ${terminated.exitCode}`,
        { pods, events },
      );
    }
  }

  const rejection = (events as readonly PodEvent[]).find(
    (event) => event.reason !== undefined && REJECTION_EVENTS.has(event.reason),
  );
  if (rejection !== undefined) {
    return conclude(
      'REJECTED',
      rejection.message ?? (rejection.reason as string),
      { pods, events },
    );
  }

  // Pods exist, none of them is ready, and nothing said why: the workload came
  // up and never passed readiness, which is exactly `UNHEALTHY` (§6).
  if (
    statuses.length > 0 &&
    statuses.every((status) => status.ready !== true)
  ) {
    return conclude(
      'UNHEALTHY',
      fallbackDetail ?? 'the workload started but never became ready',
      { pods, events },
    );
  }

  return null;
}

function conclude(
  reason: FailureReason,
  detail: string,
  debug: unknown,
): Diagnosis {
  return { reason, blame: blameFor(reason), detail, debug };
}

function containerStatuses(pod: KubernetesObject): ContainerStatus[] {
  const status = pod.status as
    | {
        containerStatuses?: ContainerStatus[];
        initContainerStatuses?: ContainerStatus[];
      }
    | undefined;
  return [
    ...(status?.initContainerStatuses ?? []),
    ...(status?.containerStatuses ?? []),
  ];
}
