/**
 * The Argo delivery flavour: an `Application`, applied through the API (§6).
 *
 * The same shape as the Flux flavour and for the same reason — the Target
 * declares which operator drives it, and Spindrift writes that operator's own
 * object rather than manifests to a repository. What differs is only how the
 * object is spelled and where its verdict is written, which is why both
 * flavours end at {@link DeliveryStatus} and nothing above them branches.
 *
 * **The chart reference decides the shape of the source**, the same way it does
 * on the Flux side and through the same `chartSourceKind`. Argo takes an OCI
 * chart the way Helm's own client does — the registry in `repoURL`, the chart's
 * own name in `chart` — and refuses a source carrying a `path` beside it, so an
 * artifact reference written into `path` is an Application Argo answers with
 * `ComparisonError` rather than a release.
 */
import type { FailureReason } from '../contract.ts';
import type { KubernetesObject } from './api.ts';
import { chartSourceKind, OCI_REPOSITORY } from './flux-helmrelease.ts';
import type { DeliveryStatus } from './status.ts';

/** The API this flavour writes. */
export const APPLICATION = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  plural: 'applications',
} as const;

const OCI_SCHEME = 'oci://';

/**
 * A repository as Argo takes it, however the reference spelled it.
 *
 * Argo's own documentation is explicit that for an OCI chart "the `oci://`
 * syntax is not included" in `repoURL`, so the scheme comes off here rather
 * than at each of the two call sites that would otherwise have to remember.
 */
export function argoRepository(reference: string): string {
  return reference.startsWith(OCI_SCHEME)
    ? reference.slice(OCI_SCHEME.length)
    : reference;
}

/**
 * Where an `oci://` chart reference splits into Argo's two fields.
 *
 * The last segment is the chart's own name and everything before it is the
 * repository. A reference with no segment to split off keeps an empty
 * repository, which no Target can match — nonsense configuration reads as an
 * unmet `CHART_SOURCE` rather than as an Application pointed at a registry
 * nobody named.
 */
export function argoChartRef(chart: string): {
  readonly repository: string;
  readonly chart: string;
} {
  const reference = argoRepository(chart);
  const at = reference.lastIndexOf('/');
  return at === -1
    ? { repository: '', chart: reference }
    : { repository: reference.slice(0, at), chart: reference.slice(at + 1) };
}

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
  /** How this installation names the App chart (§20's manifest value). */
  chart: string;
  labels: Record<string, string>;
  values: Record<string, unknown>;
  /**
   * The admission labels the destination namespace must carry, which Argo puts
   * there itself. Empty leaves `CreateNamespace` off, so a namespace is never
   * created without them.
   */
  namespaceMetadata: Record<string, string>;
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
 * `CreateNamespace` is set, with the destination namespace's admission labels
 * in `managedNamespaceMetadata` (113). This is the flavour where the delivery
 * mechanism can carry them — Flux's `createNamespace` takes no metadata at all
 * — so on Argo the namespace arrives through Argo's own authority and
 * Spindrift writes no `Namespace` object.
 *
 * **No tracking annotation goes in that metadata**, deliberately. Argo does not
 * track a namespace it creates unless one is added, and adding it would let a
 * sync delete the namespace — every neighbouring workload in it included. That
 * matches what Flux does on the other flavour, so a namespace outlives its
 * App's last placement on both, and removing one stays an operator's act.
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
        repoURL: argoRepository(spec.repoUrl),
        targetRevision: spec.revision,
        // The same split Flux makes, in Argo's spelling: a path is a directory
        // only a checkout of the repository resolves, a chart is an artifact
        // the registry serves under its own name. Argo refuses a source that
        // carries both, so the reference picks one and never states the other.
        ...(chartSourceKind(spec.chart) === OCI_REPOSITORY
          ? { chart: argoChartRef(spec.chart).chart }
          : { path: spec.chart }),
        helm: {
          releaseName: spec.name,
          // Argo's inline values, which is the same single blob §7 requires:
          // a values ConfigMap has no Argo equivalent at all.
          valuesObject: spec.values,
        },
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        // Guarded on the labels being there: a `CreateNamespace` with nothing
        // to put on the namespace would create an unprotected one, which is
        // the failure mode this whole arm exists to avoid.
        ...(Object.keys(spec.namespaceMetadata).length === 0
          ? {}
          : {
              syncOptions: ['CreateNamespace=true'],
              managedNamespaceMetadata: { labels: spec.namespaceMetadata },
            }),
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
