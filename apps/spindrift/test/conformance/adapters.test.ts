/**
 * Runs the conformance suites against every adapter. All enrolments stay in
 * this file so every suite call has run before `assertEveryAdapterEnrolled`.
 */
import { BosunBuildRoute } from '../../src/adapters/build/bosun.ts';
import { CloudBuildRoute } from '../../src/adapters/build/cloud-build.ts';
import { GitHubActionsBuildRoute } from '../../src/adapters/build/github-actions.ts';
import {
  InClusterBuildRoute,
  JOB_LABEL,
} from '../../src/adapters/build/in-cluster.ts';
import { encodeBuildReport } from '../../src/adapters/build/report.ts';
import { CloudRunDeployAdapter } from '../../src/adapters/deploy/cloudrun/index.ts';
import { workloadId } from '../../src/adapters/deploy/cloudrun/service.ts';
import { RESTART_STAMP } from '../../src/adapters/deploy/contract.ts';
import { KubernetesApi } from '../../src/adapters/deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { PagesDeployAdapter } from '../../src/adapters/deploy/pages/index.ts';
import { StaticDeployAdapter } from '../../src/adapters/deploy/static/index.ts';
import { VercelDeployAdapter } from '../../src/adapters/deploy/vercel/index.ts';
import { SecretManagerStore } from '../../src/adapters/store/gcp-secret-manager.ts';
import { OnePasswordStore } from '../../src/adapters/store/onepassword.ts';
import { VercelSecretStore } from '../../src/adapters/store/vercel.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { FakeBosunOutbox } from '../harness/fakes/bosun-outbox.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeCloudBuild } from '../harness/fakes/cloud-build-api.ts';
import { FakeCloudflarePages } from '../harness/fakes/cloudflare-pages-api.ts';
import { FakeCloudRun } from '../harness/fakes/cloudrun-api.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { FakeHosting } from '../harness/fakes/hosting-api.ts';
import { FakeKubernetes } from '../harness/fakes/kubernetes-api.ts';
import { FakeOnePasswordConnect } from '../harness/fakes/onepassword-connect.ts';
import { FakeSecretManager } from '../harness/fakes/secret-manager-api.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { FakeVercel } from '../harness/fakes/vercel-api.ts';
import { bytes, tarball } from '../harness/tar.ts';
import {
  assertEveryAdapterEnrolled,
  BUNDLE_DEPOT,
  buildAdapterSuite,
  deployAdapterSuite,
  desiredState,
  storeAdapterSuite,
} from './adapter-suite.ts';

function inClusterBuildLog(): string {
  const digest = `sha256:${'c'.repeat(64)}`;
  return [
    '#1 load build definition',
    '#8 exporting to image',
    encodeBuildReport({
      bundleDigest: 'sha256:bundle',
      digest,
      refs: [`registry.example.test/app@${digest}`],
      baseDigest: null,
    }),
  ].join('\n');
}

deployAdapterSuite(
  'fake',
  () => {
    const adapter = new FakeDeployAdapter();
    return {
      adapter,
      placements: () => adapter.placementCount,
      restartMark: () =>
        adapter.restarted.length === 0
          ? null
          : String(adapter.restarted.length),
    };
  },
  'files',
);

/** Advances on every read, so two quick restarts record different times. */
function ticking(): () => number {
  let clock = Date.UTC(2026, 0, 1);
  return () => {
    clock += 1_000;
    return clock;
  };
}

