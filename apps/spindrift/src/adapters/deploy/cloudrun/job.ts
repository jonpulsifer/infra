/**
 * `DesiredState` rendered as one Cloud Run Job (§6).
 *
 * Written the same way as its neighbour and for the same reason: **core
 * describes, the adapter renders**, and a pure function returning a plain
 * object is a document a test can assert whole without a fake API standing by.
 *
 * **What a job on this backend is.** A Job resource that exists and is triggered
 * by nothing. That is the exact analogue of the Kubernetes side, where
 * `packages/charts/spindrift-app/templates/cronjob.yaml` renders a CronJob with
 * `suspend: true` and a date that never occurs for an unscheduled job — the
 * object has to exist for anything to have something to trigger. Cloud Run
 * reaches the same state by having no scheduler in front of it, because a Job
 * carries no schedule of its own: firing one is a separate service (**72**) and
 * running one on demand is a `DeployAdapter` verb that does not exist (**73**).
 *
 * **The template nests twice.** `Job.template` is an `ExecutionTemplate` and
 * `ExecutionTemplate.template` is a `TaskTemplate`; the containers live in the
 * inner one. A Service nests once, so pointing the Service's shape at a Job
 * yields `Unknown name "template.containers"` — an error that reads like a
 * field-name problem and is a nesting problem. `test/harness/fakes/cloudrun-api.ts`
 * holds the closed Job schema that makes that mistake fail here rather than in
 * a vessel.
 *
 * **Nothing Service-only is rendered.** `ingress`, `containerPort` and the
 * invoker policy are all answers to "who may reach this", and a Job is reached
 * by nobody: the resource has no `ingress` member and nothing routes to it. So
 * a job's `reach` is `none`, which
 * `ASSERTED_REACHES_BY_ADAPTER.cloudrun` already serves, and the chart says the
 * same thing one layer over — `spindrift-app.serving` is "a job is the only
 * workload branch and never serves".
 */
import type { DesiredState } from '../../../domain/desired-state.ts';
import {
  type CloudRunRenderContext,
  workloadContainer,
  workloadLabels,
} from './service.ts';

/**
 * How many times the runtime retries a task that exits non-zero.
 *
 * Zero, matching the chart's `backoffLimit: 0` on the same Component's CronJob.
 * The runtime's own default is 3, so leaving this out would mean the same App
 * retries three times on one backend and not at all on the other — a difference
 * a developer would meet as their job having run four times.
 */
const MAX_RETRIES = 0;

/**
 * One Job document, ready to be applied.
 *
 * The `labels` are the Service's three, for the reason given where they are
 * built. The Deploy id goes on the **execution template** rather than on the
 * Job, mirroring where it goes on a Service: it changes every deploy, so it
 * belongs on the thing that is created anew each time an execution runs, which
 * is what lets a task be traced back to the Deploy that placed it.
 *
 * `binaryAuthorization` is carried on exactly the same condition as a Service's.
 * The vessel's `run.allowedBinaryAuthorizationPolicies` constraint
 * (`terraform/gcp/projects/bluenose/policy.tf`) allows `is:default` and nothing
 * else, "so a deployer cannot opt a service out of verification" — and Cloud
 * Run applies that constraint to Jobs as well as to Services. A Job that named
 * no policy would be a Job with none, which is what the constraint exists to
 * refuse. Declaring it is how this Deploy submits to the check (§16's second
 * verifier), not how it escapes one.
 *
 * `parallelism` and `taskCount` are absent rather than set to 1: those are the
 * runtime's own defaults, and a value invented here would be core deciding a
 * workload's shape — the scheduler §3 says placement is not.
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
