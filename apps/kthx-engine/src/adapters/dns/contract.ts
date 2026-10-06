/**
 * The DNS publisher port, neutral about how a record is published.
 */

/** One record a publisher converges a name onto. */
export interface DnsRecord {
  /** The vanity name, apex included. */
  readonly dnsName: string;
  /** Every platform hands back a hostname, and Cloudflare flattens an apex CNAME. */
  readonly recordType: 'CNAME';
  /** The platform's own hostname, such as `<project>.pages.dev`. */
  readonly target: string;
  readonly proxied: boolean;
}

export interface DnsPublisher {
  /** Idempotent. `name` is the caller's opaque handle, not the hostname. */
  publish(name: string, record: DnsRecord): Promise<void>;
  /** Idempotent: a name already gone is success. */
  withdraw(name: string): Promise<void>;
}
