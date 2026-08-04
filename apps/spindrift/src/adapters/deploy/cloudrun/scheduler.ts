/**
 * What fires a Cloud Run Job at the times its `schedule` names (§6, §7).
 *
 * A Cloud Run Job carries no cron expression: the resource has no field for
 * one, and `jobs.run` is a verb somebody has to call. So where the App chart
 * renders a CronJob and the cluster's own controller fires it, this backend
 * needs a **second service standing in front of the Job** — Cloud Scheduler,
 * calling `jobs.run` over HTTP on a cadence. That is the whole asymmetry, and
 * it is why a schedule is the one part of a job this adapter does not render
 * into the Job document.
 *
 * Written as pure functions beside `service.ts` and `job.ts` for the same
 * reason those are: **core describes, the adapter renders**, and a document a
 * test can assert whole is worth more than one only a fake can catch.
 *
 * **The two documents here are one idea.** The scheduler job says *when* and
 * *as whom*; the invoker policy says *whether that identity may*. Neither is
 * any use without the other — a schedule with no binding fires and is refused
 * `403` on every tick, and a binding with no schedule grants an invoke nobody
 * makes — so they are built in one place, from one argument, and asserted
 * together on every apply.
 */
import type { CloudRunAdapterConnection } from '../../../domain/target.ts';
import type { InvokerPolicy } from './service.ts';

/**
 * The time zone every schedule is read in.
 *
 * Stated rather than left to the platform, because the two backends have to
 * agree: a Kubernetes CronJob with no `timeZone` runs in the controller's, and
 * `packages/charts/spindrift-app/templates/cronjob.yaml` names none. UTC is
 * what that is in both clusters, and a Component whose "0 3 * * *" meant two
 * different hours depending on where it was placed would be a placement
 * decision quietly changing what the developer asked for.
 */
export const TIME_ZONE = 'UTC';

/**
 * The scope the fire's token carries.
 *
 * `jobs.run` is a Google API rather than a service of the developer's, so the
 * call authenticates with an **OAuth** token and not an OIDC one: OIDC is for
 * an endpoint that verifies an audience, and the Cloud Run control plane
 * verifies an IAM permission. The platform-wide scope is the only one that API
 * accepts; the narrowing that matters is done by the IAM policy below, which is
 * the thing that actually decides what this token may do.
 */
const RUN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** What a schedule needs that `DesiredState` does not carry. */
export interface SchedulerContext {
  /** Where the Job it fires is addressed — the Target's own API root. */
  readonly connection: CloudRunAdapterConnection;
  /** The Job's resource name, which is also this scheduler job's own. */
  readonly name: string;
  /** The identity the fire authenticates as. */
  readonly serviceAccount: string;
}

/**
 * One Cloud Scheduler job, ready to be created.
 *
 * **It shares the Job's resource name, deliberately.** Both APIs name a job
 * `projects/…/locations/…/jobs/…`, so the handle `apply` already hands core —
 * see `refOf` — is byte-for-byte the scheduler job's name at a different API
 * root. That is what lets `destroy` take the schedule with the Job while
 * holding nothing but a `DeployRef`: there is no second name to store, so there
 * is no second name to lose. The alternative — widening the ref to carry a
 * scheduler name — would have to be readable in every ref written before
 * schedules existed, and would buy a freedom nothing wants.
 *
 * **No `retryConfig`.** Cloud Scheduler's default is not to retry a failed
 * attempt but to wait for the next occurrence, which is what the chart's
 * `backoffLimit: 0` says on the other backend. Note what is being retried
 * either way: this is the `jobs.run` *call*, which returns as soon as the
 * execution is created — a container that exits non-zero has already succeeded
 * as far as the scheduler is concerned, and `maxRetries: 0` on the Job is what
 * decides that half.
 *
 * **No `body`.** `jobs.run` takes overrides it does not need; sending none is
 * how this fires the Job exactly as it was rendered.
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
 * Who may run this Job — the whole policy, as `:setIamPolicy` takes one (§9).
 *
 * A whole policy rather than a binding to add, for the same reason
 * `invokerPolicy` is one: the removal of a schedule has to be as expressible as
 * the grant. Passing `null` is a Component that declares no schedule, and it
 * writes an **empty** policy rather than skipping the call — the grant outlives
 * the schedule otherwise, leaving every workload in the vessel able to run a
 * Job nobody asked to be runnable.
 *
 * `roles/run.invoker` and no wider role: it carries `run.jobs.run` and nothing
 * that could change the Job. Bound **on the Job** rather than on the project,
 * so the identity that fires one Component's job cannot fire another's.
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
