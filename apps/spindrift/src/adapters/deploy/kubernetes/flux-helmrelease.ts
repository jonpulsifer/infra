/**
 * The Flux delivery flavour: a `HelmRelease`, applied through the API (§6).
 *
 * "The GitOps operator *is* the pluggable machinery, so Spindrift applies a
 * `HelmRelease` or an Argo `Application` **through the API** — using Flux or
 * Argo is not the same as writing manifests to git, and only the chart source
 * lives in a repo." Nothing here writes to a repository, and nothing here
 * reimplements what the controller does: this module renders one object and
 * reads one status.
 *
 * **The chart is sourced from the Target's own repository**, not from OCI. That
 * is the plan's deliberate deviation from §7 for v1, and its whole cost is
 * stated where the prerequisite is checked: a Target without that repository is
 * a non-candidate, and it is the first thing that breaks on extraction.
 */
import type { FailureReason } from '../contract.ts';
import type { KubernetesObject } from './api.ts';
import type { DeliveryStatus } from './status.ts';

/** The API this flavour writes. */
export const HELM_RELEASE = {
  apiVersion: 'helm.toolkit.fluxcd.io/v2',
  kind: 'HelmRelease',
  plural: 'helmreleases',
} as const;

/** The source object a `HelmRelease` fetches its chart from. */
export const GIT_REPOSITORY = {
  apiVersion: 'source.toolkit.fluxcd.io/v1',
  kind: 'GitRepository',
  plural: 'gitrepositories',
} as const;

/** What rendering one `HelmRelease` needs beyond the values themselves. */
export interface HelmReleaseSpec {
  /** Object name — one per (Component, Target), so a re-deploy is an upgrade. */
  name: string;
  /** Namespace the `HelmRelease` object lives in. */
  namespace: string;
  /** Namespace the release's workloads land in. */
  targetNamespace: string;
  /** The chart's path inside the source repository (§20's manifest value). */
  chart: string;
  sourceRef: { name: string; namespace: string };
  /** Labels every object this adapter writes carries. */
  labels: Record<string, string>;
  /** §7: "Spindrift writes one inline values blob." */
  values: Record<string, unknown>;
}

/**
 * Render the object.
 *
 * `remediation.retries: 0` is the load-bearing setting: §6 puts reconciliation
 * in core, and a controller that retried an install on its own would produce
 * phase transitions no Deploy row asked for — the timeline would then be
 * telling the developer about attempts nobody made.
 */
export function helmRelease(spec: HelmReleaseSpec): KubernetesObject {
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
      // The release namespace is vessel (§7), so the controller must not be
      // the thing that creates it — a `destroy()` that removed a namespace
      // would take every other Component in it along.
      storageNamespace: spec.targetNamespace,
      chart: {
        spec: {
          chart: spec.chart,
          reconcileStrategy: 'Revision',
          sourceRef: {
            kind: GIT_REPOSITORY.kind,
            name: spec.sourceRef.name,
            namespace: spec.sourceRef.namespace,
          },
        },
      },
      install: { remediation: { retries: 0 } },
      upgrade: { remediation: { retries: 0 } },
      values: spec.values,
    },
  };
}

/** One condition, as Flux writes it. */
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
 * Flux's own reasons, mapped onto §6's shared vocabulary.
 *
 * Only the reasons that are *decidable from the HelmRelease alone* are here.
 * An install that failed because the workload never became ready is not one of
 * them: the object says `InstallFailed` either way, and telling a crash loop
 * from an image that will not pull needs the read on red (§6) — so those map to
 * `null` and the adapter goes and looks.
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

/**
 * What the object says is happening.
 *
 * Phase transitions come from the controller, never from Spindrift
 * reimplementing readiness (§6). This function is that rule as code: every
 * branch reads a condition Flux wrote.
 */
export function helmReleaseStatus(object: KubernetesObject): DeliveryStatus {
  const ready = condition(object, 'Ready');
  const generation = (object.metadata as { generation?: number }).generation;
  const observed = (
    object.status as { observedGeneration?: number } | undefined
  )?.observedGeneration;

  // The controller has not looked at this generation yet, whatever the last
  // one said. Reporting the stale condition here is how a re-deploy of a
  // broken release would come back green before anything was tried.
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
    // An absent reason is the signal to read pods and events once (§6), not a
    // reason to guess: the adapter fills it in from what it finds.
    reason,
    detail: ready.message,
    debug: { conditions: conditions(object) },
  };
}

/** The values the release was applied with, as the object still carries them. */
export function helmReleaseValues(
  object: KubernetesObject,
): Record<string, unknown> {
  const spec = object.spec as { values?: Record<string, unknown> } | undefined;
  return spec?.values ?? {};
}
