/**
 * The Kubernetes deploy adapter against a fake cluster API. It applies one
 * delivery object with inline values in the flavour the Target declares, takes
 * phases from the controller, and reads pods and events once on red.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor, RESTART_STAMP } from '../../src/adapters/deploy/contract.ts';
import { KubernetesApi } from '../../src/adapters/deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { VALUES_CONTRACT } from '../../src/adapters/deploy/kubernetes/values.ts';
import type { PrerequisiteResult } from '../../src/domain/capabilities.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import type {
  KubernetesAdapterConnection,
  KubernetesDelivery,
} from '../../src/domain/target.ts';
import {
  FakeKubernetes,
  type FakeKubernetesOptions,
  type FakeObject,
  type StatusScript,
} from '../harness/fakes/kubernetes-api.ts';

const CHART = 'example/spindrift-app';
/** The same chart as an OCI artifact, the other spelling of `charts.app`. */
const OCI_CHART = 'oci://registry.example.test/charts/spindrift-app';

const FLUX: KubernetesDelivery = {
  flavour: 'flux-helmrelease',
  namespace: 'delivery',
  sourceRef: { name: 'charts', namespace: 'delivery' },
};

const ARGO: KubernetesDelivery = {
  flavour: 'argo-application',
  namespace: 'delivery',
  project: 'default',
  repoUrl: 'https://git.example.test/infra',
  revision: 'main',
  server: 'https://kubernetes.default.svc',
};

/** An Argo Target whose repository names the registry of {@link OCI_CHART}. */
const ARGO_OCI: KubernetesDelivery = {
  flavour: 'argo-application',
  namespace: 'delivery',
  project: 'default',
  repoUrl: 'registry.example.test/charts',
  revision: '1.4.0',
  server: 'https://kubernetes.default.svc',
};

const SYNCED = () => ({
  health: { status: 'Healthy' },
  sync: { status: 'Synced' },
});

/**
 * Everything an Argo Target's checklist needs but the chart. There is no Flux
 * source object, since Argo fetches the repository itself.
 */
const ARGO_CLUSTER: FakeKubernetesOptions = {
  objects: {
    'namespaces//apps': {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'apps',
        // Every App namespace copies these labels.
        labels: {
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/audit': 'restricted',
          'pod-security.kubernetes.io/warn': 'restricted',
        },
      },
    },
  },
  lists: {
    clustersecretstores: [
      {
        apiVersion: 'external-secrets.io/v1',
        kind: 'ClusterSecretStore',
        metadata: { name: 'vault' },
        spec: { provider: { gcpsm: {} } },
      },
    ],
  },
};

/** A cluster that serves everything the checklist looks for. */
const SERVED = {
  'helm.toolkit.fluxcd.io/v2': ['HelmRelease'],
  'argoproj.io/v1alpha1': ['Application'],
  'postgresql.cnpg.io/v1': ['Cluster'],
  'cilium.io/v2': ['CiliumNetworkPolicy'],
  'kyverno.io/v1': ['ClusterPolicy'],
};

function connection(
  overrides: Partial<KubernetesAdapterConnection> = {},
): KubernetesAdapterConnection {
  return {
    adapter: 'kubernetes',
    apiServer: 'https://cluster.example.test',
    namespace: 'apps',
    delivery: FLUX,
    ...overrides,
  };
}

function podRenderedUnder(
  contract: string,
  overrides: { name?: string; createdAt?: string; phase?: string } = {},
): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: overrides.name ?? 'blog-web-abc',
      labels: POD_LABELS,
      creationTimestamp: overrides.createdAt ?? '2026-01-01T00:00:00Z',
      annotations: { 'spindrift.dev/values-contract': contract },
    },
    ...(overrides.phase === undefined
      ? {}
      : { status: { phase: overrides.phase } }),
  };
}

async function contractCheck(
  adapter: KubernetesDeployAdapter,
): Promise<PrerequisiteResult | undefined> {
  const { prerequisites } = await adapter.inspect(target());
  return prerequisites.find((item) => item.name === 'CHART_CONTRACT');
}

function target(
  connectionOverrides: Partial<KubernetesAdapterConnection> = {},
): DeployTarget {
  return {
    vessel: 'cluster',
    adapter: 'kubernetes',
    connection: connection(connectionOverrides),
  };
}

function desiredState(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    deploy: 'deploy-1',
    app: 'blog',
    component: 'web',
    target: 'cluster',
    kind: 'service',
    artifact: {
      type: 'image',
      digest: 'sha256:feed',
      refs: ['registry.example.test/blog/web@sha256:feed'],
    },
    expose: true,
    reach: 'private',
    auth: 'proxy',
    config: [],
    requirements: {
      platform: { os: 'linux', arch: 'amd64' },
      resources: { cpu: '250m', memory: '256Mi' },
    },
    hostname: { canonical: 'blog-web.apps.example.test' },
    ...overrides,
  };
}

function adapterFor(
  options: FakeKubernetesOptions = {},
  /** The source kind follows how the chart is named. */
  chart: string = CHART,
): {
  adapter: KubernetesDeployAdapter;
  cluster: FakeKubernetes;
} {
  const cluster = new FakeKubernetes({ servedKinds: SERVED, ...options });
  const adapter = new KubernetesDeployAdapter({
    chart,
    token: cluster.token,
    fetch: cluster.fetch,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  return { adapter, cluster };
}

interface RenderedValues {
  platform: { runtimeClassName?: string };
  shared: { resources?: unknown; podLabels?: unknown };
  app: {
    artifactDigest?: string;
    expose?: boolean;
    hostnames?: readonly string[];
    kind?: string;
    port?: number;
  };
}

function renderedValues(cluster: FakeKubernetes): RenderedValues {
  const release = cluster.get('helmreleases/delivery/blog-web');
  const spec = release?.spec as { values?: RenderedValues } | undefined;
  if (spec?.values === undefined) {
    throw new Error('expected the HelmRelease to carry inline values');
  }
  return spec.values;
}

async function drain(
  stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
): Promise<{ events: DeployEvent[]; verdict: DeployVerdict }> {
  const events: DeployEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, verdict: step.value };
}

/**
 * The chart's `spindrift-app.selectorLabels`, which the adapter's
 * `labelSelector` names; a pod without them is invisible to it.
 */
const POD_LABELS = {
  'app.kubernetes.io/name': 'web',
  'app.kubernetes.io/part-of': 'blog',
};

function pod(reason: string, message: string): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'blog-web-abc', namespace: 'apps', labels: POD_LABELS },
    status: {
      containerStatuses: [
        { name: 'app', ready: false, state: { waiting: { reason, message } } },
      ],
    },
  };
}

function podNotReady(): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'blog-web-abc', namespace: 'apps', labels: POD_LABELS },
    status: { containerStatuses: [{ name: 'app', ready: false, state: {} }] },
  };
}

/** Progress forever, on a clock that reaches the deadline. */
function stalling(lists: FakeKubernetesOptions['lists']): {
  adapter: KubernetesDeployAdapter;
  cluster: FakeKubernetes;
} {
  const cluster = new FakeKubernetes({
    servedKinds: SERVED,
    lists,
    status: () => ({
      observedGeneration: 1,
      conditions: [{ type: 'Ready', status: 'False', reason: 'Progressing' }],
    }),
  });
  let clock = 0;
  const adapter = new KubernetesDeployAdapter({
    chart: CHART,
    token: cluster.token,
    fetch: cluster.fetch,
    pollIntervalMs: 1_000,
    timeoutMs: 5_000,
    sleep: async () => {
      clock += 1_000;
    },
    now: () => clock,
  });
  return { adapter, cluster };
}

/** A `HelmRelease` that failed without saying why. */
const INSTALL_FAILED: StatusScript = () => ({
  observedGeneration: 1,
  conditions: [
    {
      type: 'Ready',
      status: 'False',
      reason: 'InstallFailed',
      message: 'install retries exhausted',
    },
    { type: 'Stalled', status: 'True', reason: 'InstallFailed' },
  ],
});

