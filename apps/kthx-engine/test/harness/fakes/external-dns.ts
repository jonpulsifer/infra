/**
 * The records external-dns's `crd` and `gateway-httproute` sources would
 * publish from rendered objects. Which sources run is read from the cluster
 * manifests by `../external-dns-installation.ts`.
 */
import { ANNOTATION_PREFIXES } from '../../../src/adapters/dns/cluster.ts';

/** The controller as a cluster declares it. */
export interface Controller {
  readonly cluster: string;
  /** `--source=…`, as that cluster declares them. */
  readonly sources: readonly string[];
  /** `--annotation-prefix=…`, or `null` when left to the version's default. */
  readonly annotationPrefix: string | null;
}

/** The keys one controller reads, built as external-dns builds them. */
function keysOf(controller: Controller) {
  const prefix = controller.annotationPrefix;
  if (prefix === null) {
    throw new Error(
      `${controller.cluster}'s external-dns leaves --annotation-prefix ` +
        'defaulted, and that default changed in v0.22.0: which keys it reads ' +
        'is a fact about the image tag, which this model cannot see',
    );
  }
  return {
    controller: `${prefix}controller`,
    target: `${prefix}target`,
    proxied: `${prefix}cloudflare-proxied`,
  };
}

type Keys = ReturnType<typeof keysOf>;

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

export interface GatewayStatus {
  name: string;
  namespace: string;
  /** `status.addresses[*].value` — the route source's fallback target. */
  addresses: readonly string[];
  annotations?: Record<string, string>;
}

export interface PublishedRecord {
  dnsName: string;
  recordType: string;
  targets: readonly string[];
  proxied: boolean;
  /** `crd/<name>` or `httproute/<name>`: the source and the object it read. */
  claimedBy: string;
}

export interface Publication {
  readonly records: readonly PublishedRecord[];
  /** Names more than one source claimed, which soft-errors a whole-zone sync. */
  readonly contended: readonly string[];
}

/**
 * The hold-out annotation under every prefix, since its key is the prefix plus
 * `controller`. Every writer here sets all of them.
 */
export const CONTROLLER_KEYS = ANNOTATION_PREFIXES.map(
  (prefix) => `${prefix}controller`,
);

/** Upstream's `ControllerValue`, which no flag changes. */
export const CONTROLLER_ID = 'dns-controller';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** What the controller would publish for one namespace's objects. */
export function publish(
  objects: readonly ClusterObject[],
  gateways: readonly GatewayStatus[],
  controller: Controller,
): Publication {
  const keys = keysOf(controller);
  const records = [
    ...(controller.sources.includes('crd') ? fromEndpoints(objects, keys) : []),
    ...(controller.sources.includes('gateway-httproute')
      ? fromRoutes(objects, gateways, keys)
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
function fromEndpoints(
  objects: readonly ClusterObject[],
  keys: Keys,
): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const object of objects) {
    if (object.kind !== 'DNSEndpoint' || heldOut(object, keys)) continue;
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
          keys,
        ),
        claimedBy: `crd/${object.metadata.name}`,
      });
    }
  }
  return records;
}

/**
 * The `gateway-httproute` source: one endpoint per hostname, targeted at the
 * parent Gateway. Listener matching is skipped: the Gateway's wildcard covers it.
 */
function fromRoutes(
  objects: readonly ClusterObject[],
  gateways: readonly GatewayStatus[],
  keys: Keys,
): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const object of objects) {
    if (object.kind !== 'HTTPRoute' || heldOut(object, keys)) continue;
    const targets = parentTargets(object, gateways, keys);
    if (targets.length === 0) continue;
    for (const hostname of object.spec?.hostnames ?? []) {
      records.push({
        dnsName: hostname,
        // One record type for the set, from its first target, as the source does.
        recordType: suitableType(targets[0] as string),
        targets,
        proxied: proxied(object.metadata.annotations, keys),
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
  keys: Keys,
): readonly string[] {
  const targets: string[] = [];
  for (const parent of route.spec?.parentRefs ?? []) {
    const gateway = gateways.find(
      (candidate) =>
        candidate.name === parent.name &&
        candidate.namespace === (parent.namespace ?? route.metadata.namespace),
    );
    if (gateway === undefined) continue;
    const stated = gateway.annotations?.[keys.target];
    targets.push(
      ...(stated === undefined ? gateway.addresses : stated.split(',')),
    );
  }
  return targets;
}

/**
 * Upstream documents this skip for the route source only; applying it to `crd`
 * too can only make the model publish less.
 */
function heldOut(object: ClusterObject, keys: Keys): boolean {
  const claimed = object.metadata.annotations?.[keys.controller];
  return claimed !== undefined && claimed !== CONTROLLER_ID;
}

function proxied(
  config: Record<string, string> | undefined,
  keys: Keys,
): boolean {
  return config?.[keys.proxied] === 'true';
}

/** An address is an address record; anything else is a name. */
function suitableType(target: string): string {
  if (IPV4.test(target)) return 'A';
  return target.includes(':') ? 'AAAA' : 'CNAME';
}
