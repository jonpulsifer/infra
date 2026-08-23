/**
 * The DNS controller's source layer, as far as a record depends on it (§9).
 *
 * **Fake the far side, never our side.** Spindrift renders objects and a
 * controller turns them into records; the turning is the far side, and it is
 * the half nothing here could otherwise observe. A rendering golden asserts
 * what a Component *asks* to publish, which is exactly what stayed green while
 * a route asked for a proxied name at its tunnel and the zone was given an
 * unproxied address at the shared gateway instead.
 *
 * Two sources are modelled, and **which of them the controller runs is read off
 * the cluster manifests** rather than assumed here — see {@link Controller} and
 * `../external-dns-installation.ts`. The whole defect was that the second
 * answered for names the first was written to state:
 *
 * - **`crd`** passes `spec.endpoints` through as written, which is what makes a
 *   `DNSEndpoint` a statement rather than a hint.
 * - **`gateway-httproute`** derives an endpoint per route hostname, taking its
 *   targets from the parent **Gateway** — its `…/target` annotation if it
 *   carries one, else its `status.addresses` — and reading provider config off
 *   the *route*. A route can never state its own target, so every Component on
 *   one shared gateway gets that gateway's address whatever its reach is.
 *
 * Both are modelled skipping any object whose {@link CONTROLLER} annotation
 * names something other than {@link CONTROLLER_ID}. The route source is where
 * that check is documented, and applying it to the CRD source too is the
 * conservative direction: it makes the model publish *less* than the
 * controller would, so a record this model drops is a test that fails rather
 * than a name that quietly resolves.
 *
 * What is deliberately not modelled: listener matching. The Gateway a Target
 * names carries a wildcard listener covering the whole App zone, so every
 * hostname on an attached route matches one, and modelling the negotiation
 * would only re-derive that.
 */

/**
 * The controller as an installation configures it, not as this file assumes.
 *
 * Only the source list, because that is the whole of what the installation
 * decides about a record here: `crd` is what reads the record the chart states,
 * `gateway-httproute` is the one the route holds itself out of, and either
 * leaving the list changes what a Component's name answers to without changing
 * a single thing Spindrift renders. Everything else the controller is passed is
 * refused rather than modelled, upstream of this — see
 * `../external-dns-installation.ts`.
 */
export interface Controller {
  /** The cluster whose declaration this is, so a failure names it. */
  readonly cluster: string;
  /** `--source=…`, as that cluster declares them. */
  readonly sources: readonly string[];
  /**
   * `--annotation-prefix=…`, or `null` where the cluster leaves it defaulted.
   *
   * `null` is not "the same as pinning it": it is the controller version's
   * default, which changed in v0.22.0. A record's proxied flag is only read
   * when this matches the prefix its writer used.
   */
  readonly annotationPrefix: string | null;
}

/** One object a source reads, as loosely typed as the API's own JSON. */
export interface ClusterObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  spec?: any;
}

/** A Gateway a route parents onto, as the API reports it. */
export interface GatewayStatus {
  name: string;
  namespace: string;
  /** `status.addresses[*].value` — the route source's fallback target. */
  addresses: readonly string[];
  annotations?: Record<string, string>;
}

/** One record the zone provider would be asked to write. */
export interface PublishedRecord {
  dnsName: string;
  recordType: string;
  targets: readonly string[];
  proxied: boolean;
  /** The source that claimed the name, and the object it read it from. */
  claimedBy: string;
}

export interface Publication {
  readonly records: readonly PublishedRecord[];
  /**
   * Names more than one source claimed.
   *
   * Never an empty formality: two sources claiming one name at two record
   * types is the state that soft-errors a whole-zone sync, and it is what the
   * route's hold-out exists to prevent.
   */
  readonly contended: readonly string[];
}

/** The annotation a source honours to leave an object alone. */
export const CONTROLLER = 'external-dns.alpha.kubernetes.io/controller';