describe('the delivery object', () => {
  test('a HelmRelease is applied through the API, with inline values', async () => {
    const { adapter, cluster } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desiredState()));

    expect(verdict.phase).toBe('LIVE');
    const applied = cluster.get('helmreleases/delivery/blog-web');
    expect(applied?.kind).toBe('HelmRelease');

    const spec = applied?.spec as any;
    // Flux merges `valuesFrom` and then overwrites it with inline values.
    expect(spec.values.app.image).toBe(
      'registry.example.test/blog/web@sha256:feed',
    );
    expect(spec.valuesFrom).toBeUndefined();
    expect(cluster.all('configmaps')).toEqual([]);

    // Only a HelmChart built from a GitRepository source can carry a path.
    expect(spec.chart.spec.chart).toBe(CHART);
    expect(spec.chart.spec.sourceRef).toEqual({
      kind: 'GitRepository',
      name: 'charts',
      namespace: 'delivery',
    });
    expect(spec.chartRef).toBeUndefined();
    // Core owns retries, so the controller makes none.
    expect(spec.install.remediation.retries).toBe(0);
  });

  test('an oci:// chart is delivered as a chartRef at the Target’s OCIRepository', async () => {
    // Flux refuses `chart` beside `chartRef`, and `chart.spec.sourceRef` does
    // not accept an `OCIRepository`, so the whole reference moves.
    const { adapter, cluster } = adapterFor({}, OCI_CHART);
    const { verdict } = await drain(adapter.apply(target(), desiredState()));

    expect(verdict.phase).toBe('LIVE');
    const spec = cluster.get('helmreleases/delivery/blog-web')?.spec as any;
    expect(spec.chartRef).toEqual({
      kind: 'OCIRepository',
      name: 'charts',
      namespace: 'delivery',
    });
    expect(spec.chart).toBeUndefined();
    expect(spec.values.app.image).toBe(
      'registry.example.test/blog/web@sha256:feed',
    );
    expect(spec.install.remediation.retries).toBe(0);
  });

  test('the write is a server-side apply, attributed to Spindrift', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(adapter.apply(target(), desiredState()));

    const writes = cluster.requests.filter(
      (request) => request.method === 'PATCH',
    );
    // Applies converge, so a second deploy does not trip on its namespace.
    expect(writes.map((write) => write.contentType)).toEqual([
      'application/apply-patch+yaml',
      'application/apply-patch+yaml',
    ]);
    // Namespace first, or the release is written into a missing namespace.
    expect(writes.map((write) => write.path)).toEqual([
      '/api/v1/namespaces/app-blog',
      '/apis/helm.toolkit.fluxcd.io/v2/namespaces/delivery/helmreleases/blog-web',
    ]);
  });

  test('the App namespace carries the admission labels the vessel declares', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(adapter.apply(target(), desiredState()));

    // Copied from the Target's declared namespace, so an operator's change
    // reaches every App.
    const namespace = cluster.get('namespaces//app-blog');
    expect(namespace?.metadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/audit': 'restricted',
      'pod-security.kubernetes.io/warn': 'restricted',
    });
  });

  test('a vessel declaring no admission policy gets no App namespace', async () => {
    // A namespace without Pod Security labels would admit pods this vessel
    // refuses.
    const { adapter, cluster } = adapterFor({ namespaceLabels: {} });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));

    expect(verdict.phase).toBe('FAILED');
    expect(cluster.get('namespaces//app-blog')).toBeUndefined();
    expect(cluster.get('helmreleases/delivery/blog-web')).toBeUndefined();
  });

  test('the Target declares the flavour: the same state, an Argo Application', async () => {
    const { adapter, cluster } = adapterFor({ status: SYNCED });
    const { verdict } = await drain(
      adapter.apply(target({ delivery: ARGO }), desiredState()),
    );

    expect(verdict.phase).toBe('LIVE');
    const applied = cluster.get('applications/delivery/blog-web');
    expect(applied?.kind).toBe('Application');
    const spec = applied?.spec as any;
    expect(spec.source.helm.valuesObject.app.component).toBe('web');
    expect(spec.destination.namespace).toBe('app-blog');
    expect(spec.source.repoURL).toBe('https://git.example.test/infra');
    expect(spec.source.path).toBe(CHART);
    expect(spec.source.chart).toBeUndefined();
    // Argo creates the namespace with labels; Flux's `createNamespace` takes no
    // metadata, so on Flux the adapter applies the Namespace itself.
    expect(spec.syncPolicy.syncOptions).toEqual(['CreateNamespace=true']);
    expect(spec.syncPolicy.managedNamespaceMetadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'restricted',
    });
    // No tracking annotation, or a sync could delete the namespace and every
    // workload in it.
    expect(
      spec.syncPolicy.managedNamespaceMetadata.annotations,
    ).toBeUndefined();
    expect(
      cluster.requests.filter((request) =>
        request.path.startsWith('/api/v1/namespaces/app-blog'),
      ),
    ).toEqual([]);
  });

  test('an oci:// chart is an Argo chart reference, never a path', async () => {
    // Argo takes an OCI chart as the registry in `repoURL` and the name in
    // `chart`, without `oci://`, and refuses a `path` beside a `chart`.
    const { adapter, cluster } = adapterFor({ status: SYNCED }, OCI_CHART);
    const { verdict } = await drain(
      adapter.apply(target({ delivery: ARGO_OCI }), desiredState()),
    );

    expect(verdict.phase).toBe('LIVE');
    const spec = cluster.get('applications/delivery/blog-web')?.spec as any;
    expect(spec.source.repoURL).toBe('registry.example.test/charts');
    expect(spec.source.chart).toBe('spindrift-app');
    expect(spec.source.path).toBeUndefined();
    expect(spec.source.targetRevision).toBe('1.4.0');
    expect(spec.source.helm.valuesObject.app.image).toBe(
      'registry.example.test/blog/web@sha256:feed',
    );
  });

  test('the values carry the three classes, with Spindrift winning the shared one', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(
      adapter.apply(
        target({
          chartValues: {
            platform: { runtimeClassName: 'gvisor' },
            shared: {
              resources: { limits: { cpu: '2' } },
              podLabels: { tier: 'web' },
            },
          },
        }),
        desiredState(),
      ),
    );

    const values = renderedValues(cluster);
    expect(values.platform.runtimeClassName).toBe('gvisor');
    // Core's `resources` replaces the operator's; other shared keys survive.
    expect(values.shared.resources).toEqual({
      requests: { cpu: '250m', memory: '256Mi' },
    });
    expect(values.shared.podLabels).toEqual({ tier: 'web' });
    expect(values.app.artifactDigest).toBe('sha256:feed');
    expect(values.app.hostnames).toEqual(['blog-web.apps.example.test']);
  });

  test('a website on a cluster is a service with a hostname, not files', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(
      adapter.apply(
        target(),
        desiredState({
          kind: 'website',
          hostname: {
            canonical: 'blog-web.apps.example.test',
            vanity: 'blog.example.test',
          },
        }),
      ),
    );
    const values = renderedValues(cluster);
    expect(values.app.kind).toBe('website');
    expect(values.app.expose).toBe(true);
    expect(values.app.port).toBe(8080);
    expect(values.app.hostnames).toEqual([
      'blog-web.apps.example.test',
      'blog.example.test',
    ]);
  });
});

describe('sweeping the App away', () => {
  test('it deletes the namespace it made, and only that', async () => {
    // A ref names a placement, so `destroy` never reaches the App's namespace.
    const { adapter, cluster } = adapterFor();
    await drain(adapter.apply(target(), desiredState()));
    expect(cluster.get('namespaces//app-blog')).toBeDefined();

    await adapter.sweepApp(target(), 'blog');

    expect(cluster.get('namespaces//app-blog')).toBeUndefined();
  });

  test('sweeping what is already gone succeeds', async () => {
    // `namespaceLabels: {}` is this fake's "the namespace is not there".
    const { adapter } = adapterFor({ namespaceLabels: {} });
    await adapter.sweepApp(target(), 'never-deployed');
  });

  test('it refuses a namespace it did not make', async () => {
    // The fake answers every namespace read with the operator's declared one,
    // which has no `managed-by` label.
    const { adapter, cluster } = adapterFor();

    await expect(adapter.sweepApp(target(), 'blog')).rejects.toThrow(
      /app.kubernetes.io\/managed-by=spindrift/,
    );
    expect(cluster.get('namespaces//app-blog')).toBeUndefined();
  });
});

