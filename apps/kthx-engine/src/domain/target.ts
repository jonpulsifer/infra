/**
 * The Target: one adapter on one vessel, identified by that pair. Health is a
 * standing checklist, and disconnect orphans live Deploys while their workloads
 * keep running.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import { isLabel } from './naming.ts';
import {
  DATASTORE_SURFACE_BY_VESSEL_KIND,
  type GcpProjectNetwork,
  type VesselKind,
  type VesselLocation,
} from './vessel.ts';

/**
 * Adapter-specific connection facts, stored by core and handed to the adapter
 * unparsed. No variant holds a credential.
 */
export type TargetConnection =
  | KubernetesConnection
  | CloudRunConnection
  | StaticConnection
  | VercelConnection
  | CloudflarePagesConnection;

export type TargetWithConnection<
  T extends { connection: TargetConnection | null },
> = T & { readonly connection: TargetConnection };

export function hasTargetConnection<
  T extends { connection: TargetConnection | null },
>(target: T): target is TargetWithConnection<T> {
  return target.connection !== null;
}

export interface CloudRunConnection {
  adapter: 'cloudrun';
  region: string;
  /**
   * API root without a trailing slash. Absent uses the adapter's default; set it
   * only behind a perimeter or a mirror.
   */
  endpoint?: string;
  /**
   * The binary authorization API root. No default: its presence turns on the
   * project's admission policy, and absent means verification is not known.
   */
  policyEndpoint?: string;
  /**
   * The identity a revision runs as. Absent, Cloud Run uses the default compute
   * account, which the controller cannot `actAs`, so the apply is refused.
   */
  serviceAccount?: string;
  /** How far back a tail can reach, in seconds. */
  logHistorySeconds?: number;
}

export interface StaticConnection {
  adapter: 'static';
  /** API root without a trailing slash; absent uses the adapter's default. */
  endpoint?: string;
}

/**
 * The platform has no inbound OIDC, so its bearer token is an installation
 * Secret read per request, never stored per Target.
 */
export interface VercelConnection {
  adapter: 'vercel';
  /** API root without a trailing slash; absent uses the adapter's default. */
  endpoint?: string;
}

/**
 * The bearer token is an installation Secret, as for Vercel. The production
 * branch is read back off the project, never stated here.
 */
export interface CloudflarePagesConnection {
  adapter: 'cloudflare-pages';
  /** API root without a trailing slash; absent uses the adapter's default. */
  endpoint?: string;
}

/**
 * The delivery flavour is per Target: two clusters may run different GitOps
 * operators. Core stores the rest unparsed for the adapter.
 */
export interface KubernetesConnection {
  adapter: 'kubernetes';
  /**
   * The namespace the connect probe reads, and whose admission labels App
   * namespaces copy. New releases go to {@link appNamespaceFor}'s namespace.
   */
  namespace: string;
  /** The pattern for an App's own namespace, containing `{app}`. */
  appNamespace?: string;
  /** Where Datastores are provisioned; never an App's namespace. */
  datastoreNamespace?: string;
  delivery: KubernetesDelivery;
  /**
   * How far back a tail can reach, in seconds. Stated, because the log store is
   * outside the cluster.
   */
  logHistorySeconds?: number;
  /**
   * The operator's half of the chart value contract, untyped here. What an
   * operator may write is enforced where it is saved.
   */
  chartValues?: Record<string, unknown>;
}

/**
 * Both carry the chart's source object, which makes its presence in the cluster
 * a checkable prerequisite.
 */
export const KUBERNETES_DELIVERY_FLAVOURS = [
  'flux-helmrelease',
  'argo-application',
] as const;

/** Which GitOps operator drives one Target. Vocabulary, never an identity. */
export type KubernetesDeliveryFlavour =
  (typeof KUBERNETES_DELIVERY_FLAVOURS)[number];

export type KubernetesDelivery =
  | {
      flavour: 'flux-helmrelease';
      /** Namespace the `HelmRelease` object itself is created in. */
      namespace: string;
      /** An `OCIRepository` or `GitRepository`, per the installation's `charts.app`. */
      sourceRef: { name: string; namespace: string };
    }
  | {
      flavour: 'argo-application';
      /** Namespace the Argo `Application` object is created in. */
      namespace: string;
      project: string;
      /** The repository the App chart is fetched from, and at which revision. */
      repoUrl: string;
      revision: string;
      /** The cluster Argo deploys to, in Argo's own vocabulary. */
      server: string;
    };

