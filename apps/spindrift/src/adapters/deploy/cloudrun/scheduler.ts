/**
 * The Cloud Scheduler job that fires a Cloud Run Job on its `schedule`, and
 * the Job's invoker policy. Neither works without the other, so both come
 * from one argument and are asserted together on every apply.
 */
import type { CloudRunAdapterConnection } from '../../../domain/target.ts';
import type { InvokerPolicy } from './service.ts';

/**
 * The chart's CronJob names no `timeZone` and runs in the controller's, UTC,
 * so a cron expression means the same hour on both backends.
 */
export const TIME_ZONE = 'UTC';

/**
 * An OAuth token, not OIDC: `jobs.run` is a Google API that checks IAM, not an
 * audience, and accepts only this scope. The IAM policy is what narrows it.
 */
const RUN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface SchedulerContext {
  /** Its `endpoint` must already be resolved: it goes into the fired URL. */
  readonly connection: CloudRunAdapterConnection;
  /** The Job's resource name, which is also this scheduler job's own. */
  readonly name: string;
  /** The identity the fire authenticates as. */
  readonly serviceAccount: string;
}

/**
 * Named like the Job, so a `DeployRef` locates both. No `retryConfig`: a
 * failed fire waits for the next occurrence. No `body`: the Job runs as
 * rendered.
 */
export function cloudSchedulerJob(
  schedule: string,
  context: SchedulerContext,
): Record<string, unknown> {
  return {
    name: context.name,
    schedule,
    timeZone: TIME_ZONE,
    httpTarget: {
      uri: `${context.connection.endpoint}/v2/${context.name}:run`,
      httpMethod: 'POST',
      oauthToken: {
        serviceAccountEmail: context.serviceAccount,
        scope: RUN_SCOPE,
      },
    },
  };
}

/**
 * `null` writes an empty policy, so a grant never outlives its schedule. Bound
 * on the Job, never the project, so one Component's identity cannot fire
 * another's job.
 */
export function jobInvokerPolicy(serviceAccount: string | null): InvokerPolicy {
  return {
    policy: {
      bindings:
        serviceAccount === null
          ? []
          : [
              {
                role: 'roles/run.invoker',
                members: [`serviceAccount:${serviceAccount}`],
              },
            ],
    },
  };
}
