/**
 * `DesiredState` rendered as one Cloud Run Job document. A Job carries no
 * cadence: a schedule is a separate Cloud Scheduler job the adapter applies.
 */
import type { DesiredState } from '../../../domain/desired-state.ts';
import {
  type CloudRunRenderContext,
  workloadContainer,
  workloadLabels,
} from './service.ts';

/** The runtime defaults to 3 retries; 0 matches the chart's `backoffLimit`. */
const MAX_RETRIES = 0;

/**
 * The Deploy id goes on the execution template, so a task traces back to its
 * Deploy. `parallelism` and `taskCount` keep the runtime's defaults.
 */
export function cloudRunJob(
  desired: DesiredState,
  context: CloudRunRenderContext,
): Record<string, unknown> {
  const labels = workloadLabels(desired);

  return {
    labels,
    ...(context.useProjectAdmissionPolicy
      ? { binaryAuthorization: { useDefault: true } }
      : {}),
    template: {
      labels: { ...labels, 'spindrift-deploy': desired.deploy },
      // A Job nests twice where a Service nests once: the containers live in
      // the inner `TaskTemplate`.
      template: {
        ...(context.serviceAccount === null
          ? {}
          : { serviceAccount: context.serviceAccount }),
        containers: [workloadContainer(desired, context)],
        maxRetries: MAX_RETRIES,
      },
    },
  };
}
