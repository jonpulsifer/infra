/**
 * The reasoning behind the connect screen: which Targets still need a
 * connection, grouped by vessel, and what to prefill from a working Target of
 * the same adapter. A value that names one instance is never carried.
 */

import type {
  PendingTargetConnection,
  TargetConnectionProposal,
} from '../commands/views.ts';
import type { TargetAdapter } from '../config/manifest.schema.ts';
import {
  type KubernetesDelivery,
  type TargetConnection,
  targetLabel,
} from './target.ts';
import { surfacesToProbe, type VesselKind } from './vessel.ts';

function labelOf(row: OnboardingTargetRow | undefined): string | null {
  return row === undefined
    ? null
    : targetLabel({ vessel: row.vessel.name, adapter: row.adapter });
}

export interface OnboardingTargetRow {
  readonly adapter: TargetAdapter;
  readonly connection: TargetConnection | null;
  readonly health: 'healthy' | 'unhealthy';
  /** Groups the rows into connect acts. */
  readonly vessel: {
    readonly id: string;
    readonly name: string;
    readonly kind: VesselKind;
  };
}

/**
 * Prefers a healthy Target: copying a broken Target's facts forward makes a
 * second broken one.
 */
function donor(
  rows: readonly OnboardingTargetRow[],
  adapter: TargetAdapter,
): OnboardingTargetRow | undefined {
  const configured = rows.filter(
    (row) => row.adapter === adapter && row.connection !== null,
  );
  return configured.find((row) => row.health === 'healthy') ?? configured[0];
}

function kubernetesProposal(
  rows: readonly OnboardingTargetRow[],
): TargetConnectionProposal {
  const from = donor(rows, 'kubernetes');
  const connection = from?.connection;
  if (connection === undefined || connection?.adapter !== 'kubernetes') {
    return { carriedFrom: null };
  }
  // No `apiServer`: it names one cluster, and a prefilled copy would read as
  // correct and deploy somewhere else.
  return {
    carriedFrom: labelOf(from),
    namespace: connection.namespace,
    deliveryFlavour: connection.delivery.flavour,
    ...(connection.delivery.flavour === 'flux-helmrelease'
      ? { sourceRef: connection.delivery.sourceRef }
      : {}),
    // Carried whole, but the screen takes only `platform.externalAuth`.
    // `platform.dns` names one cluster's gateway address and must not be reused.
    ...(connection.chartValues === undefined
      ? {}
      : { chartValues: connection.chartValues }),
  };
}

function cloudProposal(
  rows: readonly OnboardingTargetRow[],
): TargetConnectionProposal {
  const run = donor(rows, 'cloudrun');
  const runConnection =
    run?.connection?.adapter === 'cloudrun' ? run.connection : null;
  const hosting = donor(rows, 'static');
  const hostingConnection =
    hosting?.connection?.adapter === 'static' ? hosting.connection : null;

  if (runConnection === null && hostingConnection === null) {
    return { carriedFrom: null };
  }
  // No `project`, which names one boundary. No `endpoint`: each adapter
  // applies its own default.
  return {
    carriedFrom: labelOf(run ?? hosting),
    ...(runConnection === null
      ? {}
      : {
          region: runConnection.region,
          ...(runConnection.policyEndpoint === undefined
            ? {}
            : { policyEndpoint: runConnection.policyEndpoint }),
        }),
  };
}

/** Nothing: `team` names the boundary, and the adapter defaults its endpoint. */
function vercelProposal(): TargetConnectionProposal {
  return { carriedFrom: null };
}

/** Nothing: `account` names the boundary, and the adapter defaults its endpoint. */
function pagesProposal(): TargetConnectionProposal {
  return { carriedFrom: null };
}

export function connectionProposal(
  rows: readonly OnboardingTargetRow[],
  kind: VesselKind,
): TargetConnectionProposal {
  switch (kind) {
    case 'cluster':
      return kubernetesProposal(rows);
    case 'gcp-project':
      return cloudProposal(rows);
    case 'vercel-team':
      return vercelProposal();
    case 'cloudflare-account':
      return pagesProposal();
  }
}

/**
 * Only Targets with no connection, which only a manifest seed produces. A
 * connected but unhealthy Target is fixed on the Target, not here.
 */
export function pendingConnections(
  rows: readonly OnboardingTargetRow[],
): readonly PendingTargetConnection[] {
  const unconfigured = rows.filter((row) => row.connection === null);
  const byVessel = new Map<string, OnboardingTargetRow[]>();

  for (const row of unconfigured) {
    const group = byVessel.get(row.vessel.id);
    if (group === undefined) byVessel.set(row.vessel.id, [row]);
    else group.push(row);
  }

  return [...byVessel.values()].map((group) => {
    const vessel = group[0]!.vessel;
    return {
      kind: vessel.kind,
      vessel: vessel.name,
      // Connecting re-probes every surface of the vessel, configured or not.
      // It registers only what the probe finds, which can be fewer.
      surfaces: surfacesToProbe(vessel.kind),
      proposal: connectionProposal(rows, vessel.kind),
    };
  });
}

