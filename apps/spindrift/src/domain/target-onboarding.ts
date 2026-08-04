/**
 * What is left to connect, and what to propose for it (§13).
 *
 * The manifest seeds Target **identities**: a name, an adapter, and a rank,
 * with connection facts optional. A seed with no connection produces a row
 * whose checklist reads "Target connection has not been configured" and whose
 * `connection` column is null — a real, visible, half-ready state, exactly as
 * §13 intends. What did not exist was any way to finish it from the product:
 * `connectTarget` has always been a command with no screen.
 *
 * This module is the small amount of domain reasoning that screen needs, and
 * it is here rather than in the view for the usual reason — the browser would
 * otherwise be deriving it from connection blobs it has no business holding.
 *
 * Two jobs:
 *
 * 1. **Group Targets back into acts.** Connecting a cloud project registers
 *    both of its Targets (§13), so two unconfigured rows named
 *    `<project>-cloudrun` and `<project>-static` are *one* thing to do, named
 *    `<project>`. A screen listing two cards would reintroduce the second noun
 *    §13 removed.
 * 2. **Propose what can honestly be proposed.** See
 *    {@link TargetConnectionProposal} — carried from a working Target of the
 *    same adapter, never from a literal, and never for a value that is
 *    per-instance.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type {
  PendingTargetConnection,
  TargetConnectionProposal,
} from '../web/model.ts';
import { surfaceNames, type TargetConnection } from './target.ts';
import type { VesselKind } from './vessel.ts';

/** The columns this reasoning reads, without importing the table. */
export interface OnboardingTargetRow {
  readonly name: string;
  readonly adapter: TargetAdapter;
  readonly connection: TargetConnection | null;
  readonly health: 'healthy' | 'unhealthy';
  /** The boundary this surface sits on — what groups the rows into acts. */
  readonly vessel: {
    readonly id: string;
    readonly name: string;
    readonly kind: VesselKind;
  };
}

/**
 * The Target a proposal is carried from.
 *
 * Prefers a healthy one. A configured-but-unhealthy Target's connection facts
 * are the facts of something that does not work, and copying them forward is
 * the fastest way to make one broken Target into two.
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
  // `apiServer` is deliberately absent. It is the one field here that names a
  // particular cluster, and a second cluster prefilled with the first one's
  // address — `https://kubernetes.default.svc` on an in-cluster install —
  // would read as correct and deploy somewhere else.
  return {
    carriedFrom: from?.name ?? null,
    namespace: connection.namespace,
    deliveryFlavour: connection.delivery.flavour,
    ...(connection.delivery.flavour === 'flux-helmrelease'
      ? { sourceRef: connection.delivery.sourceRef }
      : {}),
    // Carried whole. What the screen takes out of it is `platform.externalAuth`
    // and `platform.secretStore`'s kind — the parts `clusters/base` makes the
    // same on every cluster. What it must not take is `platform.dns`, which
    // names one cluster's gateway address; the screen reads that off the probe
    // instead, and the split is stated here rather than performed here so a
    // second consumer cannot get it the other way round.
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
  // `project` is absent for the same reason `apiServer` is: connecting a second
  // cloud project and being handed the first project's id is the one mistake
  // this screen could make that nobody would catch by reading.
  return {
    carriedFrom: run?.name ?? hosting?.name ?? null,
    ...(runConnection === null
      ? {}
      : {
          region: runConnection.region,
          runEndpoint: runConnection.endpoint,
          ...(runConnection.policyEndpoint === undefined
            ? {}
            : { policyEndpoint: runConnection.policyEndpoint }),
        }),
    ...(hostingConnection === null
      ? {}
      : { hostingEndpoint: hostingConnection.endpoint }),
  };
}

/** What a screen would propose for a fresh connect of this shape. */
export function connectionProposal(
  rows: readonly OnboardingTargetRow[],
  kind: VesselKind,
): TargetConnectionProposal {
  return kind === 'cluster' ? kubernetesProposal(rows) : cloudProposal(rows);
}

/**
 * Every connect act this installation is waiting on.
 *
 * A Target with a connection is not here however unhealthy it is — an unmet
 * checklist item is something to fix on the Target, not a connection to
 * supply, and §13 keeps those apart on purpose. Only `connection === null`,
 * the state nothing but a manifest seed produces, is an act that is still
 * owed.
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
      name: vessel.name,
      // Every surface the act will write, whether or not all of them are
      // unconfigured today: connecting re-registers the whole vessel, and
      // saying so is what stops the confirmation from under-reporting what it
      // is about to touch. Read off the vessel's kind rather than recovered
      // from a name.
      targets: surfaceNames(vessel.kind, vessel.name).map(
        (surface) => surface.name,
      ),
      proposal: connectionProposal(rows, vessel.kind),
    };
  });
}

// --- Connecting a cluster, one component at a time --------------------------

/** §3's reach vocabulary, as both the seed and the connect act spell it. */
type Reach = 'none' | 'private' | 'public';

/**
 * What an operator picked on the connect screen.
 *
 * Three of these are required because a Target without them is not addressable,
 * and the rest are **components**: each one is a thing this cluster already runs
 * that an App's release can be made to blend into, and each is `null` when the
 * operator left it out. Leaving one out is a supported answer everywhere — a
 * cluster with no gateway serves nothing but in-cluster traffic, which §3 spells
 * `none` and is a real Target.
 */
