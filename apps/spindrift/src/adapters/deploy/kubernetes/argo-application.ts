/**
 * The Argo delivery flavour: an `Application`, applied through the API (§6).
 *
 * The same shape as the Flux flavour and for the same reason — the Target
 * declares which operator drives it, and Spindrift writes that operator's own
 * object rather than manifests to a repository. What differs is only how the
 * object is spelled and where its verdict is written, which is why both
 * flavours end at {@link DeliveryStatus} and nothing above them branches.
 */
import type { FailureReason } from '../contract.ts';
import type { KubernetesObject } from './api.ts';
import type { DeliveryStatus } from './status.ts';

/** The API this flavour writes. */
export const APPLICATION = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  plural: 'applications',
} as const;

/** What rendering one `Application` needs beyond the values themselves. */
export interface ApplicationSpec {
  name: string;
  /** Namespace the `Application` object lives in — Argo's own. */
  namespace: string;
  /** Namespace the release's workloads land in. */
  destinationNamespace: string;
  /** The cluster, in Argo's vocabulary. */
  server: string;
  project: string;
  repoUrl: string;
  revision: string;
  /** The chart's path inside the repository (§20's manifest value). */
  path: string;
  labels: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * Render the object.
 *
 * `syncPolicy.automated.selfHeal` is on because §6 requires every backend to
 * self-heal *below* the seam — "an adapter never holds a workload up". `prune`
 * is on for the same reason a `HelmRelease` upgrade removes what it no longer
 * renders: an object the chart stopped producing is not something a later
 * deploy should have to know about.
 *
 * `CreateNamespace` is deliberately **not** set: the namespace is vessel (§7),
 * and a sync that created it would make `destroy()` able to remove it.
 */
export function argoApplication(spec: ApplicationSpec): KubernetesObject {
  return {
    apiVersion: APPLICATION.apiVersion,
    kind: APPLICATION.kind,
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: spec.labels,
    },
    spec: {
      project: spec.project,
      destination: {
        server: spec.server,
        namespace: spec.destinationNamespace,
      },
      source: {
        repoURL: spec.repoUrl,
        targetRevision: spec.revision,
        path: spec.path,
        helm: {
          releaseName: spec.name,
          // Argo's inline values, which is the same single blob §7 requires:
          // a values ConfigMap has no Argo equivalent at all.
          valuesObject: spec.values,
        },
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
      },
    },
  };
}

interface ApplicationStatus {
  sync?: { status?: string };
  health?: { status?: string; message?: string };
  operationState?: { phase?: string; message?: string };
  conditions?: { type?: string; message?: string }[];
}

/**
 * Argo's condition types that are decidable without looking at pods.
 *
 * A `Degraded` health is not among them — it says a workload is unhealthy and
 * not why — so it maps to no reason and the adapter goes and reads (§6).
 */
const CONDITION_REASONS: Record<string, FailureReason> = {
  ComparisonError: 'REJECTED',
  InvalidSpecError: 'REJECTED',
  SyncError: 'REJECTED',
  UnknownError: 'INTERNAL',
};

/** What the object says is happening, in §6's vocabulary. */
export function applicationStatus(object: KubernetesObject): DeliveryStatus {
  const status = object.status as ApplicationStatus | undefined;

  // Nothing has been written yet: Argo has the object but has not synced it.
  if (status === undefined || status.health?.status === undefined) {
    return { phase: 'APPLYING' };
  }

  const failing = (status.conditions ?? []).find(
    (condition) =>
      condition.type !== undefined &&
      CONDITION_REASONS[condition.type] !== undefined,
  );
  if (failing !== undefined) {
    return {
      phase: 'FAILED',
      reason: CONDITION_REASONS[failing.type as string],
      detail: failing.message,
      debug: { conditions: status.conditions },
    };
  }

  const operation = status.operationState?.phase;
  if (operation === 'Failed' || operation === 'Error') {
    return {
      phase: 'FAILED',
      detail: status.operationState?.message,
      debug: { operationState: status.operationState },
    };
  }

  switch (status.health.status) {
    case 'Healthy':
      return status.sync?.status === 'Synced'
        ? { phase: 'LIVE', detail: status.health.message }
        : { phase: 'WAITING', detail: status.health.message };
    case 'Degraded':
      // Degraded is terminal for the attempt and silent about the cause, which
      // is precisely the read-on-red case.
      return {
        phase: 'FAILED',
        detail: status.health.message,
        debug: { health: status.health },
      };
    case 'Missing':
    case 'Progressing':
    case 'Suspended':
      return { phase: 'WAITING', detail: status.health.message };
    default:
      return { phase: 'WAITING', detail: status.health.message };
  }
}

/** The values the Application was applied with, as it still carries them. */
export function applicationValues(
  object: KubernetesObject,
): Record<string, unknown> {
  const spec = object.spec as
    | { source?: { helm?: { valuesObject?: Record<string, unknown> } } }
    | undefined;
  return spec?.source?.helm?.valuesObject ?? {};
}