type Reach = 'none' | 'private' | 'public';

/**
 * Each component is `null` when the operator left it out. A cluster with no
 * gateway is still a Target, serving only in-cluster traffic.
 */
export interface ClusterConnectChoices {
  readonly vessel: string;
  readonly apiServer: string;
  /** Where App workloads are placed; never created here. */
  readonly namespace: string;
  /** Whole, so the screen cannot assemble a half-Flux, half-Argo delivery. */
  readonly delivery: KubernetesDelivery;
  /** The gateway routes attach to, and the address it answers on. */
  readonly gateway: {
    readonly name: string;
    readonly namespace: string;
    readonly privateAddress: string | null;
  } | null;
  /** The authenticated edge that stands in front, where there is one. */
  readonly externalAuth: {
    readonly name: string;
    readonly namespace: string;
    readonly port: number;
  } | null;
  /** The `ClusterSecretStore` config is fetched through. */
  readonly secretStore: string | null;
  /** The tunnel this Target answers public traffic through, where it has one. */
  readonly tunnelHostname: string | null;
}

/** What `connectTarget` takes for a cluster. */
export interface ClusterConnectPlan {
  readonly kind: 'cluster';
  readonly vessel: string;
  readonly apiServer: string;
  readonly namespace: string;
  readonly delivery: KubernetesDelivery;
  readonly chartValues: Record<string, unknown>;
  readonly reaches: Reach[];
  readonly authReaches: Reach[];
}

/**
 * `private` reach needs a gateway address and `public` a tunnel. The chart's
 * ingress is default-deny and admits the workloads' own namespace, so
 * `allowedNamespaces` lists each other included component's namespace.
 */
export function clusterConnectPlan(
  choices: ClusterConnectChoices,
): ClusterConnectPlan {
  // A Cilium gateway's host-networked data plane is admitted by identity in the
  // chart; these names cover gateways whose data plane is a pod.
  const allowedNamespaces = [
    ...new Set(
      [choices.gateway?.namespace, choices.externalAuth?.namespace].filter(
        (candidate): candidate is string =>
          (candidate ?? '') !== '' && candidate !== choices.namespace,
      ),
    ),
  ];
  const privateAddress = choices.gateway?.privateAddress ?? '';
  const tunnelHostname = choices.tunnelHostname ?? '';

  const reaches: Reach[] = [
    'none',
    ...(privateAddress === '' ? [] : (['private'] as const)),
    ...(tunnelHostname === '' ? [] : (['public'] as const)),
  ];

  return {
    kind: 'cluster',
    vessel: choices.vessel,
    apiServer: choices.apiServer,
    namespace: choices.namespace,
    delivery: choices.delivery,
    // Only `platform`: every deploy renders `app` and `shared` afresh.
    chartValues: {
      platform: {
        ...(choices.gateway === null
          ? {}
          : {
              gateway: {
                name: choices.gateway.name,
                namespace: choices.gateway.namespace,
              },
            }),
        ...(choices.externalAuth === null
          ? {}
          : { externalAuth: choices.externalAuth }),
        ...(choices.secretStore === null
          ? {}
          : {
              secretStore: {
                kind: 'ClusterSecretStore',
                name: choices.secretStore,
              },
            }),
        dns: { privateAddress, tunnelHostname },
        networkPolicy: { allowedNamespaces },
      },
    },
    reaches,
    // `private` only: a proxy that admits one account does not belong in front
    // of a public address. ponytail: widening it is a manifest edit; add a
    // control when an edge's policy holds publicly.
    authReaches:
      choices.externalAuth === null || !reaches.includes('private')
        ? []
        : ['private'],
  };
}

/**
 * The same act as the manifest declares it, so a cluster connected in the UI
 * can go into Git. JSON is valid YAML, so a caller stringifies it.
 */
export function targetSeedOf(
  plan: ClusterConnectPlan,
): Record<string, unknown> {
  return {
    vessel: plan.vessel,
    adapter: 'kubernetes',
    ...(plan.reaches.length > 0 ? { reaches: plan.reaches } : {}),
    ...(plan.authReaches.length > 0 ? { authReaches: plan.authReaches } : {}),
    connection: {
      namespace: plan.namespace,
      delivery: plan.delivery,
      chartValues: plan.chartValues,
    },
  };
}

/** The vessel half of the same act, under `vessels:`. */
export function vesselSeedOf(
  plan: ClusterConnectPlan,
): Record<string, unknown> {
  return {
    name: plan.vessel,
    kind: 'cluster',
    location: { apiServer: plan.apiServer },
  };
}
