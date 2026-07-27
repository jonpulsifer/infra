/**
 * The Kubernetes deploy adapter (Task 17, §6, §7).
 *
 * Every test drives the real adapter against a fake of the cluster's HTTP API
 * (§ Seam 2) and asserts what a cluster would have been sent, or what the
 * adapter concluded from what it was told. Nothing here reaches core: the
 * command layer is Seam 1 and has its own tests.
 *
 * The claims worth stating up front, because each is a rule §6 or §7 makes
 * that a plausible implementation would break:
 *
 * - Spindrift applies a delivery object **through the API**, with **one inline
 *   values blob** — never a values ConfigMap, which Flux overwrites and Argo
 *   has no equivalent for.
 * - **The Target declares the flavour**, so the same `DesiredState` produces a
 *   `HelmRelease` on one Target and an Argo `Application` on another.
 * - Phase transitions come from the controller. The adapter polls; it never
 *   decides that something is ready.
 * - **On red it reads pods and events once** and fills in the reason — which is
 *   what turns "InstallFailed" into `ARTIFACT_UNAVAILABLE` with the blame on
 *   the platform rather than on the developer's code.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor } from '../../src/adapters/deploy/contract.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { VALUES_CONTRACT } from '../../src/adapters/deploy/kubernetes/values.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import type {
  KubernetesConnection,
  KubernetesDelivery,
} from '../../src/domain/target.ts';
import {
  FakeKubernetes,
  type FakeKubernetesOptions,
  type FakeObject,
  type StatusScript,
} from '../harness/fakes/kubernetes-api.ts';

const CHART = 'example/spindrift-app';

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

/** A cluster that serves everything the checklist looks for. */
const SERVED = {
  'helm.toolkit.fluxcd.io/v2': ['HelmRelease'],
  'argoproj.io/v1alpha1': ['Application'],
  'postgresql.cnpg.io/v1': ['Cluster'],
  'cilium.io/v2': ['CiliumNetworkPolicy'],
  'kyverno.io/v1': ['ClusterPolicy'],
};

function connection(
  overrides: Partial<KubernetesConnection> = {},
): KubernetesConnection {
  return {
    adapter: 'kubernetes',
    apiServer: 'https://cluster.example.test',
    namespace: 'apps',
    delivery: FLUX,
    chartContract: VALUES_CONTRACT,
    ...overrides,
  };
}

function target(
  connectionOverrides: Partial<KubernetesConnection> = {},
): DeployTarget {
  return {
    name: 'cluster',
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
    exposure: 'private',
    config: [],
    requirements: {
      platform: { os: 'linux', arch: 'amd64' },
      resources: { cpu: '250m', memory: '256Mi' },
    },
    hostname: { canonical: 'blog-web.apps.example.test' },
    ...overrides,
  };
}

/** The adapter, wired to one fake cluster, with the cadence spent instantly. */
function adapterFor(options: FakeKubernetesOptions = {}): {
  adapter: KubernetesDeployAdapter;
  cluster: FakeKubernetes;
} {
  const cluster = new FakeKubernetes({ servedKinds: SERVED, ...options });
  const adapter = new KubernetesDeployAdapter({
    chart: CHART,
    token: cluster.token,
    fetch: cluster.fetch,
    pollIntervalMs: 1,
    // A test must not spend the cadence it is asserting about, and a fake
    // clock is also what makes the timeout case finite.
    sleep: async () => {},
  });
  return { adapter, cluster };
}

interface RenderedValues {
  platform: { runtimeClassName?: string };
  shared: { resources?: unknown; podLabels?: unknown };
  app: {
    artifactDigest?: string;
    hostnames?: readonly string[];
    kind?: string;
  };
}

/** The inline values on the Flux object, failing clearly if apply wrote none. */
function renderedValues(cluster: FakeKubernetes): RenderedValues {
  const release = cluster.get('helmreleases/delivery/blog-web');
  const spec = release?.spec as { values?: RenderedValues } | undefined;
  if (spec?.values === undefined) {
    throw new Error('expected the HelmRelease to carry inline values');
  }
  return spec.values;
}

/** Drive a stream to its verdict, collecting the timeline. */
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

/** A pod in one waiting state, as the API reports it. */
function pod(reason: string, message: string): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'blog-web-abc', namespace: 'apps' },
    status: {
      containerStatuses: [
        { name: 'app', ready: false, state: { waiting: { reason, message } } },
      ],
    },
  };
}

