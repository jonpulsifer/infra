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
 * The proxied-flag key under both spellings of external-dns's annotation
 * prefix, pinned spelling first — and every one of them is written.
 *
 * external-dns builds every key it looks for as `AnnotationKeyPrefix + suffix`,
 * where that variable is `--annotation-prefix` and defaults to
 * `DefaultAnnotationPrefix`. v0.22.0 changed that default from
 * `external-dns.alpha.kubernetes.io/` to `external-dns.kubernetes.io/` **with
 * no fallback**: a controller reads exactly one of these and is blind to the
 * other, so a writer and a controller that disagree publish every record
 * unproxied — no zone cache, no WAF, origin exposed — while the deploy still
 * goes green.
 *
 * Writing both costs nothing: the Cloudflare provider's `shouldBeProxied`
 * scans `providerSpecific` for its one key and `break`s, ignoring every other
 * name without so much as a warning. What it buys is that moving the pin in
 * `clusters/base/networking/external-dns/helm-release.yaml` is an edit to one
 * flag rather than a flag day — the key the new pin will look for is already
 * on every live object before any controller starts reading it.
 *
 * Spelled whole rather than assembled from a suffix, so a grep for the key
 * external-dns actually reads finds this line.
 */
export const PROXIED_KEYS = [
  'external-dns.alpha.kubernetes.io/cloudflare-proxied',
  'external-dns.kubernetes.io/cloudflare-proxied',
] as const;

/** The prefix half of a key, derived rather than spelled a second time. */
function prefixOf(key: string): string {
  return key.slice(0, key.lastIndexOf('/') + 1);
}

/**
 * Every prefix Spindrift writes under, and the set a cluster's
 * `--annotation-prefix` must name one of.
 *
 * Read by `test/harness/external-dns-installation.ts`, which refuses any pin
 * outside this set, and by `test/conformance/reach-publication.test.ts`, which
 * runs the whole publication model under *each* of them and fails unless they
 * publish the same zone. That pair is what lets the pin move on its own: the
 * flip is proven inert before the flag changes.
 */
export const ANNOTATION_PREFIXES = PROXIED_KEYS.map(prefixOf);

/** The one the controllers in `clusters/` are pinned to today. */
export const ANNOTATION_PREFIX = prefixOf(PROXIED_KEYS[0]);

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
            providerSpecific: PROXIED_KEYS.map((name) => ({
              name,
              value: record.proxied ? 'true' : 'false',
            })),
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