/**
 * The only value that means "this one is mine".
 *
 * Upstream's `ControllerValue` constant and not a thing an installation sets —
 * no flag changes it. The annotation *key* is `AnnotationKeyPrefix +
 * "controller"` and that prefix is settable, which is one of the reasons an
 * argument this model has not accounted for is refused rather than ignored.
 */
export const CONTROLLER_ID = 'dns-controller';

const TARGET = 'external-dns.alpha.kubernetes.io/target';
const PROXIED = 'external-dns.alpha.kubernetes.io/cloudflare-proxied';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** What the controller would publish for one namespace's objects. */
export function publish(
  objects: readonly ClusterObject[],
  gateways: readonly GatewayStatus[],
  controller: Controller,
): Publication {
  const records = [
    ...(controller.sources.includes('crd') ? fromEndpoints(objects) : []),
    ...(controller.sources.includes('gateway-httproute')
      ? fromRoutes(objects, gateways)
      : []),
  ];
  const claimants = new Map<string, number>();
  for (const record of records) {
    claimants.set(record.dnsName, (claimants.get(record.dnsName) ?? 0) + 1);
  }
  return {
    records,
    contended: [...claimants]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  };
}

/** The `crd` source: `spec.endpoints`, verbatim. */
function fromEndpoints(objects: readonly ClusterObject[]): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const object of objects) {
    if (object.kind !== 'DNSEndpoint' || heldOut(object)) continue;
    for (const endpoint of object.spec?.endpoints ?? []) {
      records.push({
        dnsName: endpoint.dnsName,
        recordType: endpoint.recordType,
        targets: endpoint.targets ?? [],
        proxied: proxied(
          Object.fromEntries(
            (endpoint.providerSpecific ?? []).map(
              (entry: { name: string; value: string }) => [
                entry.name,
                entry.value,
              ],
            ),
          ),
        ),
        claimedBy: `crd/${object.metadata.name}`,
      });
    }
  }
  return records;
}

/** The `gateway-httproute` source: one endpoint per hostname, off the parent. */
function fromRoutes(
  objects: readonly ClusterObject[],
  gateways: readonly GatewayStatus[],
): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const object of objects) {
    if (object.kind !== 'HTTPRoute' || heldOut(object)) continue;
    const targets = parentTargets(object, gateways);
    if (targets.length === 0) continue;
    for (const hostname of object.spec?.hostnames ?? []) {
      records.push({
        dnsName: hostname,
        // One record type for the whole set, as the source picks it: the
        // targets come from one parent, so they are all addresses or all names.
        recordType: suitableType(targets[0] as string),
        targets,
        proxied: proxied(object.metadata.annotations),
        claimedBy: `httproute/${object.metadata.name}`,
      });
    }
  }
  return records;
}

/** The Gateway's stated target, else the address it reports for itself. */
function parentTargets(
  route: ClusterObject,
  gateways: readonly GatewayStatus[],
): readonly string[] {
  const targets: string[] = [];
  for (const parent of route.spec?.parentRefs ?? []) {
    const gateway = gateways.find(
      (candidate) =>
        candidate.name === parent.name &&
        candidate.namespace === (parent.namespace ?? route.metadata.namespace),
    );
    if (gateway === undefined) continue;
    const stated = gateway.annotations?.[TARGET];
    targets.push(
      ...(stated === undefined ? gateway.addresses : stated.split(',')),
    );
  }
  return targets;
}

function heldOut(object: ClusterObject): boolean {
  const claimed = object.metadata.annotations?.[CONTROLLER];
  return claimed !== undefined && claimed !== CONTROLLER_ID;
}

function proxied(config: Record<string, string> | undefined): boolean {
  return config?.[PROXIED] === 'true';
}

/** An address is an address record; anything else is a name. */
function suitableType(target: string): string {
  if (IPV4.test(target)) return 'A';
  return target.includes(':') ? 'AAAA' : 'CNAME';
}
