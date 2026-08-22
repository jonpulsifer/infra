/**
 * What a backend calls the thing core placed.
 *
 * Every deploy adapter needs one name per (App, Component) — a release, a
 * service, a site — and every backend caps it at a different length. Three
 * adapters each solving that separately is how two of them end up truncating
 * and one of them ends up correct, so the rule lives here once.
 *
 * **Truncation alone is the bug.** `<app>-<component>` cut to a limit makes two
 * Components of one long-named App the same name, and the failure that produces
 * is the quiet one: the second deploy is an *upgrade of the first*, so one
 * Component silently starts serving the other's image. A digest tail cannot
 * collide that way, and it stays deterministic, which the truncation also has
 * to be — a second deploy that computed a different name would create a second
 * workload rather than replace the first.
 *
 * This is not a DNS name and `naming.ts` is not its home: §9's names are what a
 * user types, chosen for how they read and constrained by certificates. This is
 * an identifier a backend imposes a length on, and the only thing it owes
 * anyone is being the same one next time.
 */

/** How many characters of digest a shortened name carries. */
const DIGEST_LENGTH = 7;

/** What a name is assembled from. */
export interface WorkloadNameParts {
  readonly app: string;
  readonly component: string;
}

/**
 * The name one backend uses, within the length that backend allows.
 *
 * Under the limit the name is `<app>-<component>`, which is what a human
 * reading the backend expects to see. Over it, enough of that is kept to stay
 * recognisable and the rest is a digest of the **full** name — so two names
 * that were different before the cut are still different after it.
 */
export function workloadName(parts: WorkloadNameParts, limit: number): string {
  const full = `${parts.app}-${parts.component}`;
  if (full.length <= limit) return full;

  const hash = new Bun.CryptoHasher('sha256').update(full).digest('hex');
  const kept = Math.max(1, limit - DIGEST_LENGTH - 1);
  return `${full.slice(0, kept)}-${hash.slice(0, DIGEST_LENGTH)}`;
}

/** A generic Kubernetes object name's own limit — RFC 1123's DNS subdomain. */
const DNS_HANDLE_LIMIT = 253;

/**
 * A `DnsPublisher`'s handle for one Component's platform-named placement (§9).
 *
 * `dns/contract.ts`'s own doc comment already says what this is not: "`name`
 * is Spindrift's handle, not the hostname." It is this module's concern for
 * the same reason a release name is — a `DNSEndpoint` object's `metadata.name`
 * is a Kubernetes identifier with a length Kubernetes imposes, and the publish
 * that mints it and the later withdraw that removes it have to compute the
 * identical string or the second one deletes nothing. `deploy-loop.ts`'s
 * publish and `unplaceComponent`/`deleteApp`'s withdraw all call this rather
 * than each assembling `<app>-<component>` on their own.
 */
export function dnsHandleFor(app: string, component: string): string {
  return workloadName({ app, component }, DNS_HANDLE_LIMIT);
}
