/**
 * The in-cluster build route: runs the shared BuildKit program as a Job on a
 * cluster this process reaches. It is SLSA L1, so a Target requiring L2 refuses it.
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import {
  KubernetesApi,
  type KubernetesObject,
} from '../deploy/kubernetes/api.ts';
import {
  buildKitProgramFor,
  buildSecretEnvOf,
  dockerConfigFor,
  REGISTRY_AUTH_VAR,
} from './buildkit.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildHandle,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import type { BuildRouteDescriptor } from './descriptor.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  DEFAULT_BUILD_TIMEOUT_MS,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

export interface InClusterRouteOptions extends PollingOptions {
  readonly name: string;
  readonly api: KubernetesApi;
  /** Where the Job runs. The route never creates the namespace. */
  readonly namespace: string;
  /** A rootless BuildKit image, which the pod security context in `job` requires. */
  readonly image: string;
  readonly zeroConfigFrontend: string;
  /**
   * The Job's service account. The registry trusts its projected token, so this
   * process holds no registry credential.
   */
  readonly serviceAccount: string;
  readonly id?: () => string;
}

/** How long a finished Job and its pod log remain; the attempt log keeps the copy. */
export const JOB_TTL_SECONDS = 3600;

/** The label a build Job carries so its pod can be found. */
export const JOB_LABEL = 'spindrift.dev/build';

/** How a Job ended: a verdict, the cluster's deadline, or a delete. */
type JobOutcome = 'succeeded' | 'failed' | 'deadline' | 'gone';

/** One name from one token, so `build` and `cancel` cannot disagree on it. */
function jobNameFor(id: string): string {
  return `spindrift-build-${id}`;
}