deployAdapterSuite(
  'kubernetes',
  () => {
    const cluster = new FakeKubernetes({
      servedKinds: {
        'helm.toolkit.fluxcd.io/v2': ['HelmRelease'],
        'postgresql.cnpg.io/v1': ['Cluster'],
        'valkey.io/v1alpha1': ['ValkeyCluster'],
        'cilium.io/v2': ['CiliumNetworkPolicy'],
        'kyverno.io/v1': ['ClusterPolicy'],
      },
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
            // Every App namespace the adapter creates copies these labels.
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
            metadata: { name: 'secrets' },
            spec: { provider: { onepassword: {} } },
          },
        ],
        nodes: [],
        storageclasses: [],
        clusterpolicies: [],
      },
    });
    return {
      adapter: new KubernetesDeployAdapter({
        chart: 'example/spindrift-app',
        token: cluster.token,
        fetch: cluster.fetch,
        pollIntervalMs: 1,
        sleep: async () => {},
        now: ticking(),
      }),
      placements: () => cluster.all('helmreleases').length,
      // The pod-template annotation, read from the release's inline values.
      restartMark: () => {
        const [release] = cluster.all('helmreleases');
        const spec = release?.spec as
          | {
              values?: { shared?: { podAnnotations?: Record<string, string> } };
            }
          | undefined;
        return spec?.values?.shared?.podAnnotations?.[RESTART_STAMP] ?? null;
      },
    };
  },
  'files',
);

deployAdapterSuite(
  'cloudrun',
  () => {
    const api = new FakeCloudRun();
    return {
      adapter: new CloudRunDeployAdapter({
        token: api.token,
        fetch: api.fetch,
        pollIntervalMs: 1,
        sleep: async () => {},
        now: ticking(),
      }),
      placements: () => api.serviceCount,
      // The revision-template annotation makes the runtime mint a new revision.
      restartMark: () => {
        const template = api.service(workloadId(desiredState('image')))
          ?.template as { annotations?: Record<string, string> } | undefined;
        return template?.annotations?.[RESTART_STAMP] ?? null;
      },
    };
  },
  'files',
);

deployAdapterSuite(
  'static',
  () => {
    const api = new FakeHosting({
      // The upload step runs only when the bundle holds a file.
      bundle: {
        origin: BUNDLE_DEPOT,
        bytes: tarball([
          { name: 'index.html', bytes: bytes('<!doctype html>hello') },
        ]),
      },
    });
    return {
      adapter: new StaticDeployAdapter({ token: api.token, fetch: api.fetch }),
      placements: () => api.siteCount,
    };
  },
  'image',
);

deployAdapterSuite(
  'vercel',
  () => {
    const api = new FakeVercel({
      bundle: {
        origin: BUNDLE_DEPOT,
        bytes: tarball([
          { name: 'index.html', bytes: bytes('<!doctype html>hello') },
        ]),
      },
    });
    return {
      adapter: new VercelDeployAdapter({
        token: api.token,
        artifactToken: api.token,
        fetch: api.fetch,
        pollIntervalMs: 1,
        sleep: async () => {},
        // A `vercel-output` artifact deploys through the CLI, which has no HTTP
        // API to fake, so this records the deployment the CLI would leave.
        deployPrebuilt: async (input) => {
          api.recordPrebuiltDeploy({
            project: input.project,
            meta: input.meta,
          });
          return { ok: true };
        },
      }),
      placements: () => api.deploymentCount,
    };
  },
  'image',
);

deployAdapterSuite(
  'cloudflare-pages',
  () => {
    const api = new FakeCloudflarePages({
      // The upload step runs only when the bundle holds a file.
      bundle: {
        origin: BUNDLE_DEPOT,
        bytes: tarball([
          { name: 'index.html', bytes: bytes('<!doctype html>hello') },
        ]),
      },
    });
    return {
      adapter: new PagesDeployAdapter({
        token: api.token,
        artifactToken: api.token,
        fetch: api.fetch,
      }),
      placements: () => api.deploymentCount,
    };
  },
  'image',
);

buildAdapterSuite('fake', () => new FakeBuildAdapter());

buildAdapterSuite('github-actions', () => {
  const host = new FakeGitHub();
  return new GitHubActionsBuildRoute({
    name: 'github-actions',
    host: new GitHubApp({
      baseUrl: host.baseUrl,
      authorization: () => 'Bearer test-installation-token',
      appAuthorization: () => 'Bearer test-app-jwt',
      fetch: host.fetch,
    }),
    buildWorkflow: `${host.fullName}/.github/workflows/spindrift-build.yml@${'f'.repeat(40)}`,
    zeroConfigFrontend: 'registry.example.test/zero-config:pinned',
    signer: '',
    attestor: '',
    correlation: () => 'conformance',
    intervalMs: 1,
    sleep: async () => {},
  });
});