export interface DeployTargetRef extends TargetIdentity {
  readonly connection: AdapterConnection;
}

/** The flat connection an adapter receives: surface facts plus its vessel's. */
export type AdapterConnection =
  // Both project surfaces receive the vessel's network; only `cloudrun` reads it.
  | (KubernetesConnection & VesselFacts & { apiServer: string })
  | (CloudRunConnection &
      VesselFacts & { project: string; network?: GcpProjectNetwork })
  | (StaticConnection &
      VesselFacts & { project: string; network?: GcpProjectNetwork })
  | (VercelConnection & VesselFacts & { team: string })
  | (CloudflarePagesConnection & VesselFacts & { account: string });

/** The boundary's half of the flat view, identical for every surface on it. */
interface VesselFacts {
  servedHosts?: readonly string[];
  reachableRegistries?: readonly string[];
}

export type KubernetesAdapterConnection = Extract<
  AdapterConnection,
  { adapter: 'kubernetes' }
>;
export type CloudRunAdapterConnection = Extract<
  AdapterConnection,
  { adapter: 'cloudrun' }
>;
export type StaticAdapterConnection = Extract<
  AdapterConnection,
  { adapter: 'static' }
>;
export type VercelAdapterConnection = Extract<
  AdapterConnection,
  { adapter: 'vercel' }
>;
export type CloudflarePagesAdapterConnection = Extract<
  AdapterConnection,
  { adapter: 'cloudflare-pages' }
>;

/**
 * A default, not a required field: requiring it would invalidate every stored
 * manifest and re-seed the installation, losing UI-connected Targets.
 */
const DEFAULT_APP_NAMESPACE = 'app-{app}';

const DEFAULT_DATASTORE_NAMESPACE = 'spindrift-datastores';

/**
 * Per App, so the chart's same-namespace `podSelector: {}` allow covers only that
 * App. Length is checked on the write path by {@link namespaceRefusal}.
 */
export function appNamespaceFor(
  connection: Pick<KubernetesConnection, 'appNamespace'>,
  app: string,
): string {
  return (connection.appNamespace ?? DEFAULT_APP_NAMESPACE).replaceAll(
    '{app}',
    app,
  );
}

export function datastoreNamespaceFor(
  connection: Pick<KubernetesConnection, 'datastoreNamespace'>,
): string {
  return connection.datastoreNamespace ?? DEFAULT_DATASTORE_NAMESPACE;
}

/**
 * `null` when the namespace is one legal DNS label. Otherwise it is refused with
 * both names, never truncated into a namespace the operator cannot find.
 */
export function namespaceRefusal(
  connection: Pick<KubernetesConnection, 'appNamespace'>,
  app: string,
): string | null {
  const namespace = appNamespaceFor(connection, app);
  return isLabel(namespace)
    ? null
    : `App '${app}' under this installation's namespace pattern is '${namespace}', which is not one DNS label of at most 63 characters`;
}

/** The vessel columns {@link deployTargetOf} reads. */
export interface VesselRef {
  readonly name: string;
  readonly location: VesselLocation;
  readonly servedHosts: readonly string[] | null;
  readonly reachableRegistries: readonly string[] | null;
}

/** Mirrors {@link hasTargetConnection}: a Target is addressable when both hold. */
export function hasVesselLocation<
  T extends { location: VesselLocation | null },
>(vessel: T): vessel is T & VesselRef {
  return vessel.location !== null;
}

/** Composes the surface's connection with its vessel's location and reach. */
export function deployTargetOf(
  target: {
    adapter: TargetAdapter;
    connection: TargetConnection;
  },
  vessel: VesselRef,
): DeployTargetRef {
  const reach = {
    ...(vessel.servedHosts === null ? {} : { servedHosts: vessel.servedHosts }),
    ...(vessel.reachableRegistries === null
      ? {}
      : { reachableRegistries: vessel.reachableRegistries }),
  };
  const where = addressOf(vessel.location);

  return {
    vessel: vessel.name,
    adapter: target.adapter,
    // The cast asserts `where` is this arm's address; `unstatedAddress` checks it.
    connection: {
      ...target.connection,
      ...reach,
      ...where,
    } as AdapterConnection,
  };
}

