/**
 * Names why a release went red from one read of its pods, events and
 * ExternalSecrets, with no retry and no wait. Cluster events expire in about an
 * hour, so callers keep the diagnosis in the verdict's `debug`.
 */
import type { Blame, FailureReason } from '../contract.ts';
import { blameFor } from '../contract.ts';
import type { KubernetesObject } from './api.ts';

export interface Diagnosis {
  readonly reason: FailureReason;
  readonly blame: Blame | null;
  /** The sentence the developer reads, in the platform's own words. */
  readonly detail: string;
  /** The raw payload, kept for the operator. */
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
 * Event reasons that mean admission refused the workload. The datastore adapter
 * shares the list, so a new refusal is learned in one place.
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

/** What one read on red saw, already narrowed to one Deploy's objects. */
export interface Observed {
  readonly pods: readonly KubernetesObject[];
  readonly events: readonly KubernetesObject[];
  readonly secrets: readonly KubernetesObject[];
}

interface PodEvent {
  reason?: string;
  message?: string;
  type?: string;
  involvedObject?: { kind?: string; name?: string };
}

/**
 * Always names a reason, which is sound only once the delivery object has said
 * the release failed. Without that verdict, call {@link evidence}.
 */
export function diagnose(
  observed: Observed,
  fallbackDetail?: string,
): Diagnosis {
  return (
    evidence(observed, fallbackDetail) ??
    // No pod was created, so something between the release and the scheduler
    // refused it. Without a failed verdict, no pods could mean no pods yet.
    conclude(
      'REJECTED',
      fallbackDetail ?? 'the release produced no pods',
      observed,
    )
  );
}

/**
 * `null` when nothing observed names a cause: at a deadline, no pods usually
 * means a platform stall. Checks run from least to most ambiguous evidence.
 */
export function evidence(
  observed: Observed,
  fallbackDetail?: string,
): Diagnosis | null {
  const { pods, events } = observed;
  const debug = { pods, events, secrets: observed.secrets };

  // Upstream of every pod symptom: a container cannot start on config the
  // platform never delivered, whatever the code would have done.
  for (const secret of observed.secrets) {
    const stall = undelivered(secret);
    if (stall !== null) return conclude('TARGET_UNREACHABLE', stall, debug);
  }

  const statuses = pods.flatMap((pod) => containerStatuses(pod));

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason !== undefined && ARTIFACT_WAITING.has(waiting.reason)) {
      return conclude(
        'ARTIFACT_UNAVAILABLE',
        waiting.message ?? waiting.reason,
        debug,
      );
    }
  }

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason !== undefined && STARTUP_WAITING.has(waiting.reason)) {
      return conclude(
        'STARTUP_FAILED',
        waiting.message ?? waiting.reason,
        debug,
      );
    }
    const terminated = status.state?.terminated;
    if (terminated !== undefined && (terminated.exitCode ?? 0) !== 0) {
      return conclude(
        'STARTUP_FAILED',
        terminated.message ??
          `container ${status.name ?? 'app'} exited with ${terminated.exitCode}`,
        debug,
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
      debug,
    );
  }

  if (
    statuses.length > 0 &&
    statuses.every((status) => status.ready !== true)
  ) {
    return conclude(
      'UNHEALTHY',
      fallbackDetail ?? 'the workload started but never became ready',
      debug,
    );
  }

  return null;
}

/** `null` once the ExternalSecret has synced its current generation. */
function undelivered(secret: KubernetesObject): string | null {
  const label = `ExternalSecret ${secret.metadata.namespace ?? ''}/${secret.metadata.name}`;
  const status = secret.status as
    | {
        conditions?: { type?: string; status?: string; message?: string }[];
        syncedResourceVersion?: string;
      }
    | undefined;
  const ready = status?.conditions?.find((entry) => entry.type === 'Ready');
  if (ready?.status !== 'True') {
    return `${label} has not delivered this Component's config${ready?.message === undefined ? '' : `: ${ready.message}`}`;
  }
  // ESO writes `<generation>-<hash>` once it has synced a generation.
  const generation = secret.metadata.generation;
  const synced = status?.syncedResourceVersion?.split('-', 1)[0];
  if (
    typeof generation === 'number' &&
    synced !== undefined &&
    synced !== String(generation)
  ) {
    return `${label} has not synced generation ${generation} of this Component's config`;
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