buildAdapterSuite('cloud-build', () => {
  const api = new FakeCloudBuild();
  return new CloudBuildRoute({
    name: 'cloud-build',
    endpoint: api.endpoint,
    logsEndpoint: api.logsEndpoint,
    project: 'example-builds',
    region: 'example-region',
    image: 'registry.example.test/buildkit:pinned',
    zeroConfigFrontend: 'registry.example.test/zero-config:pinned',
    signer: '',
    attestor: '',
    token: api.token,
    fetch: api.fetch,
    intervalMs: 1,
    sleep: async () => {},
  });
});

buildAdapterSuite('in-cluster', () => {
  const cluster = new FakeKubernetes({
    status: () => ({ succeeded: 1 }),
    lists: {
      pods: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'build-pod',
            namespace: 'builds',
            // The fake cluster filters pods on this label.
            labels: { [JOB_LABEL]: 'spindrift-build-conformance' },
          },
        },
      ],
    },
    logs: (_pod, reads) =>
      reads < 2 ? '#1 load build definition' : inClusterBuildLog(),
  });
  return new InClusterBuildRoute({
    name: 'in-cluster',
    api: new KubernetesApi({
      apiServer: cluster.apiServer,
      token: cluster.token,
      fetch: cluster.fetch,
    }),
    namespace: 'builds',
    image: 'registry.example.test/buildkit:pinned',
    serviceAccount: 'builder',
    zeroConfigFrontend: 'registry.example.test/zero-config:pinned',
    id: () => 'conformance',
    intervalMs: 1,
    sleep: async () => {},
  });
});

// Bosun reads an outbox row, and a first read of `DONE` ends its poll, so this
// fake needs no pacing overrides.
buildAdapterSuite('bosun', () => {
  const conformanceDigest = `sha256:${'d'.repeat(64)}`;
  const outbox = new FakeBosunOutbox({
    states: [
      {
        state: 'DONE',
        result: {
          status: 'SUCCEEDED',
          log: encodeBuildReport({
            bundleDigest: 'sha256:bundle',
            digest: conformanceDigest,
            refs: [`registry.example.test/app@${conformanceDigest}`],
            baseDigest: null,
          }),
        },
      },
    ],
  });
  return new BosunBuildRoute({
    name: 'bosun',
    class: 'skiff-conformance',
    outbox,
    zeroConfigFrontend: 'registry.example.test/zero-config:pinned',
    provenanceBuilderId: 'https://bosun.example.test/skiff',
  });
});

// Each fake names references as the real store it stands for does.
storeAdapterSuite(
  'fake native, standing for gcp-secret-manager',
  () => new FakeSecretStore({ pinning: 'NATIVE' }),
);
storeAdapterSuite(
  'fake immutable item per version, standing for onepassword',
  () => new FakeSecretStore({ pinning: 'IMMUTABLE_ITEM_PER_VERSION' }),
);
storeAdapterSuite(
  'fake current only, standing for vercel',
  () => new FakeSecretStore({ pinning: 'CURRENT_ONLY' }),
);

// The fake API answers `403` to creating an existing key, as the platform does.
storeAdapterSuite('vercel', () => {
  const api = new FakeVercel({ projects: [] });
  return new VercelSecretStore({
    baseUrl: api.endpoint,
    token: api.token,
    team: api.team,
    fetch: api.fetch,
  });
});

storeAdapterSuite('onepassword', () => {
  const connect = new FakeOnePasswordConnect();
  return new OnePasswordStore({
    baseUrl: connect.baseUrl,
    vault: connect.vault,
    token: () => 'connect-token',
    fetch: connect.fetch,
  });
});

storeAdapterSuite('gcp-secret-manager', () => {
  const api = new FakeSecretManager();
  return new SecretManagerStore({
    baseUrl: api.baseUrl,
    project: api.project,
    token: () => 'federated-token',
    fetch: api.fetch,
  });
});

assertEveryAdapterEnrolled();