describe('phases come from the controller', () => {
  test('the timeline reports each phase the object moved through, once', async () => {
    const { adapter } = adapterFor({
      status: (reads) =>
        reads < 3
          ? {
              observedGeneration: 1,
              conditions: [
                {
                  type: 'Ready',
                  status: 'False',
                  reason: 'Progressing',
                  message: 'installing',
                },
              ],
            }
          : {
              observedGeneration: 1,
              conditions: [{ type: 'Ready', status: 'True', message: 'ok' }],
            },
    });

    const { events, verdict } = await drain(
      adapter.apply(target(), desiredState()),
    );
    expect(verdict.phase).toBe('LIVE');

    const phases = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.phase : ''));
    expect(phases).toEqual(['APPLYING', 'WAITING', 'LIVE']);
  });

  test("the controller's own sentence reaches the timeline, once each", async () => {
    // A Helm upgrade says several things within one phase, and those are the
    // only progress a reader sees before the verdict.
    const said = ['pulling chart', 'pulling chart', 'running upgrade'];
    const { adapter } = adapterFor({
      status: (reads) => {
        const message = said[reads];
        return message === undefined
          ? {
              observedGeneration: 1,
              conditions: [
                { type: 'Ready', status: 'True', message: 'upgrade succeeded' },
              ],
            }
          : {
              observedGeneration: 1,
              conditions: [
                {
                  type: 'Ready',
                  status: 'False',
                  reason: 'Progressing',
                  message,
                },
              ],
            };
      },
    });

    const { events, verdict } = await drain(
      adapter.apply(target(), desiredState()),
    );
    expect(verdict.phase).toBe('LIVE');

    const lines = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.line : ''));
    // The terminal sentence travels on the verdict, not the log.
    expect(lines).toEqual([
      'applied HelmRelease/delivery/blog-web',
      'pulling chart',
      'running upgrade',
    ]);
  });

  test('a LIVE verdict carries no url — the cluster gives no name of its own', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    // Core mints the name where the platform gives none, so a url here would
    // be a second naming authority.
    expect(verdict).toEqual({
      phase: 'LIVE',
      ref: 'flux-helmrelease:delivery/blog-web',
    });
  });

  test('a stale status is not read as a verdict', async () => {
    // The object still carries the last generation's Ready=True.
    let observed = 0;
    const { adapter } = adapterFor({
      status: (reads) => {
        observed = reads;
        return reads < 2
          ? {
              observedGeneration: 0,
              conditions: [{ type: 'Ready', status: 'True', message: 'stale' }],
            }
          : {
              observedGeneration: 1,
              conditions: [{ type: 'Ready', status: 'True', message: 'fresh' }],
            };
      },
    });

    const { events } = await drain(adapter.apply(target(), desiredState()));
    expect(observed).toBeGreaterThan(1);
    const phases = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.phase : ''));
    expect(phases).toEqual(['APPLYING', 'LIVE']);
  });

  test('an attempt that never settles is TIMEOUT, blaming nobody', async () => {
    const cluster = new FakeKubernetes({
      servedKinds: SERVED,
      status: () => ({
        observedGeneration: 1,
        conditions: [{ type: 'Ready', status: 'False', reason: 'Progressing' }],
      }),
    });
    let clock = 0;
    const adapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: cluster.token,
      fetch: cluster.fetch,
      pollIntervalMs: 1_000,
      timeoutMs: 5_000,
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
    });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('TIMEOUT');
    expect(blameFor(verdict.reason)).toBeNull();
  });

  test('a deadline reads the namespace, and names what stalled it', async () => {
    const { adapter } = stalling({
      pods: [pod('ImagePullBackOff', 'Back-off pulling image')],
      events: [],
    });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    // A stalled rollout backing off its image pull is ARTIFACT_UNAVAILABLE too.
    expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(blameFor(verdict.reason)).toBe('platform');
  });

  test('a deadline over pods that never went ready is UNHEALTHY', async () => {
    const { adapter } = stalling({ pods: [podNotReady()], events: [] });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('UNHEALTHY');
  });

  test('a deadline over an empty namespace stays TIMEOUT', async () => {
    const { adapter } = stalling({ pods: [], events: [] });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    // Under a failure verdict an empty namespace is REJECTED; under a deadline
    // it may be a chart still resolving, so it blames nobody.
    expect(verdict.reason).toBe('TIMEOUT');
    expect(blameFor(verdict.reason)).toBeNull();
  });

  test('the timeline says what the deadline concluded, not TIMEOUT', async () => {
    const { adapter } = stalling({
      pods: [pod('CrashLoopBackOff', 'back-off restarting failed container')],
      events: [],
    });

    const { events } = await drain(adapter.apply(target(), desiredState()));
    const failure = events.find(
      (event) => event.type === 'status' && event.phase === 'FAILED',
    );
    if (failure?.type !== 'status') throw new Error('expected a FAILED status');
    expect(failure.reason).toBe('STARTUP_FAILED');
  });
});

