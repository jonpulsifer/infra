/**
 * A `DNSEndpoint` on the control-plane cluster, shaped like the app chart's
 * template so external-dns reads both through its `crd` source. It lives there
 * because a platform-named Target has no cluster of its own.
 */
import type {
  KubernetesApi,
  KubernetesObject,
} from '../deploy/kubernetes/api.ts';
import type { DnsPublisher, DnsRecord } from './contract.ts';

const DNS_ENDPOINT_API_VERSION = 'externaldns.k8s.io/v1alpha1';

/**
 * external-dns reads exactly one prefix, and v0.22.0 changed the default with no
 * fallback, so a mismatch publishes unproxied. Cloudflare ignores the other key.
 */
export const PROXIED_KEYS = [
  'external-dns.alpha.kubernetes.io/cloudflare-proxied',
  'external-dns.kubernetes.io/cloudflare-proxied',
] as const;

function prefixOf(key: string): string {
  return key.slice(0, key.lastIndexOf('/') + 1);
}

/** A cluster's `--annotation-prefix` must be one of these. */
export const ANNOTATION_PREFIXES = PROXIED_KEYS.map(prefixOf);

/** The prefix the deployed external-dns controllers are pinned to. */
export const ANNOTATION_PREFIX = prefixOf(PROXIED_KEYS[0]);

const DNS_ENDPOINT_PLURAL = 'dnsendpoints';

export interface ClusterDnsPublisherOptions {
  readonly api: KubernetesApi;
  /** The control-plane Target's delivery namespace. */
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
          // ponytail: the whole handle; splitting App and Component is
          // ambiguous when either has a hyphen. Pass them to `publish`
          // separately to filter by one.
          'app.kubernetes.io/name': name,
        },
      },
      spec: {
        endpoints: [
          {
            dnsName: record.dnsName,
            recordType: record.recordType,
            targets: [record.target],
            // The `crd` source ignores annotations on this object but passes
            // `providerSpecific` through.
            providerSpecific: PROXIED_KEYS.map((name) => ({
              name,
              value: record.proxied ? 'true' : 'false',
            })),
          },
        ],
      },
    };
    await this.options.api.apply(object, DNS_ENDPOINT_PLURAL);
  }

  async withdraw(name: string): Promise<void> {
    // `KubernetesApi.delete` treats a 404 as success.
    await this.options.api.delete({
      apiVersion: DNS_ENDPOINT_API_VERSION,
      plural: DNS_ENDPOINT_PLURAL,
      namespace: this.options.namespace,
      name,
    });
  }
}
