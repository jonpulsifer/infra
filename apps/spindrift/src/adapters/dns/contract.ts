/**
 * The DNS publisher port (§9).
 *
 * §9 already states the doctrine: "Spindrift writes DNS as CRs the DNS
 * controller publishes, so it holds no Cloudflare credential and gets garbage
 * collection free." That is a fact about one implementation, not about the
 * seam — core stays backend-neutral, so this port says nothing about a `CR` or
 * a cluster. There is exactly one implementation today, `dns/cluster.ts`'s
 * `ClusterDnsPublisher`, and the seam is what lets a second one exist without
 * `deploy-loop.ts` learning its name.
 *
 * **CNAME only.** Every platform-named Target (`cloudflare-pages`, `vercel`)
 * that can be addressed by a record at all hands back a hostname to point at,
 * and Cloudflare flattens an apex CNAME so the bare zone is no exception. A
 * platform whose custom domains need an A record and TXT verification —
 * Firebase Hosting's, on `static` — is not squeezed into this shape; its
 * adapter reports no `address` at all (`adapters/deploy/contract.ts`), which
 * is the honest "nothing to publish" rather than a record this port cannot
 * make true.
 */

/** One record a publisher converges a name onto. */
export interface DnsRecord {
  /** The vanity name this record answers on, apex included. */
  readonly dnsName: string;
  readonly recordType: 'CNAME';
  /** `<project>.pages.dev`, `cname.vercel-dns.com` — the platform's own address. */
  readonly target: string;
  readonly proxied: boolean;
}

export interface DnsPublisher {
  /** Idempotent: converges one named record. `name` is Spindrift's handle, not the hostname. */
  publish(name: string, record: DnsRecord): Promise<void>;
  /** Idempotent: a name already gone is success. */
  withdraw(name: string): Promise<void>;
}