describe('the read on red', () => {
  test('an image that will not pull is the platform’s fault, not the code’s', async () => {
    const { adapter, cluster } = adapterFor({
      status: INSTALL_FAILED,
      lists: {
        pods: [pod('ImagePullBackOff', 'Back-off pulling image')],
        events: [],
      },
    });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(blameFor(verdict.reason)).toBe('platform');
    expect(verdict.detail).toBe('Back-off pulling image');

    // One read of pods, not a watch.
    expect(
      cluster.pathsOf('GET').filter((path) => path.endsWith('/pods')),
    ).toHaveLength(1);
  });

  test('a crash loop is the developer’s', async () => {
    const { adapter } = adapterFor({
      status: INSTALL_FAILED,
      lists: {
        pods: [pod('CrashLoopBackOff', 'back-off restarting failed container')],
        events: [],
      },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('STARTUP_FAILED');
    expect(blameFor(verdict.reason)).toBe('developer');
  });

  test('an admission refusal is REJECTED, and the diagnosis is kept', async () => {
    const { adapter } = adapterFor({
      status: INSTALL_FAILED,
      lists: {
        pods: [],
        events: [
          {
            apiVersion: 'v1',
            kind: 'Event',
            metadata: { name: 'e1', namespace: 'apps' },
            reason: 'FailedCreate',
            message: 'admission webhook denied the request',
          },
        ],
      },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('REJECTED');
    expect(verdict.detail).toBe('admission webhook denied the request');
    // Cluster events expire in about an hour, so core stores the raw payload.
    expect(verdict.debug).toBeDefined();
  });

  test('a reason the object already carries needs no read at all', async () => {
    const { adapter, cluster } = adapterFor({
      status: () => ({
        observedGeneration: 1,
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'ChartPullFailed',
            message: 'chart not found',
          },
          { type: 'Stalled', status: 'True' },
        ],
      }),
    });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(
      cluster.pathsOf('GET').filter((path) => path.endsWith('/pods')),
    ).toEqual([]);
  });
});

describe('a write that never landed', () => {
  test('a refused apply is REJECTED, carrying the cluster’s own sentence', async () => {
    const { adapter } = adapterFor({
      refuse: { status: 422, body: 'admission webhook denied the request' },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('REJECTED');
    expect(verdict.detail).toBe('admission webhook denied the request');
  });

  test('a cluster that is down is TARGET_UNREACHABLE, blaming the platform', async () => {
    const { adapter } = adapterFor({
      refuse: { status: 503, body: 'the server is currently unable' },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('TARGET_UNREACHABLE');
    expect(blameFor(verdict.reason)).toBe('platform');
  });

  test('an apply the API server 404s is a failure, blamed on the platform', async () => {
    // An apply into a deleted namespace or without its CRD answers `404`, and
    // nothing missing here is the developer's object.
    const { adapter, cluster } = adapterFor({
      refuse: { status: 404, body: 'namespaces "apps" not found' },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('TARGET_UNREACHABLE');
    expect(blameFor(verdict.reason)).toBe('platform');
    expect(verdict.detail).toBe('namespaces "apps" not found');
    expect(cluster.all('helmreleases')).toHaveLength(0);
  });

  test('an expired credential is unreachable, not a rejection', async () => {
    const { adapter } = adapterFor({ token: 'a-different-token' });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    expect(verdict.reason).toBe('TARGET_UNREACHABLE');
  });
});

describe('observe is the authority on what is running', () => {
  test('it reports the digest the delivery object carries', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'LIVE') throw new Error('expected a live deploy');

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.artifactDigest).toBe('sha256:feed');
    expect(observed?.phase).toBe('LIVE');
  });

  test('a workload nobody placed through Spindrift is still observable', async () => {
    // Drift detection needs `observe` to read the cluster, not core's memory.
    const { adapter, cluster } = adapterFor();
    cluster.place('helmreleases/delivery/other-web', {
      apiVersion: 'helm.toolkit.fluxcd.io/v2',
      kind: 'HelmRelease',
      metadata: { name: 'other-web', namespace: 'delivery', generation: 1 },
      spec: { values: { app: { artifactDigest: 'sha256:elsewhere' } } },
    });

    const observed = await adapter.observe(
      target(),
      'flux-helmrelease:delivery/other-web',
    );
    expect(observed?.artifactDigest).toBe('sha256:elsewhere');
  });

  function deployment(available: 'True' | 'False'): FakeObject {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'blog-web', namespace: 'apps', labels: POD_LABELS },
      status: {
        conditions: [
          {
            type: 'Available',
            status: available,
            reason:
              available === 'True'
                ? 'MinimumReplicasAvailable'
                : 'MinimumReplicasUnavailable',
            message:
              available === 'True'
                ? 'Deployment has minimum availability.'
                : 'Deployment does not have minimum availability.',
          },
        ],
      },
    };
  }

  test('a ready HelmRelease over a crash-looping workload is FAILED, with the read on red', async () => {
    // The HelmRelease never reconciles again after a successful install, so
    // its `Ready=True` outlives the pods; the Deployment's condition does not.
    const { adapter } = adapterFor({
      lists: {
        deployments: [deployment('False')],
        pods: [pod('CrashLoopBackOff', 'back-off restarting failed container')],
        events: [],
      },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'LIVE') throw new Error('expected a live deploy');

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.phase).toBe('FAILED');
    expect(observed?.reason).toBe('STARTUP_FAILED');
    expect(observed?.detail).toBe('back-off restarting failed container');
    // Still the object's digest, so core's drift comparison stays correct.
    expect(observed?.artifactDigest).toBe('sha256:feed');
    // The cluster will not keep what the read saw, so the verdict carries it.
    expect(observed?.debug).toMatchObject({
      workload: [{ type: 'Available', status: 'False' }],
      diagnosis: { pods: [{ kind: 'Pod' }] },
    });
  });

  test('an image that stopped pulling after readiness is the platform’s fault', async () => {
    const { adapter } = adapterFor({
      lists: {
        deployments: [deployment('False')],
        pods: [pod('ImagePullBackOff', 'Back-off pulling image')],
        events: [],
      },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'LIVE') throw new Error('expected a live deploy');

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.phase).toBe('FAILED');
    expect(observed?.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(blameFor(observed!.reason!)).toBe('platform');
  });

  test('an available workload costs one list and reads no pods', async () => {
    const { adapter, cluster } = adapterFor({
      lists: {
        deployments: [deployment('True')],
        pods: [pod('CrashLoopBackOff', 'a pod from some other rollout')],
      },
    });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'LIVE') throw new Error('expected a live deploy');
    const before = cluster.pathsOf('GET').length;

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.phase).toBe('LIVE');
    // The delivery object and the Deployment; nothing was red, so no pods.
    const reads = cluster.pathsOf('GET').slice(before);
    expect(reads).toHaveLength(2);
    expect(reads.some((path) => path.endsWith('/pods'))).toBe(false);
  });

  test('a job has no Deployment to consult, so the delivery object’s word stands', async () => {
    const { adapter, cluster } = adapterFor({
      lists: { deployments: [deployment('False')] },
    });
    const { verdict } = await drain(
      adapter.apply(
        target(),
        desiredState({ kind: 'job', schedule: '0 * * * *', expose: false }),
      ),
    );
    if (verdict.phase !== 'LIVE') throw new Error('expected a live deploy');
    const before = cluster.pathsOf('GET').length;

    const observed = await adapter.observe(target(), verdict.ref);
    expect(observed?.phase).toBe('LIVE');
    expect(cluster.pathsOf('GET').slice(before)).toHaveLength(1);
  });
});

describe('the checklist', () => {
  test('a healthy cluster meets every item', async () => {
    const { adapter } = adapterFor({
      objects: {
        'gitrepositories/delivery/charts': {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'GitRepository',
          metadata: { name: 'charts', namespace: 'delivery' },
        },
        'namespaces//apps': {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: 'apps',
            labels: {
              'pod-security.kubernetes.io/enforce': 'restricted',
              'pod-security.kubernetes.io/audit': 'restricted',
              'pod-security.kubernetes.io/warn': 'restricted',
            },
          },
        },
      },
      lists: {
        clustersecretstores: [
          {
            apiVersion: 'external-secrets.io/v1',
            kind: 'ClusterSecretStore',
            metadata: { name: 'vault' },
            spec: { provider: { gcpsm: {} } },
          },
        ],
      },
    });

    const { prerequisites } = await adapter.inspect(target());
    expect(prerequisites.filter((item) => !item.met)).toEqual([]);
  });

  test('a Target without the chart source is unhealthy, and says so', async () => {
    // The chart is pinned per Target, so its source object is a prerequisite.
    const { adapter } = adapterFor({
      objects: {
        'namespaces//apps': {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: 'apps',
            labels: {
              'pod-security.kubernetes.io/enforce': 'restricted',
              'pod-security.kubernetes.io/audit': 'restricted',
              'pod-security.kubernetes.io/warn': 'restricted',
            },
          },
        },
      },
    });

    const { prerequisites } = await adapter.inspect(target());
    const chartSource = prerequisites.find(
      (item) => item.name === 'CHART_SOURCE',
    );
    expect(chartSource?.met).toBe(false);
    expect(chartSource?.detail).toContain('GitRepository');
    expect(chartSource?.detail).toContain('charts');
  });

  test('the kind the checklist reads follows the installation’s chart reference', async () => {
    // A GitRepository of the right name must not satisfy an OCI installation.
    const gitOnly = {
      objects: {
        'gitrepositories/delivery/charts': {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'GitRepository',
          metadata: { name: 'charts', namespace: 'delivery' },
        },
        'namespaces//apps': {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: 'apps',
            labels: {
              'pod-security.kubernetes.io/enforce': 'restricted',
              'pod-security.kubernetes.io/audit': 'restricted',
              'pod-security.kubernetes.io/warn': 'restricted',
            },
          },
        },
      },
    };

    const missing = await adapterFor(gitOnly, OCI_CHART).adapter.inspect(
      target(),
    );
    const unmet = missing.prerequisites.find(
      (item) => item.name === 'CHART_SOURCE',
    );
    expect(unmet?.met).toBe(false);
    expect(unmet?.detail).toContain('OCIRepository');

    const { adapter } = adapterFor(
      {
        objects: {
          ...gitOnly.objects,
          'ocirepositories/delivery/charts': {
            apiVersion: 'source.toolkit.fluxcd.io/v1',
            kind: 'OCIRepository',
            metadata: { name: 'charts', namespace: 'delivery' },
            spec: { url: OCI_CHART },
          },
        },
      },
      OCI_CHART,
    );
    const { prerequisites } = await adapter.inspect(target());
    expect(
      prerequisites.find((item) => item.name === 'CHART_SOURCE')?.met,
    ).toBe(true);
  });

  test('a source object serving another artifact is named, not deployed to', async () => {
    // `chartRef` names only the source object, so a Component pulls whatever
    // that object's `url` says.
    const { adapter } = adapterFor(
      {
        objects: {
          'ocirepositories/delivery/charts': {
            apiVersion: 'source.toolkit.fluxcd.io/v1',
            kind: 'OCIRepository',
            metadata: { name: 'charts', namespace: 'delivery' },
            spec: { url: 'oci://registry.example.test/charts/somebody-else' },
          },
          'namespaces//apps': {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
              name: 'apps',
              labels: {
                'pod-security.kubernetes.io/enforce': 'restricted',
                'pod-security.kubernetes.io/audit': 'restricted',
                'pod-security.kubernetes.io/warn': 'restricted',
              },
            },
          },
        },
      },
      OCI_CHART,
    );

    const { prerequisites } = await adapter.inspect(target());
    const chartSource = prerequisites.find(
      (item) => item.name === 'CHART_SOURCE',
    );
    expect(chartSource?.met).toBe(false);
    expect(chartSource?.detail).toContain(
      'oci://registry.example.test/charts/somebody-else',
    );
    expect(chartSource?.detail).toContain(OCI_CHART);
  });

  test('a cluster running neither operator cannot deliver anything', async () => {
    const { adapter } = adapterFor({ servedKinds: {} });
    const { prerequisites } = await adapter.inspect(target());
    const operator = prerequisites.find(
      (item) => item.name === 'DELIVERY_OPERATOR',
    );
    expect(operator?.met).toBe(false);
    expect(operator?.detail).toContain('HelmRelease');
  });

  test('an Argo Target on a cluster that serves no Application says which operator is missing', async () => {
    // The checklist asks the API server what it serves, per flavour.
    const { adapter } = adapterFor(
      {
        servedKinds: { 'helm.toolkit.fluxcd.io/v2': ['HelmRelease'] },
        ...ARGO_CLUSTER,
      },
      OCI_CHART,
    );

    const { prerequisites } = await adapter.inspect(
      target({ delivery: ARGO_OCI }),
    );
    const operator = prerequisites.find(
      (item) => item.name === 'DELIVERY_OPERATOR',
    );
    expect(operator?.met).toBe(false);
    expect(operator?.detail).toContain('Application');
    expect(operator?.detail).not.toContain('HelmRelease');
  });

  test('an Argo Target pointed at another registry is not this chart’s source', async () => {
    // The Application pairs the Target's repository with this installation's
    // chart name, so a Target naming another registry pulls a different chart.
    const { adapter } = adapterFor(ARGO_CLUSTER, OCI_CHART);

    const { prerequisites } = await adapter.inspect(target({ delivery: ARGO }));
    const chartSource = prerequisites.find(
      (item) => item.name === 'CHART_SOURCE',
    );
    expect(chartSource?.met).toBe(false);
    expect(chartSource?.detail).toContain('https://git.example.test/infra');
    expect(chartSource?.detail).toContain('registry.example.test/charts');
  });

  test('an Argo Target naming the registry this installation is served from is met', async () => {
    // A path lives in the Application, so it has nothing to disagree with.
    const artifact = adapterFor(ARGO_CLUSTER, OCI_CHART);
    expect(
      (
        await artifact.adapter.inspect(target({ delivery: ARGO_OCI }))
      ).prerequisites.filter((item) => !item.met),
    ).toEqual([]);

    const path = adapterFor(ARGO_CLUSTER, CHART);
    expect(
      (
        await path.adapter.inspect(target({ delivery: ARGO }))
      ).prerequisites.filter((item) => !item.met),
    ).toEqual([]);
  });

  test('an identity that may not write the delivery object fails OIDC', async () => {
    const { adapter } = adapterFor({ allowed: false });
    const { prerequisites } = await adapter.inspect(target());
    const federation = prerequisites.find(
      (item) => item.name === 'OIDC_FEDERATION',
    );
    expect(federation?.met).toBe(false);
    expect(federation?.detail).toContain('delivery');
  });

  test('chart-contract skew is read off the cluster, not off the connection', async () => {
    // Helm ignores unknown values silently, so skew shows only in the contract
    // the chart records on what it rendered.
    const { adapter } = adapterFor({
      lists: { pods: [podRenderedUnder('2')] },
    });

    const { prerequisites } = await adapter.inspect(target());
    const contract = prerequisites.find(
      (item) => item.name === 'CHART_CONTRACT',
    );
    expect(contract?.met).toBe(false);
    expect(contract?.detail).toContain('2');
    expect(contract?.detail).toContain(VALUES_CONTRACT);
  });

  test('objects rendered under this contract are met, and so is a Target that has rendered none', async () => {
    const rendered = adapterFor({
      lists: { pods: [podRenderedUnder(VALUES_CONTRACT)] },
    });
    expect(
      (await rendered.adapter.inspect(target())).prerequisites.find(
        (item) => item.name === 'CHART_CONTRACT',
      )?.met,
    ).toBe(true);

    // A foreign pod has no contract annotation, so it stays out of the verdict.
    const foreign = adapterFor({
      lists: {
        pods: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'other' } }],
      },
    });
    const nothing = await contractCheck(foreign.adapter);
    expect(nothing?.met).toBe(true);
    expect(nothing?.detail).toBeUndefined();
  });

  test('a pod list this identity may not read is not a green contract check', async () => {
    // A refused read must not stand in as an empty list, which would make
    // "every rendered pod agrees" vacuously true.
    const { adapter } = adapterFor({ forbidden: ['pods'] });

    const contract = await contractCheck(adapter);
    expect(contract?.met).toBe(false);
    expect(contract?.detail).toContain('403');
  });

  test('a rolling update is not skew, and a finished pod does not outlive its render', async () => {
    // Mid-rollout, only the newest pod says what the release now renders.
    const rolling = adapterFor({
      lists: {
        pods: [
          podRenderedUnder('2', {
            name: 'blog-web-old',
            createdAt: '2026-01-01T00:00:00Z',
          }),
          podRenderedUnder(VALUES_CONTRACT, {
            name: 'blog-web-new',
            createdAt: '2026-01-02T00:00:00Z',
          }),
        ],
      },
    });
    expect((await contractCheck(rolling.adapter))?.met).toBe(true);

    // A finished job pod belongs to a render that is over.
    const finished = adapterFor({
      lists: {
        pods: [
          podRenderedUnder('2', { name: 'blog-cron-1', phase: 'Succeeded' }),
        ],
      },
    });
    expect((await contractCheck(finished.adapter))?.met).toBe(true);
  });
});