export interface ClusterConnectChoices {
  readonly name: string;
  readonly apiServer: string;
  /** Where App workloads land. Never created by Spindrift (§7). */
  readonly namespace: string;
  /** Where the `HelmRelease` object itself is created. */
  readonly deliveryNamespace: string;
  /** The `GitRepository` the App chart is fetched from. */
  readonly sourceRef: { readonly name: string; readonly namespace: string };
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
  /** The `ClusterSecretStore` config is fetched through (§10). */
  readonly secretStore: string | null;
  /** The tunnel this Target answers public traffic through, where it has one. */
  readonly tunnelHostname: string | null;
}

/** What `connectTarget` takes for a cluster, assembled from the choices. */
export interface ClusterConnectPlan {
  readonly kind: 'cluster';
  readonly name: string;
  readonly apiServer: string;
  readonly namespace: string;
  readonly delivery: {
    readonly flavour: 'flux-helmrelease';
    readonly namespace: string;
    readonly sourceRef: { readonly name: string; readonly namespace: string };
  };
  readonly chartValues: Record<string, unknown>;
  readonly reaches: Reach[];
  readonly authReaches: Reach[];
}

/**
 * Turn the operator's choices into one connect act.
 *
 * This is the whole of the screen's reasoning and it is here rather than in the
 * view for the reason the top of this file gives: three of the values below are
 * **derived from what was included**, and a browser deriving them is a browser
 * that can derive them differently from the next screen that needs to.
 *
 * The three:
 *
 * - **`reaches`** follows from the components. `none` is always true — a
 *   Component reachable only in-cluster needs nothing. `private` is true exactly
 *   when a gateway with an address was included, because that address *is* the
 *   private reach. `public` is true exactly when a tunnel was named.
 * - **`authReaches`** is `private` and never `public`, whatever the edge could
 *   technically front. An authenticated proxy admitting one account is honest in
 *   front of an RFC1918 address and a claim in front of one anybody can reach,
 *   and the claim is not this function's to make. **ponytail:** widening it is a
 *   manifest edit today; give it a control when an installation runs an edge
 *   whose policy actually holds publicly.
 * - **`networkPolicy.allowedNamespaces`** is the namespaces of the components
 *   that were included, less the one the workloads are in. The chart's ingress
 *   is default-deny, so a component that reaches a Component from a namespace
 *   nobody listed reaches nothing. Its own namespace is left out because the
 *   chart already admits same-namespace siblings unconditionally, and writing
 *   one would put a name in the list that means nothing.
 *
 *   **This list is not what admits a route, and never was.** A gateway's data
 *   plane need not be a pod in the gateway's namespace — Cilium terminates a
 *   listener in a host-networked DaemonSet, so the connection arrives with an
 *   identity rather than from a location, and no namespace written here matches
 *   it. The chart admits that identity itself (`templates/networkpolicy.yaml`,
 *   second document). What these names still buy is the other class of
 *   implementation, where the data plane *is* a pod one can point at — so the
 *   gateway's namespace stays derived rather than dropped.
 */
export function clusterConnectPlan(
  choices: ClusterConnectChoices,
): ClusterConnectPlan {
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
    name: choices.name,
    apiServer: choices.apiServer,
    namespace: choices.namespace,
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: choices.deliveryNamespace,
      sourceRef: choices.sourceRef,
    },
    // Only `platform`. §7 gives that key to the operator whole and Spindrift
    // renders `app` and `shared` per deploy, so writing either here would be
    // saving a value the next deploy overwrites.
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
    authReaches:
      choices.externalAuth === null || !reaches.includes('private')
        ? []
        : ['private'],
  };
}

/**
 * The same act, as the installation manifest declares it.
 *
 * §13's connect and `targets[]` in the manifest are two spellings of one thing,
 * and this function is the proof — the screen renders what it is about to do as
 * the document that would do it, so an operator connecting a cluster through the
 * UI can put the identical connection in Git and a torn-down installation comes
 * back with it. That is the whole of "connectable both ways": not two code
 * paths, one shape with two entry points.
 *
 * Returned as an object rather than as text. JSON is valid YAML, so a caller
 * that wants a document has `JSON.stringify` and no emitter to maintain.
 */
export function targetSeedOf(
  plan: ClusterConnectPlan,
): Record<string, unknown> {
  return {
    name: plan.name,
    // A connected cluster's one surface takes the vessel's name unchanged —
    // the same rule `vesselFor` applies on the connect path, so the document
    // and the act name the same boundary.
    vessel: plan.name,
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

/**
 * The boundary half of the same act, under `vessels:`.
 *
 * Separate from {@link targetSeedOf} because the two land in different arrays
 * of one document, and one act now writes to both: where the cluster is is a
 * fact about the boundary, not about the surface deployed onto it.
 */
export function vesselSeedOf(
  plan: ClusterConnectPlan,
): Record<string, unknown> {
  return {
    name: plan.name,
    kind: 'cluster',
    location: { apiServer: plan.apiServer },
  };
}
