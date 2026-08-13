/**
 * The conformance suite, run against every adapter that exists (Task 12).
 *
 * Every enrolment lives in this one file on purpose: `assertEveryAdapterEnrolled`
 * compares what the suite was run over against `ADAPTERS`, and that comparison
 * is only sound if every suite call has already happened when it runs. Splitting
 * the enrolments across files would make the check depend on the order the
 * runner happened to load them in.
 *
 * The two real stores are here alongside the fakes, each with a fake of its
 * far-side HTTP API behind the real client (§ Seam 2). They run the identical
 * assertions, which is what makes §10's claim — that nothing above the seam can
 * tell `NATIVE` from `IMMUTABLE_ITEM_PER_VERSION` — a tested claim rather than a
 * stated one.
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
import { KubernetesApi } from '../../src/adapters/deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { PagesDeployAdapter } from '../../src/adapters/deploy/pages/index.ts';
import { StaticDeployAdapter } from '../../src/adapters/deploy/static/index.ts';
import { VercelDeployAdapter } from '../../src/adapters/deploy/vercel/index.ts';
import { SecretManagerStore } from '../../src/adapters/store/gcp-secret-manager.ts';
import { OnePasswordStore } from '../../src/adapters/store/onepassword.ts';
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
  storeAdapterSuite,
} from './adapter-suite.ts';

/**
 * One key for every hosted-CI route the suite constructs.
 *
 * Generated once at module load rather than per construction: the suite builds
 * a fresh adapter for each assertion, and an RSA keypair per test is seconds of
 * wall clock spent proving nothing about the contract.
 */

/** What the in-cluster Job prints, ending with the one line core reads. */
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

deployAdapterSuite('fake', () => new FakeDeployAdapter(), 'files');

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
            // What this vessel declares admission to mean. Every App namespace
            // the adapter creates is stamped from these.
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
    return new KubernetesDeployAdapter({
      chart: 'example/spindrift-app',
      token: cluster.token,
      fetch: cluster.fetch,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
  },
  'files',
);

deployAdapterSuite(
  'cloudrun',
  () => {
    const api = new FakeCloudRun();
    return new CloudRunDeployAdapter({
      token: api.token,
      fetch: api.fetch,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
  },
  'files',
);

deployAdapterSuite(
  'static',
  () => {
    const api = new FakeHosting({
      // The one file every website has, so the release has something to carry
      // and the upload step actually runs.
      bundle: {
        origin: BUNDLE_DEPOT,
        bytes: tarball([
          { name: 'index.html', bytes: bytes('<!doctype html>hello') },
        ]),
      },
    });
    return new StaticDeployAdapter({ token: api.token, fetch: api.fetch });
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
    // The polling is real and the waiting is not, exactly as the cloud runtime
    // route above is driven.
    return new VercelDeployAdapter({
      token: api.token,
      artifactToken: api.token,
      fetch: api.fetch,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
  },
  'image',
);

deployAdapterSuite(
  'cloudflare-pages',
  () => {
    const api = new FakeCloudflarePages({
      // The one file every website has, so the deployment has something to
      // carry and the upload step actually runs.
      bundle: {
        origin: BUNDLE_DEPOT,
        bytes: tarball([
          { name: 'index.html', bytes: bytes('<!doctype html>hello') },
        ]),
      },
    });
    return new PagesDeployAdapter({ token: api.token, fetch: api.fetch });
  },
  'image',
);

buildAdapterSuite('fake', () => new FakeBuildAdapter());

// The three real routes, each with a fake of its far-side HTTP API behind the
// real client. They run the identical assertions, which is what makes §4's
// claim — that a Build is the same object whoever built it — a tested one.
// Every one of them is driven with `sleep` stubbed and a one-millisecond
// interval: the polling is real, the waiting is not.
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
            // The label the route selects the build's own pod by; the cluster
            // filters on it, so a fixture without it is never found.
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

// Bosun's far side is polled, not dialed, so its fake scripts the outbox row
// rather than an HTTP API — see `FakeBosunOutbox`. A single `DONE` state is
// enough for the suite: none of its assertions poll, so nothing here needs
// the pacing overrides the dialed routes give their fakes.
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

// Both pinning strategies run the same suite, because §10's claim is that
// nothing above the seam can tell them apart. One of them passing would not
// establish that.
//
// Each fake stands for the real store that pins that way and names its
// references as that store does — `NATIVE` for Secret Manager's `--`-joined id,
// `IMMUTABLE_ITEM_PER_VERSION` for 1Password's `/`-joined title. The labels say
// so, because a reference shape neither store can hold would make this suite
// compare two impossibilities and call them the same.
storeAdapterSuite(
  'fake native, standing for gcp-secret-manager',
  () => new FakeSecretStore({ pinning: 'NATIVE' }),
);
storeAdapterSuite(
  'fake immutable item per version, standing for onepassword',
  () => new FakeSecretStore({ pinning: 'IMMUTABLE_ITEM_PER_VERSION' }),
);

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