/** A `HelmRelease` that failed without saying why — the read-on-red case. */
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
    // §7: one inline values blob. A values ConfigMap is dead as a portable
    // mechanism — Flux merges `valuesFrom` and then overwrites it inline.
    expect(spec.values.app.image).toBe(
      'registry.example.test/blog/web@sha256:feed',
    );
    expect(spec.valuesFrom).toBeUndefined();
    expect(cluster.all('configmaps')).toEqual([]);

    // The chart comes from the Target's own repository until the OCI swap.
    expect(spec.chart.spec.chart).toBe(CHART);
    expect(spec.chart.spec.sourceRef).toEqual({
      kind: 'GitRepository',
      name: 'charts',
      namespace: 'delivery',
    });
    // Reconciliation lives in core: the controller must not retry an attempt
    // nobody asked for (§6).
    expect(spec.install.remediation.retries).toBe(0);
  });

  test('the write is a server-side apply, attributed to Spindrift', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(adapter.apply(target(), desiredState()));

    const write = cluster.requests.find(
      (request) => request.method === 'PATCH',
    );
    expect(write?.contentType).toBe('application/apply-patch+yaml');
    expect(write?.path).toBe(
      '/apis/helm.toolkit.fluxcd.io/v2/namespaces/delivery/helmreleases/blog-web',
    );
  });

  test('the Target declares the flavour: the same state, an Argo Application', async () => {
    const { adapter, cluster } = adapterFor({
      status: () => ({
        health: { status: 'Healthy' },
        sync: { status: 'Synced' },
      }),
    });
    const { verdict } = await drain(
      adapter.apply(target({ delivery: ARGO }), desiredState()),
    );

    expect(verdict.phase).toBe('LIVE');
    const applied = cluster.get('applications/delivery/blog-web');
    expect(applied?.kind).toBe('Application');
    const spec = applied?.spec as any;
    expect(spec.source.helm.valuesObject.app.component).toBe('web');
    expect(spec.destination.namespace).toBe('apps');
    // The namespace is vessel (§7): a sync that created it would let a
    // `destroy()` remove it.
    expect(spec.syncPolicy.syncOptions).toBeUndefined();
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
    // The operator's class, untouched.
    expect(values.platform.runtimeClassName).toBe('gvisor');
    // The shared class: Spindrift's requests replace the operator's key,
    // and the keys Spindrift has no opinion about survive.
    expect(values.shared.resources).toEqual({
      requests: { cpu: '250m', memory: '256Mi' },
    });
    expect(values.shared.podLabels).toEqual({ tier: 'web' });
    // Spindrift's own class, rendered from what core described.
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
    expect(values.app.hostnames).toEqual([
      'blog-web.apps.example.test',
      'blog.example.test',
    ]);
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
    // APPLYING once, WAITING once however many times it was polled, LIVE once.
    expect(phases).toEqual(['APPLYING', 'WAITING', 'LIVE']);
  });

  test('a LIVE verdict carries no url — the cluster gives no name of its own', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    // §9: Spindrift mints the canonical name where the platform gives none,
    // which is the metal cluster alone. A url coming back here would be a
    // second naming authority.
    expect(verdict).toEqual({
      phase: 'LIVE',
      ref: 'flux-helmrelease:delivery/blog-web',
    });
  });

  test('a stale status is not read as a verdict', async () => {
    // The object still carries the last generation's Ready=True. An adapter
    // that trusted it would report a re-deploy green before anything was
    // tried.
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
    // §6's table gives TIMEOUT a dash: a deploy that never reached a terminal
    // state indicts nobody.
    expect(blameFor(verdict.reason)).toBeNull();
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

    // Read **once** (§6): one pass over pods and one over events, not a watch.
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
    // §12: the platform will not keep this — cluster events expire in about an
    // hour — so the raw payload comes back for core to store.
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

  test('an expired credential is unreachable, not a rejection', async () => {
    const { adapter } = adapterFor({ token: 'a-different-token' });
    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    // §6 puts "credentials expired" under TARGET_UNREACHABLE explicitly: the
    // developer's app has nothing to do with it.
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
    // Drift is detected by comparing what is serving against the desired row
    // (§6), which only works if `observe` reads the cluster rather than core's
    // memory of what it applied.
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
          metadata: { name: 'apps' },
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

  test('a Target without the GitRepository is unhealthy, and says so', async () => {
    // The plan's named cost: sourcing the chart from a repository makes "a
    // GitRepository in this cluster" a Target prerequisite, and it is the
    // first thing that breaks on extraction.
    const { adapter } = adapterFor({
      objects: {
        'namespaces//apps': {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: 'apps' },
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

  test('a cluster running neither operator cannot deliver anything', async () => {
    const { adapter } = adapterFor({ servedKinds: {} });
    const { prerequisites } = await adapter.inspect(target());
    const operator = prerequisites.find(
      (item) => item.name === 'DELIVERY_OPERATOR',
    );
    expect(operator?.met).toBe(false);
    expect(operator?.detail).toContain('HelmRelease');
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

  test('chart-contract skew is a prerequisite failure, not a silent green', async () => {
    // §7: Helm ignores unknown values silently, so an unrepinned Target would
    // apply cleanly, report green, and run without config.
    const { adapter } = adapterFor();
    const { prerequisites } = await adapter.inspect(
      target({ chartContract: '99' }),
    );
    const contract = prerequisites.find(
      (item) => item.name === 'CHART_CONTRACT',
    );
    expect(contract?.met).toBe(false);
    expect(contract?.detail).toContain(VALUES_CONTRACT);
  });

  test('an unread chart contract is a prerequisite failure', async () => {
    const { adapter } = adapterFor();
    const { prerequisites } = await adapter.inspect(
      target({ chartContract: undefined }),
    );
    const contract = prerequisites.find(
      (item) => item.name === 'CHART_CONTRACT',
    );
    expect(contract?.met).toBe(false);
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
    // The ceiling is the largest single workload the Target admits — one
    // node's allocatable, never the sum, because nothing here schedules.
    expect(discovery.resourceCeiling).toEqual({ cpu: '8', memory: '32768Mi' });
    expect(discovery.persistence).toBe(true);
  });

  test('an audit-mode policy engine is reported as auditing, not as verified', async () => {
    // §32: core decides what enforcing means. An adapter that answered
    // `verifiedDeploy` would let two adapters disagree about it.
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
    // §33's static check is over hosts nobody can discover from inside a
    // cluster, and §18's reach is a property of a log store beside it.
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
