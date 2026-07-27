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
import { KubernetesDeployAdapter } from '../../src/adapters/deploy/kubernetes/index.ts';
import { SecretManagerStore } from '../../src/adapters/store/gcp-secret-manager.ts';
import { OnePasswordStore } from '../../src/adapters/store/onepassword.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeKubernetes } from '../harness/fakes/kubernetes-api.ts';
import { FakeOnePasswordConnect } from '../harness/fakes/onepassword-connect.ts';
import { FakeSecretManager } from '../harness/fakes/secret-manager-api.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import {
  assertEveryAdapterEnrolled,
  buildAdapterSuite,
  deployAdapterSuite,
  storeAdapterSuite,
} from './adapter-suite.ts';

deployAdapterSuite('fake', () => new FakeDeployAdapter(), 'files');

deployAdapterSuite(
  'kubernetes',
  () => {
    const cluster = new FakeKubernetes({
      servedKinds: {
        'helm.toolkit.fluxcd.io/v2': ['HelmRelease'],
        'postgresql.cnpg.io/v1': ['Cluster'],
        'redis.redis.opstreelabs.in/v1beta2': ['Redis'],
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
          metadata: { name: 'apps' },
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

buildAdapterSuite('fake', () => new FakeBuildAdapter());

// Both pinning strategies run the same suite, because §10's claim is that
// nothing above the seam can tell them apart. One of them passing would not
// establish that.
storeAdapterSuite(
  'fake native',
  () => new FakeSecretStore({ pinning: 'NATIVE' }),
);
storeAdapterSuite(
  'fake immutable item per version',
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
