/**
 * The one `DnsPublisher` this installation has: a `DNSEndpoint` on the
 * control-plane cluster (§9).
 *
 * Shaped exactly like `packages/charts/spindrift-app/templates/dnsendpoint.yaml`
 * renders, because it converges through the same `externaldns.k8s.io` `crd`
 * source — two different objects the controller reads the same way would
 * only be two ways to publish a record, one of them undocumented. Unlike that
 * template,
 * this is not rendered per release: **the CR lives on the control-plane
 * cluster**, addressed once by `registry.ts` rather than by whichever Target's
 * own namespace a Deploy happens to land in — a platform-named Target has no
 * cluster of its own for the object to ride along with.
 */
import type {
  KubernetesApi,
  KubernetesObject,
} from '../deploy/kubernetes/api.ts';
import type { DnsPublisher, DnsRecord } from './contract.ts';

const DNS_ENDPOINT_API_VERSION = 'externaldns.k8s.io/v1alpha1';

/**
 * The prefix every provider-specific key is written under.
 *
 * external-dns reads these under `DefaultAnnotationPrefix`, and v0.22.0 changed
 * that default from `external-dns.alpha.kubernetes.io/` to
 * `external-dns.kubernetes.io/` with no fallback for the old spelling — a
 * controller on the new default would stop finding the proxied key and
 * quietly fall back to `proxiedByDefault`, publishing every record unproxied.
 *
 * So the controller is pinned to this prefix in
 * `clusters/base/networking/external-dns/helm-release.yaml`, and the two ends
 * are held together by `test/conformance/reach-publication.test.ts`, which
 * reads the flag out of that release and fails if it stops matching this.
 */
export const PROXIED_KEY =
  'external-dns.alpha.kubernetes.io/cloudflare-proxied';

/**
 * The prefix half of it, derived rather than spelled a second time.
 *
 * Two literals that must agree are two literals that will not, and this pair is
 * read by `test/conformance/reach-publication.test.ts` to prove the controller
 * is pinned to the same prefix — a check that proves nothing if the prefix it
 * compares is its own separate copy.
 */
export const ANNOTATION_PREFIX = PROXIED_KEY.slice(
  0,
  PROXIED_KEY.lastIndexOf('/') + 1,
);
const DNS_ENDPOINT_PLURAL = 'dnsendpoints';

export interface ClusterDnsPublisherOptions {
  readonly api: KubernetesApi;
  /** Where the object is created — the control-plane Target's delivery namespace. */
  readonly namespace: string;
}

export class ClusterDnsPublisher implements DnsPublisher {
  constructor(private readonly options: ClusterDnsPublisherOptions) {}

  async publish(name: string, record: DnsRecord): Promise<void> {
    const object: KubernetesObject = {
      apiVersion: DNS_ENDPOINT_API_VERSION,
      kind: 'DNSEndpoint',
      metadata: {
        name,
        namespace: this.options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'spindrift',
          // ponytail: `name` is Spindrift's opaque handle (§9's "not the
          // hostname"), not a parsed `<app>-<component>` pair — splitting it
          // back apart is ambiguous whenever either name itself contains a
          // hyphen, so this carries the whole handle rather than a wrong
          // half of it. Widen `DnsPublisher.publish` to take the App and
          // Component separately if an operator ever needs to filter these
          // objects by one alone, the way a release's own `part-of` label
          // does.
          'app.kubernetes.io/name': name,
        },
      },
      spec: {
        endpoints: [
          {
            dnsName: record.dnsName,
            recordType: record.recordType,
            targets: [record.target],
            // The proxy flag travels as provider config rather than an
            // annotation, exactly as the chart template does it: the `crd`
            // source passes `providerSpecific` through untouched, where an
            // annotation on this object would be ignored.
            providerSpecific: [
              {
                name: PROXIED_KEY,
                value: record.proxied ? 'true' : 'false',
              },
            ],
          },
        ],
      },
    };
    // Server-side apply, like every other write this codebase makes to a
    // cluster: a second `publish` of the same name converges rather than
    // minting a sibling, which is the whole of this port's idempotence.
    await this.options.api.apply(object, DNS_ENDPOINT_PLURAL);
  }

  async withdraw(name: string): Promise<void> {
    // `KubernetesApi.delete` already tolerates a 404, so a name never
    // published — or already withdrawn — is success with no branch here.
    await this.options.api.delete({
      apiVersion: DNS_ENDPOINT_API_VERSION,
      plural: DNS_ENDPOINT_PLURAL,
      namespace: this.options.namespace,
      name,
    });
  }
}
