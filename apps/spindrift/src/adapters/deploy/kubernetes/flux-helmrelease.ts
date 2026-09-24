/** The Flux delivery flavour: a `HelmRelease` applied through the API. */
import type { FailureReason } from '../contract.ts';
import type { KubernetesObject } from './api.ts';
import type { DeliveryStatus } from './status.ts';

export const HELM_RELEASE = {
  apiVersion: 'helm.toolkit.fluxcd.io/v2',
  kind: 'HelmRelease',
  plural: 'helmreleases',
} as const;

export const GIT_REPOSITORY = {
  apiVersion: 'source.toolkit.fluxcd.io/v1',
  kind: 'GitRepository',
  plural: 'gitrepositories',
} as const;

export const OCI_REPOSITORY = {
  apiVersion: 'source.toolkit.fluxcd.io/v1',
  kind: 'OCIRepository',
  plural: 'ocirepositories',
} as const;

export function chartSourceKind(
  chart: string,
): typeof GIT_REPOSITORY | typeof OCI_REPOSITORY {
  return chart.startsWith('oci://') ? OCI_REPOSITORY : GIT_REPOSITORY;
}

export interface HelmReleaseSpec {
  /** One per Component and Target, so a re-deploy is an upgrade. */
  name: string;
  /** Where the `HelmRelease` object lives. */
  namespace: string;
  /** The namespace the release's workloads run in. */
  targetNamespace: string;
  /** The installation manifest's App chart reference. */
  chart: string;
  /** Its kind follows from `chart`. */
  sourceRef: { name: string; namespace: string };
  labels: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * `retries: 0` because core owns reconciliation: controller retries would put
 * attempts nobody asked for on the timeline.
 */
export function helmRelease(spec: HelmReleaseSpec): KubernetesObject {
  const source = chartSourceKind(spec.chart);
  const sourceRef = {
    kind: source.kind,
    name: spec.sourceRef.name,
    namespace: spec.sourceRef.namespace,
  };
  return {
    apiVersion: HELM_RELEASE.apiVersion,
    kind: HELM_RELEASE.kind,
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: spec.labels,
    },
    spec: {
      interval: '10m',
      releaseName: spec.name,
      targetNamespace: spec.targetNamespace,
      // No `install.createNamespace`: it takes no labels, so the adapter
      // creates the namespace.
      storageNamespace: spec.targetNamespace,
      // Flux refuses both forms at once, and `chart.spec.sourceRef` cannot name
      // an `OCIRepository`. On a switch, server-side apply prunes the old form.
      ...(source === OCI_REPOSITORY
        ? { chartRef: sourceRef }
        : {
            chart: {
              spec: {
                chart: spec.chart,
                reconcileStrategy: 'Revision',
                sourceRef,
              },
            },
          }),
      install: { remediation: { retries: 0 } },
      upgrade: { remediation: { retries: 0 } },
      values: spec.values,
    },
  };
}

interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
}

function conditions(object: KubernetesObject): Condition[] {
  const status = object.status as { conditions?: Condition[] } | undefined;
  return status?.conditions ?? [];
}

function condition(object: KubernetesObject, type: string): Condition | null {
  return conditions(object).find((entry) => entry.type === type) ?? null;
}

/**
 * Only reasons decidable from the `HelmRelease` alone. `InstallFailed` needs
 * pods to tell a crash loop from a failed pull, so it is absent.
 */
const REASONS: Record<string, FailureReason> = {
  ArtifactFailed: 'ARTIFACT_UNAVAILABLE',
  ChartPullFailed: 'ARTIFACT_UNAVAILABLE',
  SourceNotReady: 'ARTIFACT_UNAVAILABLE',
  DependencyNotReady: 'ARTIFACT_UNAVAILABLE',
  InvalidChartReference: 'ARTIFACT_UNAVAILABLE',
  ValuesError: 'REJECTED',
  InvalidSpec: 'REJECTED',
  ReconciliationFailed: 'REJECTED',
};

export function helmReleaseStatus(object: KubernetesObject): DeliveryStatus {
  const ready = condition(object, 'Ready');
  const generation = (object.metadata as { generation?: number }).generation;
  const observed = (
    object.status as { observedGeneration?: number } | undefined
  )?.observedGeneration;

  // Flux has not observed this generation, and its stale `Ready` would show
  // a broken re-deploy green before anything was tried.
  if (ready === null || (generation !== undefined && observed !== generation)) {
    return { phase: 'APPLYING', detail: ready?.message };
  }

  if (ready.status === 'True') {
    return { phase: 'LIVE', detail: ready.message };
  }

  const stalled = condition(object, 'Stalled');
  const terminal =
    stalled?.status === 'True' || ready.reason === 'RetriesExceeded';
  if (!terminal) {
    return { phase: 'WAITING', detail: ready.message };
  }

  const reason = ready.reason === undefined ? undefined : REASONS[ready.reason];
  return {
    phase: 'FAILED',
    reason,
    detail: ready.message,
    debug: { conditions: conditions(object) },
  };
}

export function helmReleaseValues(
  object: KubernetesObject,
): Record<string, unknown> {
  const spec = object.spec as { values?: Record<string, unknown> } | undefined;
  return spec?.values ?? {};
}
