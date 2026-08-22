/**
 * `ClusterDnsPublisher` (§9).
 *
 * The same shape every other adapter test takes (§ Seam 2): the real
 * publisher against a fake of the cluster's HTTP API, asserting what a
 * cluster would have been sent.
 *
 * - **Shaped like the chart's own `DNSEndpoint`.** The `externaldns.k8s.io`
 *   `crd` source reads both the same way, so a divergence here is a
 *   divergence a cluster would actually see.
 * - **`publish` converges, never mints a sibling.** A second `publish` under
 *   the same handle is a server-side apply of the same object.
 * - **`withdraw` is idempotent**, over both a name that was published and one
 *   that never was.
 */
import { describe, expect, test } from 'bun:test';
import { KubernetesApi } from '../../src/adapters/deploy/kubernetes/api.ts';
import { ClusterDnsPublisher } from '../../src/adapters/dns/cluster.ts';
import type { DnsRecord } from '../../src/adapters/dns/contract.ts';
import { FakeKubernetes } from '../harness/fakes/kubernetes-api.ts';

const NAMESPACE = 'spindrift-platform';

function publisherOn(): {
  fake: FakeKubernetes;
  publisher: ClusterDnsPublisher;
} {
  const fake = new FakeKubernetes();
  return {
    fake,
    publisher: new ClusterDnsPublisher({
      api: new KubernetesApi({
        apiServer: fake.apiServer,
        token: fake.token,
        fetch: fake.fetch,
      }),
      namespace: NAMESPACE,
    }),
  };
}

const RECORD: DnsRecord = {
  dnsName: 'shop.example.test',
  recordType: 'CNAME',
  target: 'shop-web.pages.dev',
  proxied: true,
};

describe('publish', () => {
  test('server-side applies a DNSEndpoint shaped like the chart template', async () => {
    const { fake, publisher } = publisherOn();

    await publisher.publish('shop-web', RECORD);

    const object = fake.get(`dnsendpoints/${NAMESPACE}/shop-web`);
    expect(object?.apiVersion).toBe('externaldns.k8s.io/v1alpha1');
    expect(object?.kind).toBe('DNSEndpoint');
    expect(object?.metadata.labels).toEqual({
      'app.kubernetes.io/managed-by': 'spindrift',
      'app.kubernetes.io/name': 'shop-web',
    });
    expect(object?.spec).toEqual({
      endpoints: [
        {
          dnsName: 'shop.example.test',
          recordType: 'CNAME',
          targets: ['shop-web.pages.dev'],
          providerSpecific: [
            {
              name: 'external-dns.alpha.kubernetes.io/cloudflare-proxied',
              value: 'true',
            },
          ],
        },
      ],
    });
    // A server-side apply, not a merge patch — the same idempotence proof
    // every other Kubernetes write in this codebase carries.
    expect(fake.requests.at(-1)?.contentType).toBe(
      'application/apply-patch+yaml',
    );
  });

  test('an unproxied record says so in providerSpecific', async () => {
    const { fake, publisher } = publisherOn();

    await publisher.publish('shop-web', { ...RECORD, proxied: false });

    const object = fake.get(`dnsendpoints/${NAMESPACE}/shop-web`);
    expect(object?.spec).toMatchObject({
      endpoints: [
        expect.objectContaining({
          providerSpecific: [
            {
              name: 'external-dns.alpha.kubernetes.io/cloudflare-proxied',
              value: 'false',
            },
          ],
        }),
      ],
    });
  });

  test('publishing twice converges on the same object rather than minting a sibling', async () => {
    const { fake, publisher } = publisherOn();

    await publisher.publish('shop-web', RECORD);
    await publisher.publish('shop-web', {
      ...RECORD,
      target: 'a-different-project.pages.dev',
    });

    expect(fake.all('dnsendpoints')).toHaveLength(1);
    const object = fake.get(`dnsendpoints/${NAMESPACE}/shop-web`);
    expect(object?.spec).toMatchObject({
      endpoints: [
        expect.objectContaining({ targets: ['a-different-project.pages.dev'] }),
      ],
    });
  });
});

describe('withdraw', () => {
  test('deletes the object a publish created', async () => {
    const { fake, publisher } = publisherOn();
    await publisher.publish('shop-web', RECORD);

    await publisher.withdraw('shop-web');

    expect(fake.get(`dnsendpoints/${NAMESPACE}/shop-web`)).toBeUndefined();
  });

  test('a name never published succeeds', async () => {
    const { publisher } = publisherOn();

    await expect(
      publisher.withdraw('never-published'),
    ).resolves.toBeUndefined();
  });
});
