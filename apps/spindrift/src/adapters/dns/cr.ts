/**
 * DNS, written as custom resources (§9).
 *
 * §9: "**Spindrift writes DNS as CRs the DNS controller publishes**, so it holds
 * **no Cloudflare credential** and gets garbage collection free."
 *
 * Both halves of that are the design:
 *
 * - **No provider credential anywhere.** There is no API client in this file and
 *   no token in the manifest to build one with. What Spindrift can do to DNS is
 *   exactly what its cluster identity can do to one namespaced kind, which is a
 *   much smaller blast radius than an account-scoped zone token, and it is why
 *   `test/extraction/no-dns-credential.test.ts` asserts by grep that no such
 *   client exists.
 * - **Garbage collection for free.** A record is an object in the App's own
 *   namespace, so deleting the namespace deletes the record. Core never has to
 *   remember which names it minted in order to clean them up later — the
 *   cleanest kind of bookkeeping is the kind nobody does.
 *
 * The trade §9 accepts in exchange: **a Target must run a DNS controller that
 * serves this kind**, which is a prerequisite on §13's checklist rather than
 * something core can discover its way around.
 */
import type { KubernetesObject } from '../deploy/kubernetes/api.ts';

/**
 * The CRD this writes, as the DNS controller defines it.
 *
 * Pinned as constants rather than assembled from configuration: the group and
 * version are a fact about the controller's API, not about an installation, and
 * a version that varied per installation would mean core could not tell a
 * missing controller from a mismatched one.
 */
export const DNS_ENDPOINT_API_VERSION = 'externaldns.k8s.io/v1alpha1';
export const DNS_ENDPOINT_KIND = 'DNSEndpoint';
/** The lowercase plural, as the API path uses it. */
export const DNS_ENDPOINT_PLURAL = 'dnsendpoints';

/** The record types core ever writes. */
export type DnsRecordType = 'A' | 'CNAME';

/** How long a record is cached. Short, because an App's address can move. */
export const DEFAULT_TTL_SECONDS = 300;

/** One record, in the controller's own vocabulary. */
export interface DnsRecord {
  /** The fully qualified name being published. */
  readonly dnsName: string;
  readonly recordType: DnsRecordType;
  /** Addresses, or the single name a `CNAME` points at. */
  readonly targets: readonly string[];
  readonly ttlSeconds?: number;
}

/** What {@link dnsEndpointFor} needs to place one object. */
export interface DnsEndpointRequest {
  /** Object name. Namespaced, so it need only be unique within the App. */
  readonly name: string;
  readonly namespace: string;
  readonly records: readonly DnsRecord[];
  /**
   * Labels the object carries, so a human reading the cluster can tell which
   * Deploy put a record there. Never a selector — nothing selects these.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * One `DNSEndpoint` object, ready for server-side apply.
 *
 * A pure function returning a plain object, deliberately: applying it is the
 * Kubernetes API client's job (`adapters/deploy/kubernetes/api.ts`), and keeping
 * the two apart is what lets a test assert the exact document core would write
 * without standing up a fake API to catch it.
 */
export function dnsEndpointFor(request: DnsEndpointRequest): KubernetesObject {
  return {
    apiVersion: DNS_ENDPOINT_API_VERSION,
    kind: DNS_ENDPOINT_KIND,
    metadata: {
      name: request.name,
      namespace: request.namespace,
      ...(request.labels === undefined ? {} : { labels: request.labels }),
    },
    spec: {
      endpoints: request.records.map((record) => ({
        dnsName: record.dnsName,
        recordType: record.recordType,
        targets: [...record.targets],
        recordTTL: record.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      })),
    },
  };
}

/**
 * The records one Component's canonical and vanity names need (§9).
 *
 * Both are `CNAME`s at the address the Target serves rather than `A` records at
 * an IP, because §9's forcing fact is that the metal cluster's load-balancer
 * range is RFC1918: an `A` record would publish an address the internet cannot
 * route to, and the reachable address is the tunnel's, which core does not own
 * and must not restate.
 *
 * **Core writes no vanity record where there is no vanity name**, rather than
 * writing one that points at the canonical: §9 layers vanity on "where a
 * mechanism exists", and an installation without one should have an App that
 * simply has no second name.
 */
export function recordsFor(args: {
  readonly canonical: string;
  readonly vanity?: string | undefined;
  /** The name the Target's ingress answers to — a tunnel or gateway address. */
  readonly servedBy: string;
}): readonly DnsRecord[] {
  const records: DnsRecord[] = [
    { dnsName: args.canonical, recordType: 'CNAME', targets: [args.servedBy] },
  ];
  if (args.vanity !== undefined && args.vanity !== '') {
    records.push({
      dnsName: args.vanity,
      recordType: 'CNAME',
      targets: [args.servedBy],
    });
  }
  return records;
}