describe('discovery reports observations, never judgements', () => {
  test('it reads the nodes for arch, GPU, and the ceiling', async () => {
    const { adapter } = adapterFor({
      lists: {
        nodes: [
          node('amd64', { cpu: '8', memory: '32Gi' }),
          node('arm64', { cpu: '4', memory: '8Gi', 'nvidia.com/gpu': '1' }),
        ],
        storageclasses: [
          {
            apiVersion: 'storage.k8s.io/v1',
            kind: 'StorageClass',
            metadata: { name: 'local' },
          },
        ],
      },
    });

    const { discovery } = await adapter.inspect(target());
    expect(discovery.arch).toEqual(['amd64', 'arm64']);
    expect(discovery.gpu).toBe(true);
    // The largest single workload: one node's allocatable, never the sum.
    expect(discovery.resourceCeiling).toEqual({ cpu: '8', memory: '32768Mi' });
    expect(discovery.persistence).toBe(true);
  });

  test('an audit-mode policy engine is reported as auditing, not as verified', async () => {
    // Core decides what enforcing means, so no adapter answers
    // `verifiedDeploy`.
    const { adapter } = adapterFor({
      lists: {
        clusterpolicies: [
          {
            apiVersion: 'kyverno.io/v1',
            kind: 'ClusterPolicy',
            metadata: { name: 'verify-images' },
            spec: { validationFailureAction: 'Audit' },
          },
        ],
      },
    });

    const { discovery } = await adapter.inspect(target());
    expect(discovery.policyEngine).toEqual({ installed: true, mode: 'AUDIT' });
    expect(discovery).not.toHaveProperty('verifiedDeploy');
  });

  test('an enforcing rule is enough, wherever the field lives', async () => {
    const { adapter } = adapterFor({
      lists: {
        clusterpolicies: [
          {
            apiVersion: 'kyverno.io/v1',
            kind: 'ClusterPolicy',
            metadata: { name: 'verify-images' },
            spec: { rules: [{ validate: { failureAction: 'Enforce' } }] },
          },
        ],
      },
    });
    const { discovery } = await adapter.inspect(target());
    expect(discovery.policyEngine.mode).toBe('ENFORCE');
  });

  test('the stated facts are reported as stated, never inferred', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(
      target({
        servedHosts: ['registry.example.test'],
        reachableRegistries: ['registry.example.test'],
        logHistorySeconds: 3_600,
      }),
    );
    // Neither can be discovered from inside the cluster.
    expect(discovery.servedHosts).toEqual(['registry.example.test']);
    expect(discovery.logHistorySeconds).toBe(3_600);
    expect(discovery).not.toHaveProperty('offlineDeploy');
  });

  test('an unstated log reach is zero, not a guess', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(target());
    expect(discovery.logHistorySeconds).toBe(0);
  });

  test('the stores it can reach come from what the cluster carries', async () => {
    const { adapter } = adapterFor({
      lists: {
        clustersecretstores: [
          {
            apiVersion: 'external-secrets.io/v1',
            kind: 'ClusterSecretStore',
            metadata: { name: 'one' },
            spec: { provider: { onepassword: {} } },
          },
          {
            apiVersion: 'external-secrets.io/v1',
            kind: 'ClusterSecretStore',
            metadata: { name: 'two' },
            spec: { provider: { gcpsm: {} } },
          },
        ],
      },
    });
    const { discovery } = await adapter.inspect(target());
    expect([...discovery.reachableSecretStores].sort()).toEqual([
      'gcp-secret-manager',
      'onepassword',
    ]);
  });
});

describe('runtime log tail', () => {
  test('replays after an opaque cursor without duplicate lines across adapter restart', async () => {
    const podObject: FakeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'blog-web-abc',
        namespace: 'apps',
        labels: {
          'app.kubernetes.io/name': 'web',
          'app.kubernetes.io/part-of': 'blog',
          'spindrift.dev/deploy': '41',
        },
      },
    };
    const cluster = new FakeKubernetes({
      lists: { pods: [podObject] },
      logs: (_pod, reads) =>
        reads === 1
          ? '2026-07-29T12:00:00Z first\n2026-07-29T12:00:01Z second\n'
          : '2026-07-29T12:00:00Z first\n2026-07-29T12:00:01Z second\n2026-07-29T12:00:02Z third\n',
    });
    const firstAdapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: cluster.token,
      fetch: cluster.fetch,
    });
    const first = await firstAdapter.tail(target({ logHistorySeconds: 3600 }), {
      app: 'blog',
      component: 'web',
    });
    expect(first.kind).toBe('stream');
    if (first.kind !== 'stream') return;
    expect(first.entries.map((entry) => entry.line)).toEqual([
      'first',
      'second',
    ]);
    expect(first.reach).toBe(3600);
    const initialLogRead = cluster.requests.find((request) =>
      request.path.endsWith('/log'),
    );
    expect(initialLogRead?.query).toContain('tailLines=200');
    expect(initialLogRead?.query).toContain('limitBytes=262144');

    const restartedAdapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: cluster.token,
      fetch: cluster.fetch,
    });
    const resumed = await restartedAdapter.tail(
      target({ logHistorySeconds: 3600 }),
      { app: 'blog', component: 'web' },
      { after: first.cursor ?? undefined },
    );
    expect(resumed.kind).toBe('stream');
    if (resumed.kind !== 'stream') return;
    expect(resumed.entries.map((entry) => entry.line)).toEqual(['third']);
    expect(resumed.entries[0]?.replica).toBe('blog-web-abc');
    expect(resumed.entries[0]?.deployId).toBe('41');
    const resumedLogRead = cluster.requests
      .filter((request) => request.path.endsWith('/log'))
      .at(-1);
    expect(resumedLogRead?.query).toContain(
      'sinceTime=2026-07-29T12%3A00%3A01.000Z',
    );
  });

  test('a same-pod container restart starts a new cursor generation', async () => {
    const podObject: FakeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'blog-web-abc',
        namespace: 'apps',
        uid: 'pod-uid',
        labels: {
          'app.kubernetes.io/name': 'web',
          'app.kubernetes.io/part-of': 'blog',
        },
      },
      status: {
        containerStatuses: [{ name: 'app', restartCount: 0 }],
      },
    };
    const cluster = new FakeKubernetes({
      lists: { pods: [podObject] },
      logs: (_pod, reads) =>
        reads === 1
          ? '2026-07-29T12:00:00Z old one\n2026-07-29T12:00:01Z old two\n'
          : '2026-07-29T12:01:00Z new one\n2026-07-29T12:01:01Z new two\n',
    });
    const adapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: cluster.token,
      fetch: cluster.fetch,
    });
    const first = await adapter.tail(target(), {
      app: 'blog',
      component: 'web',
    });
    if (first.kind !== 'stream') return;
    (podObject.status as { containerStatuses: { restartCount: number }[] })
      .containerStatuses[0]!.restartCount = 1;

    const resumed = await adapter.tail(
      target(),
      { app: 'blog', component: 'web' },
      { after: first.cursor ?? undefined },
    );
    expect(resumed.kind).toBe('stream');
    if (resumed.kind !== 'stream') return;
    expect(resumed.entries.map((entry) => entry.line)).toEqual([
      'new one',
      'new two',
    ]);
  });
});

