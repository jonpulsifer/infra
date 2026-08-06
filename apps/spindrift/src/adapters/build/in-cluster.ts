/**
 * The in-cluster build route (§4).
 *
 * §4 puts this route on a knife edge and then justifies it: "**the home cluster
 * never pushes across its uplink** — a geography constraint, not a capability
 * one — but a build that never crosses it is untouched by that rule, which is
 * what makes `in-cluster` legitimate." So this route exists for the cluster that
 * sits beside its own registry, and for the installation that has no cloud at
 * all — which is the case §20's extraction contract has to keep possible.
 *
 * **It is SLSA Build Level 1, and that is the whole of its cost.** A Job on a
 * cluster the App is also deployed to has no isolation claim worth making: the
 * same operators reach both. §16 turns that into a rule rather than a warning —
 * a Target with a minimum of L2 refuses this route, which is also why §4 says a
 * Target "cannot be both offline-capable and require L2 or above". `buildLevel`
 * below is what `selectBuildRoute` reads to enforce it.
 *
 * `LIVE_TEXT`, and here it is genuinely free: the runner is a pod on a cluster
 * this process is already connected to, so its log is one more read against an
 * API the adapter already holds (§4's amendment).
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import {
  KubernetesApi,
  type KubernetesObject,
} from '../deploy/kubernetes/api.ts';
import {
  buildKitProgramFor,
  dockerConfigFor,
  REGISTRY_AUTH_VAR,
} from './buildkit.ts';
import type {
  BuildAdapter,
  BuildEvent,
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
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

export interface InClusterRouteOptions extends PollingOptions {
  readonly name: string;
  readonly api: KubernetesApi;
  /** Where the Job is created. Never created by Spindrift (§7). */
  readonly namespace: string;
  /** The BuildKit image the Job runs. Pinned by the installation. */
  readonly image: string;
  /** The zero-config BuildKit frontend the installation pinned (§4). */
  readonly zeroConfigFrontend: string;
  /**
   * The service account the Job runs as.
   *
   * How the build authorizes its push without this process holding a registry
   * credential: the cluster projects a token for that account, and the registry
   * trusts it. §13's "nothing stored" reaches the builder the same way it
   * reaches everything else.
   */
  readonly serviceAccount: string;
  /** Injected so a test can pin the Job name it asserts on. */
  readonly id?: () => string;
}

/**
 * How long a finished Job's objects — and therefore its log — stick around.
 *
 * The log is read once, at the end, and then it is core's: §12 says the platform
 * will not keep it, so the attempt log is the copy that survives. An hour is
 * enough for an operator who was watching to go back to the pod.
 */
export const JOB_TTL_SECONDS = 3600;

/** The label a build Job carries so its pod can be found. */
export const JOB_LABEL = 'spindrift.dev/build';

export class InClusterBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'LIVE_TEXT';
  readonly buildLevel: BuildLevel = 1;
  readonly provenanceBuilderId = 'https://spindrift.dev/builders/in-cluster';
  /**
   * The Job's container is a place a secret can go. See the ceiling named on
   * {@link InClusterBuildRoute.job}.
   */
  readonly carriesRegistryCredential = true;
  /**
   * The Job runs as a service account, and what that account reaches is a
   * workload identity binding on one vendor's registries. Anything else the
   * installation pushes to needs a stored credential, which this route can
   * carry — see {@link InClusterBuildRoute.carriesRegistryCredential}.
   */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [
    'artifactRegistry',
  ];

  constructor(private readonly options: InClusterRouteOptions) {
    this.name = options.name;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;
    const { api, namespace } = this.options;

    const id = (this.options.id ?? (() => crypto.randomUUID().slice(0, 8)))();
    const name = `spindrift-build-${id}`;
    const job = this.job(
      name,
      buildKitProgramFor(source, spec, this.options.zeroConfigFrontend),
      dockerConfigFor(spec.registryAuth),
    );

    try {
      await api.apply(job, 'jobs');
    } catch (error) {
      // §4 story 48: the failure before the build step is text, not a spinner.
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
    let outcome: 'succeeded' | 'failed' | null = null;

    for (;;) {
      log = (await this.readLog(name)) ?? log;
      // Only what is new. The API serves the whole log every time, so a route
      // that yielded all of it each pass would repeat the build's output once
      // per poll interval.
      const lines = log.split('\n');
      for (const line of lines.slice(delivered)) {
        if (line.trim() === '') continue;
        yield { type: 'log', at: now(), line, step: name };
      }
      delivered = lines.length;

      outcome = await this.outcome(name);
      if (outcome !== null) break;

      if (budget.expired()) {
        return buildFailed(
          logs,
          'TIMEOUT',
          `Job ${name} did not finish within the build budget`,
          { job: name },
        );
      }
      await budget.tick();
    }

    // One last read: the log the pod wrote between the previous poll and the
    // Job reaching a terminal count is the log that says why it failed.
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
      // §16: the backend's provenance. A Job on a cluster can claim what ran
      // and where, and nothing more — which is exactly what L1 means, and is
      // why this document is small rather than absent.
      report: { ...report, statement: { job: name, namespace } },
    });
  }

  /**
   * The Job one build runs as.
   *
   * `backoffLimit: 0` because a retry is core's to decide, not the cluster's: a
   * Job that retried itself would push a second artifact for one Build row, and
   * §4's "no ordinal" rests on a Build recording one artifact.
   *
   * ponytail: a registry credential rides as a plain container environment
   * variable, so it is readable by anyone with `get jobs` in the build
   * namespace for the Job's TTL. That namespace is platform-owned and already
   * holds the service account token this build pushes with, so it is the same
   * trust boundary rather than a new one — but it is a wider blast radius than
   * the credential needs. Upgrade path: a Secret created with an
   * `ownerReferences` entry pointing at this Job, mounted at `DOCKER_CONFIG`,
   * so it is garbage collected with the Job rather than depending on this
   * route's own cleanup.
   */
  private job(
    name: string,
    program: string,
    dockerConfig: string | null,
  ): KubernetesObject {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: this.options.namespace,
        labels: { [JOB_LABEL]: name },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        template: {
          metadata: { labels: { [JOB_LABEL]: name } },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: this.options.serviceAccount,
            containers: [
              {
                name: 'build',
                image: this.options.image,
                command: ['sh', '-c', program],
                // Absent entirely when there is no credential, rather than
                // present and empty: an installation that stores nothing should
                // leave no trace of the mechanism on its build Jobs.
                ...(dockerConfig === null
                  ? {}
                  : {
                      env: [{ name: REGISTRY_AUTH_VAR, value: dockerConfig }],
                    }),
              },
            ],
          },
        },
      },
    };
  }

  /** Whether the Job is over, and how. `null` while it is still going. */
  private async outcome(name: string): Promise<'succeeded' | 'failed' | null> {
    const job = await this.options.api.get({
      apiVersion: 'batch/v1',
      plural: 'jobs',
      namespace: this.options.namespace,
      name,
    });
    // A Job that is gone is a Job something else deleted mid-build. Reporting
    // it as failed is the honest reading: nothing pushed an artifact, and there
    // is no longer anything to wait for.
    if (job === null) return 'failed';

    const status = (job.status ?? {}) as {
      succeeded?: number;
      failed?: number;
    };
    if ((status.succeeded ?? 0) > 0) return 'succeeded';
    if ((status.failed ?? 0) > 0) return 'failed';
    return null;
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
