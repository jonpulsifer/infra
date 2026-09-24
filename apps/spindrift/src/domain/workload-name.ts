/**
 * The name a backend gives what core placed, within that backend's length
 * limit. It must be stable: a different name on redeploy is a second workload.
 */

const DIGEST_LENGTH = 7;

export interface WorkloadNameParts {
  readonly app: string;
  readonly component: string;
}

/**
 * Over the limit, the tail is a digest of the full name, so two Components of
 * one long-named App stay distinct after the cut.
 */
export function workloadName(parts: WorkloadNameParts, limit: number): string {
  const full = `${parts.app}-${parts.component}`;
  if (full.length <= limit) return full;

  const hash = new Bun.CryptoHasher('sha256').update(full).digest('hex');
  const kept = Math.max(1, limit - DIGEST_LENGTH - 1);
  return `${full.slice(0, kept)}-${hash.slice(0, DIGEST_LENGTH)}`;
}

/** RFC 1123 DNS subdomain, the limit on a Kubernetes object name. */
const DNS_HANDLE_LIMIT = 253;

/**
 * A `DnsPublisher` handle, not a hostname. Publish and withdraw must compute
 * the same string, or the withdraw deletes nothing.
 */
export function dnsHandleFor(app: string, component: string): string {
  return workloadName({ app, component }, DNS_HANDLE_LIMIT);
}