/**
 * Through `KubernetesApi` directly: `list` returns `null` for a kind the
 * cluster does not serve and `[]` for a served kind holding nothing.
 */
describe('what the API answers about a kind', () => {
  const apiFor = (options: FakeKubernetesOptions = {}) => {
    const cluster = new FakeKubernetes({ servedKinds: SERVED, ...options });
    return {
      cluster,
      api: new KubernetesApi({
        apiServer: cluster.apiServer,
        token: cluster.token,
        fetch: cluster.fetch,
      }),
    };
  };

  test('a served kind holding nothing is an empty list, not an absent kind', async () => {
    const { api } = apiFor();
    expect(
      await api.list({
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        plural: 'helmreleases',
        namespace: 'delivery',
      }),
    ).toEqual([]);
  });

  test('a kind the cluster does not serve is null, which §13 turns on', async () => {
    const { api } = apiFor({ servedKinds: {} });
    expect(
      await api.list({
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        plural: 'helmreleases',
        namespace: 'delivery',
      }),
    ).toBeNull();
  });

  test('the cluster filters by the selector, so a wrong one finds nothing', async () => {
    const { api } = apiFor({
      lists: { pods: [pod('CrashLoopBackOff', 'back-off')] },
    });
    const listWith = (labelSelector: string) =>
      api.list(
        { apiVersion: 'v1', plural: 'pods', namespace: 'apps' },
        {
          labelSelector,
        },
      );

    expect(
      await listWith(
        'app.kubernetes.io/name=web,app.kubernetes.io/part-of=blog',
      ),
    ).toHaveLength(1);
    // Only the chart's two `selectorLabels` keys select its pods.
    expect(await listWith('app.kubernetes.io/instance=blog-web')).toEqual([]);
  });

  test('deleting what is already gone succeeds, on a cluster that says 404', async () => {
    const { api, cluster } = apiFor();
    // The fake answers `404`, and the client still returns normally.
    await api.delete({
      apiVersion: 'helm.toolkit.fluxcd.io/v2',
      plural: 'helmreleases',
      namespace: 'delivery',
      name: 'never-existed',
    });
    expect(cluster.pathsOf('DELETE')).toHaveLength(1);
  });
});