function addressOf(
  location: VesselLocation,
): Record<string, string | GcpProjectNetwork> {
  switch (location.kind) {
    case 'cluster':
      return { apiServer: location.apiServer };
    case 'gcp-project':
      // `cloudrun` discovery derives a capability from the network's presence.
      return {
        project: location.project,
        ...(location.network === undefined
          ? {}
          : { network: location.network }),
      };
    case 'vercel-team':
      return { team: location.team };
    case 'cloudflare-account':
      return { account: location.account };
  }
}

/** The address field each arm of {@link AdapterConnection} requires. */
const ADDRESS_BY_ADAPTER = {
  kubernetes: 'apiServer',
  cloudrun: 'project',
  static: 'project',
  vercel: 'team',
  'cloudflare-pages': 'account',
} as const satisfies Record<TargetAdapter, string>;

/**
 * `null` when the connection is whole. A surface on a vessel of another kind has
 * no address, reported as an unmet checklist item so no adapter gets the hole.
 */
export function unstatedAddress(target: DeployTargetRef): string | null {
  const { connection } = target;
  const address = ADDRESS_BY_ADAPTER[target.adapter];
  // The key exists only when the vessel's location matched this arm.
  const stated =
    address in connection &&
    (connection as unknown as Record<string, unknown>)[address] !== '';
  if (stated) return null;
  return `this vessel's location states no ${address}, so a ${target.adapter} surface on it has no address to be reached at`;
}

/**
 * No `unknown`: connect replaces a seeded Target's checklist with a real
 * inspection before it returns.
 */
export type TargetHealth = 'healthy' | 'unhealthy';

/**
 * Orphaning and faults are core-side timestamps beside the phase, not phases:
 * the rollout's verdict does not change.
 */
export type DeployState = 'orphaned' | 'live' | 'faulty' | 'pending' | 'failed';

export interface DeployStateInput {
  phase: 'PENDING' | 'APPLYING' | 'WAITING' | 'LIVE' | 'FAILED';
  orphanedAt: Date | null;
  /** The soak's verdict after readiness. */
  faultyAt: Date | null;
}

/** Orphaning is the most recent fact and wins; a fault overrides `LIVE`. */
export function deployState(deploy: DeployStateInput): DeployState {
  if (deploy.orphanedAt !== null) return 'orphaned';
  switch (deploy.phase) {
    case 'LIVE':
      return deploy.faultyAt === null ? 'live' : 'faulty';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The Deploy phases a disconnect strands — anything that reached the Target. */
export const STRANDABLE_PHASES = ['APPLYING', 'WAITING', 'LIVE'] as const;

/** Unique as a pair: a vessel carries one runtime of each kind. */
export interface TargetIdentity {
  readonly vessel: string;
  readonly adapter: TargetAdapter;
}

/**
 * `<vessel>/<adapter>`, for humans. Nothing parses it back: every act takes the
 * id, or the vessel and adapter as two fields.
 */
export function targetLabel(target: TargetIdentity): string {
  return `${target.vessel}/${target.adapter}`;
}

/** `'none'` for an absent row: a Component never placed has no Target. */
export function targetRowLabel(
  target:
    | { adapter: TargetAdapter; vessel: { name: string } }
    | null
    | undefined,
): string {
  return target == null
    ? 'none'
    : targetLabel({ vessel: target.vessel.name, adapter: target.adapter });
}

/**
 * Falls back to the bare vessel name, never a throw, so one malformed row
 * cannot crash a screen.
 */
export function datastoreVesselLabel(vessel: {
  readonly name: string;
  readonly kind: VesselKind;
}): string {
  const adapter = DATASTORE_SURFACE_BY_VESSEL_KIND[vessel.kind];
  return adapter === undefined
    ? vessel.name
    : targetLabel({ vessel: vessel.name, adapter });
}