export class InClusterBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'LIVE_TEXT';
  readonly buildLevel: BuildLevel = 1;
  readonly provenanceBuilderId = 'https://spindrift.dev/builders/in-cluster';
  /** Secrets ride the Job's container environment; see the ponytail on `job`. */
  readonly carriesHeldSecret = true;
  /** The service account reaches one vendor's registries through workload identity. */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [
    'artifactRegistry',
  ];

  constructor(private readonly options: InClusterRouteOptions) {
    this.name = options.name;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;
    const { api, namespace } = this.options;

    // Named by the dispatch id so `cancel` can address the Job from the Build row.
    const id =
      dispatchId ??
      (this.options.id ?? (() => crypto.randomUUID().slice(0, 8)))();
    const name = jobNameFor(id);
    const job = this.job(
      name,
      buildKitProgramFor(source, spec, this.options.zeroConfigFrontend),
      dockerConfigFor(spec.registryAuth),
      buildSecretEnvOf(spec.buildSecrets),
    );

    try {
      await api.apply(job, 'jobs');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield {
        type: 'log',
        at: now(),
        line: `could not create the build Job: ${detail}`,
      };
      return buildFailed(
        logs,
        'TARGET_UNREACHABLE',
        `could not create Job ${name} in ${namespace}: ${detail}`,
        { job: name },
      );
    }

    yield {
      type: 'log',
      at: now(),
      line: `Job ${name} created in ${namespace}`,
    };

    const budget = deadlineFrom(this.options);
    let delivered = 0;
    let log = '';
    let outcome: JobOutcome | null = null;

    for (;;) {
      log = (await this.readLog(name)) ?? log;
      // Only new lines: the API serves the full log on every read.
      const lines = log.split('\n');
      for (const line of lines.slice(delivered)) {
        if (line.trim() === '') continue;
        yield { type: 'log', at: now(), line, step: name };
      }
      delivered = lines.length;

      outcome = await this.outcome(name);
      if (outcome !== null) break;

      if (budget.expired()) {
        // `activeDeadlineSeconds` carries the same budget, so the cluster usually
        // ends the Job first; deleting it here frees the node when it did not.
        yield {
          type: 'log',
          at: now(),
          line: `Job ${name} did not finish within the build budget; deleting it`,
        };
        await this.kill(name).catch(() => {});
        return buildFailed(
          logs,
          'TIMEOUT',
          `Job ${name} did not finish within the build budget`,
          { job: name },
        );
      }
      await budget.tick();
    }

    // One last read: what the pod wrote after the previous poll says why it failed.
    log = (await this.readLog(name)) ?? log;
    for (const line of log.split('\n').slice(delivered)) {
      if (line.trim() === '') continue;
      yield { type: 'log', at: now(), line, step: name };
    }

    if (outcome === 'failed') {
      return buildFailed(logs, 'BUILD_FAILED', `Job ${name} failed`, {
        job: name,
      });
    }
    if (outcome !== 'succeeded') {
      // Ended by the cluster's deadline or a delete. `TIMEOUT` blames nobody.
      const ending =
        outcome === 'deadline'
          ? `Job ${name} was ended by the cluster for exceeding its deadline`
          : `Job ${name} was deleted before it finished`;
      yield { type: 'log', at: now(), line: ending };
      return buildFailed(logs, 'TIMEOUT', ending, { job: name });
    }

    const report = parseBuildReport(log);
    if (report === null) {
      return buildFailed(
        logs,
        'INTERNAL',
        `Job ${name} succeeded but reported no artifact`,
        { job: name },
      );
    }

    return buildSucceeded({
      source,
      spec,
      logs,
      level: this.buildLevel,
      // L1 provenance: what ran and where.
      report: { ...report, statement: { job: name, namespace } },
    });
  }

  /** Delete the Job named by the dispatch id, and the pod under it. */
  cancel(handle: BuildHandle): Promise<void> {
    return this.kill(jobNameFor(handle.dispatchId));
  }

  /**
   * ponytail: secrets ride plain container env, readable with `get jobs` in the
   * build namespace until the TTL. Upgrade path: a Job-owned Secret as a volume.
   */
  private job(
    name: string,
    program: string,
    dockerConfig: string | null,
    buildSecretEnv: Record<string, string>,
  ): KubernetesObject {
    const env = [
      ...(dockerConfig === null
        ? []
        : [{ name: REGISTRY_AUTH_VAR, value: dockerConfig }]),
      ...Object.entries(buildSecretEnv).map(([name, value]) => ({
        name,
        value,
      })),
    ];
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: this.options.namespace,
        labels: { [JOB_LABEL]: name },
      },
      spec: {
        // Retries are core's call; a retried Job would push a second artifact.
        backoffLimit: 0,
        // The cluster enforces the build budget even when this process is gone.
        activeDeadlineSeconds: Math.ceil(
          (this.options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS) / 1000,
        ),
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        template: {
          metadata: { labels: { [JOB_LABEL]: name } },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: this.options.serviceAccount,
            // The strictest context BuildKit runs under, admissible at Pod Security
            // `baseline`, so `image` must be a rootless BuildKit.
            // ponytail: `RuntimeDefault` seccomp, since `baseline` forbids `Unconfined`.
            // If `unshare` fails, lower the namespace's level and use `Unconfined`.
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'build',
                image: this.options.image,
                command: ['sh', '-c', program],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                // Omitted when nothing is held, leaving no trace on the Job.
                ...(env.length === 0 ? {} : { env }),
              },
            ],
          },
        },
      },
    };
  }

  /** Whether the Job is over, and how. `null` while it is still going. */
  private async outcome(name: string): Promise<JobOutcome | null> {
    const job = await this.options.api.get({
      apiVersion: 'batch/v1',
      plural: 'jobs',
      namespace: this.options.namespace,
      name,
    });
    // Deleted mid-build, by `cancel` or an operator.
    if (job === null) return 'gone';

    const status = (job.status ?? {}) as {
      succeeded?: number;
      failed?: number;
      conditions?: readonly { type: string; status: string; reason?: string }[];
    };
    if ((status.succeeded ?? 0) > 0) return 'succeeded';
    // Before the failed count: the controller deletes the pod it ends, so a
    // Job past its deadline may carry the condition and no failed pod at all.
    if (
      (status.conditions ?? []).some(
        (condition) =>
          condition.type === 'Failed' &&
          condition.status === 'True' &&
          condition.reason === 'DeadlineExceeded',
      )
    ) {
      return 'deadline';
    }
    if ((status.failed ?? 0) > 0) return 'failed';
    return null;
  }

  /** Background propagation, or the pod keeps building under a deleted Job. */
  private kill(name: string): Promise<void> {
    return this.options.api.delete(
      {
        apiVersion: 'batch/v1',
        plural: 'jobs',
        namespace: this.options.namespace,
        name,
      },
      { propagation: 'Background' },
    );
  }

  /** The build pod's log, or `null` while there is no pod or no output yet. */
  private async readLog(name: string): Promise<string | null> {
    const pods = await this.options.api.list(
      {
        apiVersion: 'v1',
        plural: 'pods',
        namespace: this.options.namespace,
      },
      { labelSelector: `${JOB_LABEL}=${name}` },
    );
    const pod = pods?.[0]?.metadata.name;
    if (pod === undefined) return null;
    return this.options.api.logs(this.options.namespace, pod, {
      container: 'build',
    });
  }
}

import { inClusterConfigSchema } from '../../config/build-route-schemas.ts';

export const inClusterDescriptor = {
  kind: 'in-cluster',
  displayName: 'in-cluster',
  logo: 'kubernetes',
  buildLevel: 1,
  configSchema: inClusterConfigSchema,
  create(config, context) {
    if (!context.token) return null;
    return new InClusterBuildRoute({
      name: config.name,
      api: new KubernetesApi({
        apiServer: config.endpoint,
        token: context.token,
        ...(context.fetch ? { fetch: context.fetch } : {}),
      }),
      namespace: config.namespace,
      image: config.image,
      serviceAccount: config.serviceAccount,
      zeroConfigFrontend: context.manifest.build.zeroConfigFrontend,
    });
  },
} satisfies BuildRouteDescriptor;
