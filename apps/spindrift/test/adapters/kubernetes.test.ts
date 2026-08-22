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
/** The same chart as an artifact — §20's other legal spelling of `charts.app`. */
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

/**
 * The same Target told where {@link OCI_CHART} is served.
 *
 * An Argo Target's repository is the operator's own field, so an installation
 * that declares an artifact needs one naming the registry rather than the git
 * repository a path-sourced installation is checked out of.
 */
const ARGO_OCI: KubernetesDelivery = {
  flavour: 'argo-application',
  namespace: 'delivery',
  project: 'default',
  repoUrl: 'registry.example.test/charts',
  revision: '1.4.0',
  server: 'https://kubernetes.default.svc',
};

/** The status an `Application` reports once Argo has synced it. */
const SYNCED = () => ({
  health: { status: 'Healthy' },
  sync: { status: 'Synced' },
});

/**
 * Everything an Argo Target's checklist needs to be green but the chart.
 *
 * No Flux source object, because this flavour has none to read: Argo fetches
 * the repository itself and the reference lives in the `Application`.
 */
const ARGO_CLUSTER: FakeKubernetesOptions = {
  objects: {
    'namespaces//apps': {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'apps',
        // What the vessel declares admission to mean, and what every App
        // namespace is stamped from.
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

/**
 * A pod as the App chart renders it: stamped with the contract it came from,
 * and carrying the Component labels the chart puts on every pod it renders.
 */
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

/** What the standing checklist concluded about the value contract. */
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

/** The adapter, wired to one fake cluster, with the cadence spent instantly. */
function adapterFor(
  options: FakeKubernetesOptions = {},
  /** How this installation names the App chart — the source kind follows it. */
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
    expose?: boolean;
    hostnames?: readonly string[];
    kind?: string;
    port?: number;
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

/**
 * The labels the chart puts on a pod of this Component.
 *
 * `spindrift-app.selectorLabels` in `packages/charts/spindrift-app`, which is
 * what the adapter's `labelSelector` names. A fixture without them is a pod
 * the cluster would not return for that selector, so they belong on every pod
 * a test expects the read-on-red or the tail to find.
 */
const POD_LABELS = {
  'app.kubernetes.io/name': 'web',
  'app.kubernetes.io/part-of': 'blog',
};

/** A pod in one waiting state, as the API reports it. */
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

/** A pod the chart rendered that came up and never passed readiness. */
function podNotReady(): FakeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'blog-web-abc', namespace: 'apps', labels: POD_LABELS },
    status: { containerStatuses: [{ name: 'app', ready: false, state: {} }] },
  };
}

/**
 * An adapter over a release that reports progress forever, on a clock that
 * reaches the deadline.
 *
 * `adapterFor` cannot serve this: the deadline case needs both a budget and a
 * clock that advances to it, and every other test in the file wants neither.
 */
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

    // A path is a path inside a repository the Target trusts, so the release
    // asks Flux to build a HelmChart from a GitRepository source — the only
    // form that can carry a path at all.
    expect(spec.chart.spec.chart).toBe(CHART);
    expect(spec.chart.spec.sourceRef).toEqual({
      kind: 'GitRepository',
      name: 'charts',
      namespace: 'delivery',
    });
    expect(spec.chartRef).toBeUndefined();
    // Reconciliation lives in core: the controller must not retry an attempt
    // nobody asked for (§6).
    expect(spec.install.remediation.retries).toBe(0);
  });

  test('an oci:// chart is delivered as a chartRef at the Target’s OCIRepository', async () => {
    // The other half of §7's per-Target pin. Flux refuses `chart` and
    // `chartRef` together and its `chart.spec.sourceRef` does not accept an
    // `OCIRepository` at all, so this is not a `kind` swap inside the same
    // shape — the whole reference moves, and nothing is left naming a path
    // that only a checkout of some repository resolves.
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
    // Everything else about the release is the same object it always was: the
    // source moved, not the delivery.
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
    // Both writes are applies, which is what makes each converge on an object
    // that is already there rather than fail on it — a second deploy of the
    // same App must not trip over its own namespace.
    expect(writes.map((write) => write.contentType)).toEqual([
      'application/apply-patch+yaml',
      'application/apply-patch+yaml',
    ]);
    // The App's namespace first, then the release into it. The order is the
    // point: a release applied first would land in a namespace that is not
    // there yet.
    expect(writes.map((write) => write.path)).toEqual([
      '/api/v1/namespaces/app-blog',
      '/apis/helm.toolkit.fluxcd.io/v2/namespaces/delivery/helmreleases/blog-web',
    ]);
  });

  test('the App namespace carries the admission labels the vessel declares', async () => {
    const { adapter, cluster } = adapterFor();
    await drain(adapter.apply(target(), desiredState()));

    // Copied off the Target's declared namespace rather than written from a
    // table here, so an operator who changes what `restricted` means on their
    // cluster changes it for every App without touching Spindrift.
    const namespace = cluster.get('namespaces//app-blog');
    expect(namespace?.metadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/audit': 'restricted',
      'pod-security.kubernetes.io/warn': 'restricted',
    });
  });

  test('a vessel declaring no admission policy gets no App namespace', async () => {
    // The refusal that matters: a namespace created without Pod Security
    // labels admits pods this vessel refuses, which is worse than a deploy
    // that failed and said why. Live driving proved that admission
    // load-bearing twice.
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
    // A path is a directory only a checkout of the repository resolves, which
    // is the form a non-artifact chart reference has here too.
    expect(spec.source.repoURL).toBe('https://git.example.test/infra');
    expect(spec.source.path).toBe(CHART);
    expect(spec.source.chart).toBeUndefined();
    // Argo makes the namespace itself, because Argo is the mechanism that can
    // carry the admission labels — Flux's `createNamespace` takes no metadata
    // at all, which is why Spindrift applies the Namespace on that flavour and
    // not on this one.
    expect(spec.syncPolicy.syncOptions).toEqual(['CreateNamespace=true']);
    expect(spec.syncPolicy.managedNamespaceMetadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'restricted',
    });
    // No tracking annotation, deliberately: tracking it would let a sync
    // delete the namespace and every neighbouring workload in it.
    expect(
      spec.syncPolicy.managedNamespaceMetadata.annotations,
    ).toBeUndefined();
    // And Spindrift wrote no Namespace of its own on this flavour.
    expect(
      cluster.requests.filter((request) =>
        request.path.startsWith('/api/v1/namespaces/app-blog'),
      ),
    ).toEqual([]);
  });

  test('an oci:// chart is an Argo chart reference, never a path', async () => {
    // The Argo half of the same per-Target pin the Flux test above asserts.
    // Argo takes an OCI chart the way Helm's own client does — the registry in
    // `repoURL`, the chart's own name in `chart`, and its documentation is
    // explicit that "the oci:// syntax is not included" — and it refuses a
    // source carrying a `path` beside a `chart`. So an artifact reference
    // written into `path` is not a release: Argo answers `ComparisonError`,
    // and nothing before the first deploy would have said so.
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
    // Everything else about the Application is the object it always was: the
    // source moved, not the delivery.
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
    expect(values.app.expose).toBe(true);
    expect(values.app.port).toBe(8080);
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

  test("the controller's own sentence reaches the timeline, once each", async () => {
    // A Helm upgrade says several different things while staying in one phase,
    // and those sentences are the only progress a reader gets between the
    // phase change and the verdict. Reporting phases alone left minutes of a
    // rollout looking like a stopped screen.
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
    // After the write this adapter reports itself: the repeated poll of an
    // unchanged message does not repeat the line, and the terminal sentence is
    // not echoed here — it travels on the verdict.
    expect(lines).toEqual([
      'applied HelmRelease/delivery/blog-web',
      'pulling chart',
      'running upgrade',
    ]);
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

  test('a deadline reads the namespace, and names what stalled it', async () => {
    const { adapter } = stalling({
      pods: [pod('ImagePullBackOff', 'Back-off pulling image')],
      events: [],
    });

    const { verdict } = await drain(adapter.apply(target(), desiredState()));
    if (verdict.phase !== 'FAILED') throw new Error('expected a failure');
    // The rollout stalled rather than failing, so nothing declared a verdict —
    // but a container backing off its image pull is an ARTIFACT_UNAVAILABLE at
    // the deadline exactly as it is at a failure, and it is the reason §6
    // cares most about getting right.
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
    // The guard on the read: under a *verdict* an empty namespace is REJECTED,
    // because something refused the workload. Under a deadline the same
    // emptiness is equally "not yet" — a chart still resolving, a wedged
    // controller — so it must not indict the developer.
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

  test('an apply the API server 404s is a failure, blamed on the platform', async () => {
    // The write half of the same question the job `create` test asks. A
    // server-side apply into a deleted namespace — or one whose delivery CRD is
    // not installed — answers `404`, and `apply` returns `void`, so a swallowed
    // one was a deploy that placed nothing and went on to poll for a verdict.
    //
    // And it is `TARGET_UNREACHABLE`, not `REJECTED`: an apply creates what is
    // not there, so nothing missing here is the developer's object. §6 blames
    // `REJECTED` on the developer, which would send them reading their chart
    // values for a namespace the operator deleted.
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
          metadata: {
            name: 'apps',
            // What the vessel declares admission to mean, and what every App
            // namespace is stamped from.
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
    // §7 pins the App chart per Target, which makes "this source object exists
    // in this cluster" a Target prerequisite rather than something a deploy
    // discovers late.
    const { adapter } = adapterFor({
      objects: {
        'namespaces//apps': {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: 'apps',
            // What the vessel declares admission to mean, and what every App
            // namespace is stamped from.
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
    // The failure this rules out is the quiet one: a cluster carrying a
    // GitRepository of the right name while the installation deploys from OCI
    // would read green on a check that never looked at the object the release
    // will actually reference, and fail on the first deploy instead.
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
            // What the vessel declares admission to mean, and what every App
            // namespace is stamped from.
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
    // The rendered `chartRef` carries the source object and nothing else, so
    // what a Component pulls is whatever that object's `url` says — an
    // installation declaring one artifact while a Target's source serves
    // another deploys a chart nobody asked for, and every other check reads
    // green. This is the only place the two references meet.
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
              // What the vessel declares admission to mean, and what every App
              // namespace is stamped from.
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
    // The checklist asks the API server what it serves, per flavour: a cluster
    // running Flux is not a cluster an Argo Target can deliver through, and the
    // sentence names the kind that is absent rather than "Flux or Argo".
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
    // The Argo mirror of the `OCIRepository` comparison above, and the same
    // gap: the Application carries the Target's own repository with this
    // installation's chart name under it, so a Target naming somewhere else
    // pulls a different chart under this installation's declaration. Nothing
    // else reads the two references together, and a row that reported met
    // without comparing them is a check that never observed what it names.
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
    // The mirror, so the check above is not simply always-red — and the path
    // form is met on the same cluster, because a path is written into the
    // Application itself and has no second reference to disagree with.
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
    // §7: Helm ignores unknown values silently, so a release whose values were
    // written under an older contract applies cleanly, reports green, and runs
    // without the config it was handed. The only way to notice is to look at
    // what actually rendered — the chart stamps its contract onto every object
    // including the pod template.
    //
    // This test cannot pass against a comparison between two Spindrift
    // constants: the Target carries no contract field of any kind, so the pod
    // list below is the only input that can move the verdict.
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
    // The mirror of the test above, so the check is not simply always-red.
    const rendered = adapterFor({
      lists: { pods: [podRenderedUnder(VALUES_CONTRACT)] },
    });
    expect(
      (await rendered.adapter.inspect(target())).prerequisites.find(
        (item) => item.name === 'CHART_CONTRACT',
      )?.met,
    ).toBe(true);

    // A pod that is not this chart's output carries no such annotation, which
    // is also how a foreign workload sharing the namespace stays out of the
    // verdict. Nothing rendered is nothing skewed.
    const foreign = adapterFor({
      lists: {
        pods: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'other' } }],
      },
    });
    const nothing = await contractCheck(foreign.adapter);
    expect(nothing?.met).toBe(true);
    // And it says nothing, rather than naming a contract nobody rendered.
    expect(nothing?.detail).toBeUndefined();
  });

  test('a pod list this identity may not read is not a green contract check', async () => {
    // The failure mode this whole check exists to remove: a prerequisite that
    // reports met without having observed the thing it names. A cluster that
    // refuses the read answers `403`, and an empty result standing in for that
    // refusal makes "every rendered object agrees" vacuously true — so a
    // Target whose Role was never bound would read green forever.
    const { adapter } = adapterFor({ forbidden: ['pods'] });

    const contract = await contractCheck(adapter);
    expect(contract?.met).toBe(false);
    expect(contract?.detail).toContain('403');
  });

  test('a rolling update is not skew, and a finished pod does not outlive its render', async () => {
    // Both are the same mistake: reading a pod that is not desired state.
    //
    // During a rolling update after a contract bump the old ReplicaSet's pod
    // and the new one coexist, and only the newer of the two says what the
    // release now renders.
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

    // And a job's Completed pod is the residue of a render that is over: a
    // CronJob upgraded to the current contract but not yet fired again would
    // otherwise be held red by its own history.
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
 * What the API says about a *kind*, as against what it holds of one.
 *
 * These go through `KubernetesApi` rather than through the adapter because the
 * distinction is the client's to preserve — `list` returns `null` for a kind
 * the cluster does not serve and `[]` for a served kind holding nothing, and
 * every call site's `?? []` is written against one of those two answers.
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
    // Flux is installed here — `SERVED` says so — and this namespace holds no
    // HelmRelease. That is `[]`, and it is a different answer from the one
    // below.
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
    // The two keys the chart's `selectorLabels` defines are the contract. A
    // selector naming anything else matches a pod the chart never labelled.
    expect(await listWith('app.kubernetes.io/instance=blog-web')).toEqual([]);
  });

  test('deleting what is already gone succeeds, on a cluster that says 404', async () => {
    const { api, cluster } = apiFor();
    // §6's idempotence, proven rather than assumed: the fake refuses the
    // delete outright, and the client still returns normally.
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
 * Reading a cluster that is not a Target yet (§13's connect, one step earlier).
 *
 * `inspect` cannot answer this — it takes a connection carrying the very facts
 * an operator is here to choose — so the probe is the read that runs against
 * nothing but an address, and everything it returns is a list to pick from.
 *
 * The behaviour worth pinning is the degradation. A cluster whose
 * `spindrift-target` RBAC has not merged yet answers some reads and refuses
 * others, and that is the *ordinary* state of a cluster somebody is connecting.
 * A probe that gave up on the first refusal would report nothing about a
 * cluster that is nearly ready, and the screen would have nothing to offer.
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
    // Every option a picker offers has to be an answer that would work. An
    // installation deploying from OCI offered a GitRepository would be a screen
    // whose only choices produce a Target that cannot deploy.
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
    // `platform.dns.privateAddress` is published as an A record, so a name is
    // not a value it can hold — and filling it with one would be worse than
    // leaving the field to the operator.
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
 * A job's runs (§7, §17).
 *
 * The chart renders every job as a CronJob — suspended when unscheduled — so a
 * run is a Job created from that CronJob's own `jobTemplate` and owned by it.
 * Both halves have a failure mode a plausible implementation walks into: a run
 * built from anything other than the template runs the wrong image, and a run
 * with no owner outlives every execution beside it because nothing prunes it.
 */
describe('a job is run, and its runs are read', () => {
  const RUN_AT = Date.UTC(2026, 7, 4, 12, 0, 0);
  const JOB_LABELS = {
    'app.kubernetes.io/name': 'nightly',
    'app.kubernetes.io/part-of': 'blog',
  };
  const REF = 'flux-helmrelease:delivery/blog-nightly';

  /**
   * The release the chart rendered from, as the adapter reads it back.
   *
   * `targetNamespace` is where its runs are, and it is read rather than derived
   * — a release placed before per-App namespaces still says the shared one, and
   * its Jobs are still there. Every release this adapter writes states it.
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
      // Nothing here polls for readiness, and the default script would
      // otherwise stamp a ready HelmRelease's status onto every Job read.
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
    // The template's spec, verbatim: a run that assembled its own would run
    // something other than what the chart rendered.
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
    // `POST /apis/batch/v1/namespaces/<ns>/jobs` answers `404` when the
    // namespace has been deleted or the cluster does not serve `batch/v1`.
    // Nothing is created either way, so a started run reported from it is a
    // row reading `running` that the next `executions` read never lists —
    // this repo's signature failure, an act that reached nothing and said it
    // worked. `create` distinguishes stored from not-stored by raising.
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

    // Awaited: unawaited, the second assertion runs before `run` has issued its
    // `POST` and would pass whatever the adapter did.
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
    // The read half of the `create` test above, and the same failure: `403` on
    // this call reaches the "these runs could not be read" arm, so a `404` —
    // the namespace deleted, or a cluster that does not serve `batch/v1` —
    // reading green and empty is an asymmetry nobody chose. `api.list` answers
    // `null` for exactly that and `?? []` threw the distinction away.
    const far = new FakeKubernetes({
      // `CronJob` served and `Job` not: a `list jobs` here is a `404` while
      // everything `placedJob` reads still answers, so the failure is this one
      // call's and not the fixture falling over earlier.
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
    // The cluster filters, not the caller: only the named run's pod comes back.
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