describe('a write is an apply only if it says so', () => {
  const patch = async (
    headers: Record<string, string>,
    query: string,
  ): Promise<number> => {
    const cluster = new FakeKubernetes({ servedKinds: SERVED });
    const response = await cluster.fetch(
      new Request(
        `${cluster.apiServer}/apis/helm.toolkit.fluxcd.io/v2/namespaces/delivery/helmreleases/blog-web${query}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer federated-token', ...headers },
          body: JSON.stringify({
            apiVersion: 'helm.toolkit.fluxcd.io/v2',
            kind: 'HelmRelease',
            metadata: { name: 'blog-web', namespace: 'delivery' },
          }),
        },
      ),
    );
    return response.status;
  };

  test('a merge patch is refused: the media type is what makes it an apply', async () => {
    expect(
      await patch(
        { 'Content-Type': 'application/json' },
        '?fieldManager=spindrift',
      ),
    ).toBe(415);
  });

  test('an apply with no field manager is refused: the fields must belong to someone', async () => {
    expect(
      await patch({ 'Content-Type': 'application/apply-patch+yaml' }, ''),
    ).toBe(400);
  });

  test('both together are what the adapter sends, and are accepted', async () => {
    expect(
      await patch(
        { 'Content-Type': 'application/apply-patch+yaml' },
        '?fieldManager=spindrift&force=true',
      ),
    ).toBe(200);
  });
});

/**
 * The probe reads a cluster from its address alone. A cluster whose RBAC has
 * not merged yet refuses some reads, and each refusal empties only its list.
 */
describe('probing a cluster before it is a Target', () => {
  const gateway = (
    namespace: string,
    name: string,
    addresses?: { type: string; value: string }[],
  ): FakeObject => ({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'Gateway',
    metadata: { name, namespace },
    ...(addresses === undefined ? {} : { status: { addresses } }),
  });

  const namespace = (name: string): FakeObject => ({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name },
  });

  const source = (namespace: string, name: string): FakeObject => ({
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'GitRepository',
    metadata: { name, namespace },
  });

  const store = (name: string): FakeObject => ({
    apiVersion: 'external-secrets.io/v1',
    kind: 'ClusterSecretStore',
    metadata: { name },
  });

  const probed = async (
    options: FakeKubernetesOptions = {},
    chart: string = CHART,
  ) => {
    const { adapter, cluster } = adapterFor(
      {
        servedKinds: {
          ...SERVED,
          'source.toolkit.fluxcd.io/v1': ['GitRepository', 'OCIRepository'],
          'external-secrets.io/v1': ['ClusterSecretStore'],
          'gateway.networking.k8s.io/v1': ['Gateway'],
        },
        ...options,
      },
      chart,
    );
    return adapter.probe(cluster.apiServer);
  };

  test('offers what the cluster runs, as lists to choose from', async () => {
    const probe = await probed({
      lists: {
        namespaces: [namespace('apps'), namespace('delivery')],
        gitrepositories: [source('delivery', 'charts')],
        clustersecretstores: [store('vault')],
        gateways: [
          gateway('edge', 'shared', [{ type: 'IPAddress', value: '10.0.0.9' }]),
        ],
      },
    });

    expect(probe.reachable).toBe(true);
    expect(probe.deliveryFlavours).toEqual([
      'flux-helmrelease',
      'argo-application',
    ]);
    expect(probe.namespaces).toEqual(['apps', 'delivery']);
    expect(probe.chartSources).toEqual([
      { name: 'charts', namespace: 'delivery' },
    ]);
    expect(probe.secretStores).toEqual(['vault']);
    expect(probe.gateways).toEqual([
      { name: 'shared', namespace: 'edge', address: '10.0.0.9' },
    ]);
  });

  test('the sources offered are the kind this installation’s chart needs', async () => {
    // A GitRepository offered to an OCI installation would make a Target that
    // cannot deploy.
    const lists = {
      gitrepositories: [source('delivery', 'charts')],
      ocirepositories: [
        {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'OCIRepository',
          metadata: { name: 'spindrift-app', namespace: 'apps' },
        },
      ],
    };

    expect((await probed({ lists })).chartSources).toEqual([
      { name: 'charts', namespace: 'delivery' },
    ]);
    expect((await probed({ lists }, OCI_CHART)).chartSources).toEqual([
      { name: 'spindrift-app', namespace: 'apps' },
    ]);
  });

  test('a gateway with only a hostname offers no address to publish', async () => {
    // `platform.dns.privateAddress` is published as an A record, so a hostname
    // cannot fill it.
    const probe = await probed({
      lists: {
        gateways: [
          gateway('edge', 'named', [
            { type: 'Hostname', value: 'edge.invalid' },
          ]),
        ],
      },
    });

    expect(probe.gateways).toEqual([
      { name: 'named', namespace: 'edge', address: null },
    ]);
  });

  test('a kind this cluster does not serve is an empty list, not a failure', async () => {
    const probe = await probed({ servedKinds: {} });

    expect(probe.reachable).toBe(true);
    expect(probe.deliveryFlavours).toEqual([]);
    expect(probe.chartSources).toEqual([]);
    expect(probe.gateways).toEqual([]);
  });

  test('an address that does not answer is the one hard failure', async () => {
    const adapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: () => 'federated-token',
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const probe = await adapter.probe('https://nowhere.invalid');

    expect(probe.reachable).toBe(false);
    expect(probe.because).toContain('ECONNREFUSED');
  });
});

function node(arch: string, allocatable: Record<string, string>): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name: `node-${arch}`,
      labels: { 'kubernetes.io/arch': arch },
    },
    status: { allocatable },
  };
}

/**
 * The chart renders every job as a CronJob, suspended when unscheduled, so a
 * run is a Job built from its `jobTemplate` and owned by it.
 */
describe('a job is run, and its runs are read', () => {
  const RUN_AT = Date.UTC(2026, 7, 4, 12, 0, 0);
  const JOB_LABELS = {
    'app.kubernetes.io/name': 'nightly',
    'app.kubernetes.io/part-of': 'blog',
  };
  const REF = 'flux-helmrelease:delivery/blog-nightly';

  /**
   * Runs are found through `targetNamespace`, which some releases set to a
   * shared namespace instead of the App's own.
   */
  const release: FakeObject = {
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: 'blog-nightly', namespace: 'delivery' },
    spec: {
      targetNamespace: 'apps',
      values: {
        app: { name: 'blog', component: 'nightly', kind: 'job' },
      },
    },
  };

  const jobTemplate = {
    metadata: { labels: JOB_LABELS },
    spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
  };

  const cronJob: FakeObject = {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: 'blog-nightly',
      namespace: 'apps',
      uid: 'cron-uid-1',
      labels: JOB_LABELS,
    },
    spec: { suspend: true, schedule: '0 0 31 2 *', jobTemplate },
  };

  function ranJob(
    name: string,
    overrides: { startTime?: string; conditions?: unknown[] } = {},
  ): FakeObject {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace: 'apps', labels: JOB_LABELS },
      status: {
        ...(overrides.startTime === undefined
          ? {}
          : { startTime: overrides.startTime }),
        ...(overrides.conditions === undefined
          ? {}
          : { conditions: overrides.conditions }),
      },
    };
  }

  function cluster(objects: Record<string, FakeObject> = {}): FakeKubernetes {
    return new FakeKubernetes({
      servedKinds: { ...SERVED, 'batch/v1': ['CronJob', 'Job'] },
      objects: {
        'helmreleases/delivery/blog-nightly': release,
        'cronjobs/apps/blog-nightly': cronJob,
        ...objects,
      },
      // The default script would write a ready HelmRelease's status onto every
      // Job read.
      status: () => null,
    });
  }

  function adapterFor(far: FakeKubernetes): KubernetesDeployAdapter {
    return new KubernetesDeployAdapter({
      chart: CHART,
      token: far.token,
      fetch: far.fetch,
      now: () => RUN_AT,
    });
  }

  test('starts a Job from the CronJob template, owned by the CronJob', async () => {
    const far = cluster();
    const started = await adapterFor(far).run(target(), REF);

    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    expect(started.execution.outcome).toBe('running');

    const created = far.get(`jobs/apps/${started.execution.name}`);
    expect(created?.kind).toBe('Job');
    expect(created?.spec).toEqual(jobTemplate.spec);
    expect(created?.metadata.labels).toEqual(JOB_LABELS);
    expect(created?.metadata.annotations).toEqual({
      'cronjob.kubernetes.io/instantiate': 'manual',
    });
    // Owned, so the CronJob's history limits prune it like any other run.
    expect(created?.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        name: 'blog-nightly',
        uid: 'cron-uid-1',
        controller: true,
      },
    ]);
  });

  test("puts this run's parameters on the container after the template's own, and their names on the Job", async () => {
    // Appended, since the kubelet takes a duplicated name's last entry. Only
    // the names go on the Job, as the annotation the timeline reads.
    const template = {
      metadata: { labels: JOB_LABELS },
      spec: {
        backoffLimit: 0,
        template: {
          spec: {
            containers: [
              { name: 'app', env: [{ name: 'TMPDIR', value: '/tmp' }] },
            ],
          },
        },
      },
    };
    const spec = {
      suspend: true,
      schedule: '0 0 31 2 *',
      jobTemplate: template,
    };
    const far = cluster({
      'cronjobs/apps/blog-nightly': { ...cronJob, spec },
    });

    const started = await adapterFor(far).run(target(), REF, {
      env: { SNAPSHOT: 'nightly-2026-08-03', SINCE: '2026-08-01' },
    });

    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    const created = far.get(`jobs/apps/${started.execution.name}`);
    expect(created?.spec).toEqual({
      backoffLimit: 0,
      template: {
        spec: {
          containers: [
            {
              name: 'app',
              env: [
                { name: 'TMPDIR', value: '/tmp' },
                { name: 'SNAPSHOT', value: 'nightly-2026-08-03' },
                { name: 'SINCE', value: '2026-08-01' },
              ],
            },
          ],
        },
      },
    });
    expect(created?.metadata.annotations).toEqual({
      'cronjob.kubernetes.io/instantiate': 'manual',
      'spindrift.dev/run-with': 'SNAPSHOT, SINCE',
    });
    // The next scheduled fire must not inherit this run's parameters.
    expect(far.get('cronjobs/apps/blog-nightly')?.spec).toEqual(spec);
  });

  test('a run without parameters is the template, verbatim, with no annotation for them', async () => {
    const far = cluster();
    const started = await adapterFor(far).run(target(), REF, { env: {} });

    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    const created = far.get(`jobs/apps/${started.execution.name}`);
    expect(created?.spec).toEqual(jobTemplate.spec);
    expect(created?.metadata.annotations).toEqual({
      'cronjob.kubernetes.io/instantiate': 'manual',
    });
  });

  test('leaves the CronJob suspended — running now is not scheduling', async () => {
    const far = cluster();
    await adapterFor(far).run(target(), REF);

    expect(far.get('cronjobs/apps/blog-nightly')?.spec).toEqual({
      suspend: true,
      schedule: '0 0 31 2 *',
      jobTemplate,
    });
  });

  test('a second press in the same second is the same run, not a second one', async () => {
    const far = cluster();
    const adapter = adapterFor(far);
    const first = await adapter.run(target(), REF);
    const second = await adapter.run(target(), REF);

    expect(second.kind).toBe('started');
    if (first.kind !== 'started' || second.kind !== 'started') return;
    expect(second.execution.name).toBe(first.execution.name);
    expect(far.all('jobs')).toHaveLength(1);
  });

  test('a create the API server 404s is a fault, not a started run', async () => {
    // Creating a Job answers `404` when the namespace is gone or `batch/v1` is
    // not served, and nothing is stored.
    const far = cluster();
    const adapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: far.token,
      fetch: async (request) =>
        request.method === 'POST' &&
        new URL(request.url).pathname.endsWith('/jobs')
          ? new Response('{"kind":"Status","code":404}', { status: 404 })
          : far.fetch(request),
      now: () => RUN_AT,
    });

    // Awaited, or the next assertion runs before `run` issues its `POST`.
    await expect(adapter.run(target(), REF)).rejects.toThrow(/404/);
    expect(far.all('jobs')).toHaveLength(0);
  });

  test('refuses a Component that is not a job, in a sentence', async () => {
    const far = new FakeKubernetes({
      servedKinds: { ...SERVED, 'batch/v1': ['CronJob', 'Job'] },
      objects: {
        'helmreleases/delivery/blog-web': {
          apiVersion: 'helm.toolkit.fluxcd.io/v2',
          kind: 'HelmRelease',
          metadata: { name: 'blog-web', namespace: 'delivery' },
          spec: {
            values: {
              app: { name: 'blog', component: 'web', kind: 'service' },
            },
          },
        },
      },
      status: () => null,
    });
    const refused = await adapterFor(far).run(
      target(),
      'flux-helmrelease:delivery/blog-web',
    );

    expect(refused).toEqual({
      kind: 'none',
      because: 'this Component is not a job, so it has no runs',
    });
  });

  test('lists the runs that happened, newest first, with their outcome', async () => {
    const far = cluster({
      'jobs/apps/blog-nightly-1': ranJob('blog-nightly-1', {
        startTime: '2026-08-01T00:00:00Z',
        conditions: [
          {
            type: 'Complete',
            status: 'True',
            reason: 'CompletionsReached',
            message: 'all tasks completed',
          },
        ],
      }),
      'jobs/apps/blog-nightly-2': ranJob('blog-nightly-2', {
        startTime: '2026-08-02T00:00:00Z',
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'the container exited 1',
          },
        ],
      }),
      'jobs/apps/blog-nightly-3': ranJob('blog-nightly-3', {
        startTime: '2026-08-03T00:00:00Z',
        // `SuccessCriteriaMet` is the controller narrating, not a verdict.
        conditions: [{ type: 'SuccessCriteriaMet', status: 'True' }],
      }),
    });

    const runs = await adapterFor(far).executions(target(), REF);

    expect(runs.kind).toBe('executions');
    if (runs.kind !== 'executions') return;
    expect(
      runs.executions.map((execution) => [execution.name, execution.outcome]),
    ).toEqual([
      ['blog-nightly-3', 'running'],
      ['blog-nightly-2', 'failed'],
      ['blog-nightly-1', 'passed'],
    ]);
    expect(runs.executions[1]?.detail).toBe('the container exited 1');
  });

  test('a list the API server 404s is a fault, not a job that never ran', async () => {
    // A `404` here means the namespace is gone or `batch/v1` is not served,
    // which must not read as an empty history.
    const far = new FakeKubernetes({
      // `CronJob` served and `Job` not, so only the `list jobs` call fails.
      servedKinds: { ...SERVED, 'batch/v1': ['CronJob'] },
      objects: {
        'helmreleases/delivery/blog-nightly': release,
        'cronjobs/apps/blog-nightly': cronJob,
      },
      status: () => null,
    });

    await expect(adapterFor(far).executions(target(), REF)).rejects.toThrow(
      /404/,
    );
  });

  test('reads the names a run was started with back into its line, never the values', async () => {
    const far = cluster({
      'jobs/apps/blog-nightly-9': {
        ...ranJob('blog-nightly-9', {
          startTime: '2026-08-03T00:00:00Z',
          conditions: [
            {
              type: 'Complete',
              status: 'True',
              reason: 'CompletionsReached',
              message: 'all tasks completed',
            },
          ],
        }),
        metadata: {
          name: 'blog-nightly-9',
          namespace: 'apps',
          labels: JOB_LABELS,
          annotations: { 'spindrift.dev/run-with': 'SNAPSHOT, SINCE' },
        },
        spec: {
          template: {
            spec: {
              containers: [
                { env: [{ name: 'SNAPSHOT', value: 'nightly-2026-08-03' }] },
              ],
            },
          },
        },
      },
    });

    const runs = await adapterFor(far).executions(target(), REF);

    expect(runs.kind).toBe('executions');
    if (runs.kind !== 'executions') return;
    expect(runs.executions[0]?.detail).toBe(
      'ran with SNAPSHOT, SINCE · all tasks completed',
    );
    expect(JSON.stringify(runs)).not.toContain('nightly-2026-08-03');
  });

  test("reads one run's logs rather than the Component's whole output", async () => {
    const far = new FakeKubernetes({
      servedKinds: { ...SERVED, 'batch/v1': ['CronJob', 'Job'] },
      lists: {
        pods: [
          runPod('blog-nightly-2-xyz', 'blog-nightly-2'),
          runPod('blog-nightly-1-abc', 'blog-nightly-1'),
        ],
      },
      logs: (name) => `2026-08-04T12:00:00Z from ${name}\n`,
    });
    const page = await adapterFor(far).tail(target(), {
      app: 'blog',
      component: 'nightly',
      execution: 'blog-nightly-2',
    });

    expect(page.kind).toBe('stream');
    if (page.kind !== 'stream') return;
    // The cluster filters, so only the named run's pod comes back.
    expect(page.entries.map((entry) => entry.line)).toEqual([
      'from blog-nightly-2-xyz',
    ]);
  });

  /** A pod of one run, labelled the way the Job controller labels one. */
  function runPod(name: string, run: string): FakeObject {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: 'apps',
        labels: { ...JOB_LABELS, 'batch.kubernetes.io/job-name': run },
      },
    };
  }
});

describe('restart', () => {
  const RESTART_AT = Date.UTC(2026, 7, 23, 12, 0, 0);
  const STAMPED = new Date(RESTART_AT).toISOString();
  const REF = 'flux-helmrelease:delivery/blog-web';

  const release: FakeObject = {
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: 'blog-web',
      namespace: 'delivery',
      resourceVersion: '12',
      labels: { 'app.kubernetes.io/managed-by': 'spindrift' },
    },
    spec: {
      targetNamespace: 'apps',
      values: {
        app: {
          name: 'blog',
          component: 'web',
          kind: 'service',
          artifactDigest: 'sha256:feed',
        },
        shared: {
          resources: { requests: { cpu: '250m' } },
          podAnnotations: { 'example.com/owner': 'ops' },
        },
      },
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  };

  function cluster(objects: Record<string, FakeObject> = {}): FakeKubernetes {
    return new FakeKubernetes({
      servedKinds: SERVED,
      objects: { 'helmreleases/delivery/blog-web': release, ...objects },
      // The default script would write a ready status onto every read.
      status: () => null,
    });
  }

  function adapterAt(
    far: FakeKubernetes,
    now: () => number = () => RESTART_AT,
  ): KubernetesDeployAdapter {
    return new KubernetesDeployAdapter({
      chart: CHART,
      token: far.token,
      fetch: far.fetch,
      now,
    });
  }

  function stampOf(far: FakeKubernetes): string | undefined {
    const values = renderedValues(far) as RenderedValues & {
      shared: { podAnnotations?: Record<string, string> };
    };
    return values.shared.podAnnotations?.[RESTART_STAMP];
  }

  test('stamps the pod template through the shared values, keeping the operator’s annotation and the digest', async () => {
    const far = cluster();
    const restarted = await adapterAt(far).restart(target(), REF);

    expect(restarted.kind).toBe('restarted');
    if (restarted.kind !== 'restarted') return;
    expect(restarted.detail).toContain(`${RESTART_STAMP}=${STAMPED}`);

    const values = renderedValues(far) as RenderedValues & {
      shared: { podAnnotations?: Record<string, string> };
    };
    // One key added to the operator's map, never the map replaced.
    expect(values.shared.podAnnotations).toEqual({
      'example.com/owner': 'ops',
      [RESTART_STAMP]: STAMPED,
    });
    expect(values.shared.resources).toEqual({ requests: { cpu: '250m' } });
    // The same digest, so `observe` reads no drift.
    expect(values.app.artifactDigest).toBe('sha256:feed');
  });

  test('the write is a server-side apply of what Spindrift owns, under the version it read', async () => {
    const far = cluster();
    await adapterAt(far).restart(target(), REF);

    const [patch] = far.requests.filter(
      (request) => request.method === 'PATCH',
    );
    expect(patch?.contentType).toBe('application/apply-patch+yaml');
    const body = patch?.body as FakeObject;
    // A deploy written between the read and this write must 409, not be
    // reverted.
    expect(body.metadata.resourceVersion).toBe('12');
    expect(body.metadata.labels).toEqual({
      'app.kubernetes.io/managed-by': 'spindrift',
    });
    // Nothing the API server owns is sent to be claimed.
    expect(body).not.toHaveProperty('status');
  });

  test('a deploy that lands between the read and the write is a 409, thrown', async () => {
    const far = cluster();
    const adapter = new KubernetesDeployAdapter({
      chart: CHART,
      token: far.token,
      fetch: async (request) => {
        const response = await far.fetch(request);
        // The concurrent deploy: the object moves on after this read served.
        if (request.method === 'GET') {
          far.place('helmreleases/delivery/blog-web', {
            ...release,
            metadata: { ...release.metadata, resourceVersion: '13' },
          });
        }
        return response;
      },
      now: () => RESTART_AT,
    });

    await expect(adapter.restart(target(), REF)).rejects.toThrow(
      /409.*the object has been modified/,
    );
    expect(far.pathsOf('PATCH')).toHaveLength(1);
    expect(stampOf(far)).toBeUndefined();
  });

  test('a second restart moves the stamp', async () => {
    const far = cluster();
    let now = RESTART_AT;
    const adapter = adapterAt(far, () => {
      now += 60_000;
      return now;
    });

    await adapter.restart(target(), REF);
    const first = stampOf(far);
    await adapter.restart(target(), REF);

    expect(first).toBeDefined();
    expect(stampOf(far)).not.toBe(first);
  });

  test('refuses a job, in a sentence', async () => {
    const far = cluster({
      'helmreleases/delivery/blog-nightly': {
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        kind: 'HelmRelease',
        metadata: { name: 'blog-nightly', namespace: 'delivery' },
        spec: {
          values: { app: { name: 'blog', component: 'nightly', kind: 'job' } },
        },
      },
    });

    expect(
      await adapterAt(far).restart(
        target(),
        'flux-helmrelease:delivery/blog-nightly',
      ),
    ).toEqual({
      kind: 'none',
      because:
        'this Component is a job, which has runs rather than a process to restart',
    });
    expect(far.pathsOf('PATCH')).toEqual([]);
  });

  test('a ref that names nothing on the Target is refused, not written', async () => {
    const far = cluster();

    expect(
      await adapterAt(far).restart(target(), 'flux-helmrelease:delivery/gone'),
    ).toEqual({ kind: 'none', because: 'gone is no longer on this Target' });
    expect(far.pathsOf('PATCH')).toEqual([]);
  });

  test('the Argo flavour is stamped where it keeps its values', async () => {
    const far = cluster({
      'applications/delivery/blog-web': {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: 'blog-web', namespace: 'delivery' },
        spec: {
          project: 'default',
          destination: { namespace: 'apps' },
          source: {
            repoURL: 'https://git.example.test/infra',
            path: CHART,
            helm: {
              releaseName: 'blog-web',
              valuesObject: {
                app: { name: 'blog', component: 'web', kind: 'service' },
                shared: {},
              },
            },
          },
        },
      },
    });

    const restarted = await adapterAt(far).restart(
      target({ delivery: ARGO }),
      'argo-application:delivery/blog-web',
    );

    expect(restarted.kind).toBe('restarted');
    const spec = far.get('applications/delivery/blog-web')?.spec as {
      source: {
        repoURL: string;
        path: string;
        helm: {
          releaseName: string;
          valuesObject: { shared: { podAnnotations: Record<string, string> } };
        };
      };
    };
    expect(spec.source.helm.valuesObject.shared.podAnnotations).toEqual({
      [RESTART_STAMP]: STAMPED,
    });
    expect(spec.source.repoURL).toBe('https://git.example.test/infra');
    expect(spec.source.path).toBe(CHART);
    expect(spec.source.helm.releaseName).toBe('blog-web');
  });
});
