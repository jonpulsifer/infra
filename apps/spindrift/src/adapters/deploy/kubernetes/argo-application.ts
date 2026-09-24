/** The Argo delivery flavour: an `Application` applied through the API. */
import type { FailureReason } from '../contract.ts';
import type { KubernetesObject } from './api.ts';
import { chartSourceKind, OCI_REPOSITORY } from './flux-helmrelease.ts';
import type { DeliveryStatus } from './status.ts';

export const APPLICATION = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  plural: 'applications',
} as const;

const OCI_SCHEME = 'oci://';

/** Argo's `repoURL` takes an OCI registry without its scheme. */
export function argoRepository(reference: string): string {
  return reference.startsWith(OCI_SCHEME)
    ? reference.slice(OCI_SCHEME.length)
    : reference;
}

/**
 * With no segment to split off, the repository is empty and matches no Target,
 * so the reference reads as an unmet `CHART_SOURCE`.
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

export interface ApplicationSpec {
  name: string;
  /** Where the `Application` object lives: Argo's own namespace. */
  namespace: string;
  /** The namespace the release's workloads run in. */
  destinationNamespace: string;
  /** The destination cluster, as Argo names it. */
  server: string;
  project: string;
  repoUrl: string;
  revision: string;
  /** The installation manifest's App chart reference. */
  chart: string;
  labels: Record<string, string>;
  values: Record<string, unknown>;
  /**
   * Admission labels Argo puts on the namespace it creates. Empty leaves
   * `CreateNamespace` off, so no namespace is created without them.
   */
  namespaceMetadata: Record<string, string>;
}

/**
 * The managed namespace gets no tracking annotation: with one, a sync could
 * delete the namespace and every workload in it.
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
        // Argo refuses a source that sets both `chart` and `path`.
        ...(chartSourceKind(spec.chart) === OCI_REPOSITORY
          ? { chart: argoChartRef(spec.chart).chart }
          : { path: spec.chart }),
        helm: {
          releaseName: spec.name,
          // Argo has no values ConfigMap, so values go inline.
          valuesObject: spec.values,
        },
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        // With no labels, `CreateNamespace` makes an unprotected namespace.
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

/** Conditions that name a cause without reading pods. `Degraded` does not. */
const CONDITION_REASONS: Record<string, FailureReason> = {
  ComparisonError: 'REJECTED',
  InvalidSpecError: 'REJECTED',
  SyncError: 'REJECTED',
  UnknownError: 'INTERNAL',
};

export function applicationStatus(object: KubernetesObject): DeliveryStatus {
  const status = object.status as ApplicationStatus | undefined;

  // Argo has the object but has not synced it yet.
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
      // Terminal and silent about the cause, so the adapter reads pods.
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

export function applicationValues(
  object: KubernetesObject,
): Record<string, unknown> {
  const spec = object.spec as
    | { source?: { helm?: { valuesObject?: Record<string, unknown> } } }
    | undefined;
  return spec?.source?.helm?.valuesObject ?? {};
}
