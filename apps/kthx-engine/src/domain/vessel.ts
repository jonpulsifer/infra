/**
 * The Vessel: the tenancy boundary, reached with one credential, that a Target
 * is one runtime surface on. Deploy adapters never see the row:
 * `deployTargetOf` folds its facts into the `AdapterConnection` they receive.
 */
import type {
  AuthoredManifest,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type { Remediation } from './remediation.ts';

/**
 * The discriminant of {@link VesselLocation}, and nothing else. Which surfaces
 * a vessel carries comes from probing it, never from its kind.
 */
export const VESSEL_KINDS = [
  'cluster',
  'gcp-project',
  'vercel-team',
  'cloudflare-account',
] as const;

export type VesselKind = (typeof VESSEL_KINDS)[number];

/**
 * The surfaces a connect act asks a vessel of this kind about. The probe's
 * answer, not this table, decides which Targets exist.
 */
export const PROBED_SURFACES_BY_VESSEL_KIND = {
  cluster: ['kubernetes'],
  'gcp-project': ['cloudrun', 'static'],
  'vercel-team': ['vercel'],
  'cloudflare-account': ['cloudflare-pages'],
} as const satisfies Record<VesselKind, readonly TargetAdapter[]>;

export function surfacesToProbe(kind: VesselKind): readonly TargetAdapter[] {
  return PROBED_SURFACES_BY_VESSEL_KIND[kind];
}

/**
 * The surface a Datastore on a vessel of this kind is provisioned through. A
 * kind missing here hosts no Datastore.
 */
export const DATASTORE_SURFACE_BY_VESSEL_KIND: Partial<
  Record<VesselKind, TargetAdapter>
> = {
  cluster: 'kubernetes',
  'gcp-project': 'cloudrun',
};

/**
 * What the installation asks of a vessel, independent of its kind. One vessel
 * can hold several roles.
 */
export const VESSEL_ROLES = ['home', 'controlPlane', 'app'] as const;

export type VesselRole = (typeof VESSEL_ROLES)[number];

/** `app` means neither installation pointer names the vessel. */
export function vesselRolesOf(
  manifest: Pick<AuthoredManifest, 'installation'>,
  vessel: string,
): readonly VesselRole[] {
  const roles: VesselRole[] = [];
  if (vessel === manifest.installation.homeVessel) roles.push('home');
  if (vessel === manifest.installation.controlPlaneVessel) {
    roles.push('controlPlane');
  }
  return roles.length === 0 ? ['app'] : roles;
}

/** Prerequisites of the boundary itself, which belong to no Target on it. */
export const VESSEL_PREREQUISITES = [
  'SOURCE_BUCKET',
  'SECRET_STORE',
  'SIGNER_KEY',
  'ARTIFACTS_PROJECT',
] as const;

export type VesselPrerequisite = (typeof VESSEL_PREREQUISITES)[number];

/**
 * Only a cloud project home is asked anything; nothing here can read these from
 * another kind. An empty row keeps a check nobody ran from reading as passed.
 */
export const VESSEL_PREREQUISITES_BY_KIND_AND_ROLE = {
  cluster: { home: [], controlPlane: [], app: [] },
  'gcp-project': {
    home: ['SOURCE_BUCKET', 'SECRET_STORE', 'SIGNER_KEY', 'ARTIFACTS_PROJECT'],
    controlPlane: [],
    app: [],
  },
  'vercel-team': { home: [], controlPlane: [], app: [] },
  'cloudflare-account': { home: [], controlPlane: [], app: [] },
} as const satisfies Record<
  VesselKind,
  Record<VesselRole, readonly VesselPrerequisite[]>
>;

/** The union over every role, in {@link VESSEL_PREREQUISITES} order. */
export function vesselPrerequisitesFor(
  kind: VesselKind,
  roles: readonly VesselRole[],
): readonly VesselPrerequisite[] {
  const asked = new Set(
    roles.flatMap((role) => [
      ...VESSEL_PREREQUISITES_BY_KIND_AND_ROLE[kind][role],
    ]),
  );
  return VESSEL_PREREQUISITES.filter((name) => asked.has(name));
}

export interface VesselPrerequisiteResult {
  readonly name: VesselPrerequisite;
  readonly met: boolean;
  /** Why it is unmet. */
  readonly detail?: string;
  /**
   * `false` when the read was refused or unreachable. That establishes nothing,
   * so never read it as an absence.
   */
  readonly assessed?: boolean;
  /** The Terraform that would clear it. */
  readonly remediation?: Remediation;
}

export function unreachableVesselPrerequisites(
  detail: string,
  kind: VesselKind,
  roles: readonly VesselRole[],
): readonly VesselPrerequisiteResult[] {
  return vesselPrerequisitesFor(kind, roles).map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

/**
 * An app vessel is asked nothing, so it is always healthy. The Targets on it
 * carry their own checklist.
 */
export function deriveVesselHealth(
  prerequisites: readonly VesselPrerequisiteResult[],
  kind: VesselKind,
  roles: readonly VesselRole[],
): 'healthy' | 'unhealthy' {
  const met = new Set(
    prerequisites.filter((item) => item.met).map((i) => i.name),
  );
  return vesselPrerequisitesFor(kind, roles).every((name) => met.has(name))
    ? 'healthy'
    : 'unhealthy';
}

/**
 * `absent` is established and withholds the Target. `undetermined` (a 403, no
 * federation, a failed read) establishes nothing and registers it unhealthy.
 */
export type SurfaceProbe =
  | { readonly kind: 'carried' }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'undetermined'; readonly detail: string };

/**
 * No credential in any arm: each call is authorized per request by federation.
 */
export type VesselLocation =
  | ClusterLocation
  | GcpProjectLocation
  | VercelTeamLocation
  | CloudflareAccountLocation;

export interface ClusterLocation {
  kind: 'cluster';
  apiServer: string;
}

export interface GcpProjectLocation {
  kind: 'gcp-project';
  project: string;
  /**
   * Absent means the vessel cannot host a Datastore, which is not an unmet
   * prerequisite. Seeded from the manifest, never probed.
   */
  network?: GcpProjectNetwork;
}

/**
 * No subnet: the service connection policies Terraform creates already name
 * theirs, and the producer draws endpoints from them.
 */
export interface GcpProjectNetwork {
  /** The consumer network a PSC endpoint is created in. */
  name: string;
  /** Where the service connection policies are, so where an instance can go. */
  region: string;
}

export interface VercelTeamLocation {
  kind: 'vercel-team';
  /** The team or account. A Vercel project is one site inside it. */
  team: string;
}

/** Only the account id lives on the row; the token is the secret half. */
export interface CloudflareAccountLocation {
  kind: 'cloudflare-account';
  account: string;
  /**
   * The API root, without a trailing slash; absent means the adapter default.
   * On the boundary because every surface on the account shares one root.
   */
  endpoint?: string;
}

/**
 * What a pass read off the boundary itself. Zones and Workers belong to the
 * account, not to any one Target on it.
 */
export type VesselDiscovery = CloudflareAccountDiscovery;

export interface CloudflareZone {
  readonly name: string;
  readonly id: string;
  /** The platform's value: `active`, `pending`, `moved`. */
  readonly status: string;
}

/**
 * A `null` field means the read established nothing, and
 * {@link CloudflareAccountDiscovery.unreadable} says why. An empty array means
 * the listing answered with nothing in it.
 *
 * ponytail: one null and a sentence per read. Split absent from undetermined
 * when something branches on it.
 */
export interface CloudflareAccountDiscovery {
  readonly kind: 'cloudflare-account';
  /**
   * The platform's display name, which need not match the vessel name. A
   * missing one is cosmetic, never an `unreadable` entry.
   */
  readonly accountName?: string | null;
  readonly zones: readonly CloudflareZone[] | null;
  /** This account's `workers.dev` subdomain, when Workers is switched on. */
  readonly workersSubdomain: string | null;
  readonly pagesProjects: readonly string[] | null;
  /** Why a field above is `null`, keyed by the field. Absent when all read. */
  readonly unreadable?: Readonly<Record<string, string>>;
}

/**
 * The first declared zone this account carries. An unread listing falls back to
 * the first declared zone, so a failed probe never blocks a deploy on its own.
 */
export function servableZone(
  declared: readonly string[],
  carried: readonly CloudflareZone[] | null,
): string | null {
  if (carried === null) return declared[0] ?? null;
  const names = new Set(carried.map((zone) => zone.name));
  return declared.find((name) => names.has(name)) ?? null;
}

/**
 * Only facts true of every surface on the boundary. Which surfaces it carries
 * is the set of Targets referencing it, never a field here.
 */
export interface Vessel {
  readonly id: string;
  readonly name: string;
  readonly kind: VesselKind;
  readonly location: VesselLocation;
  /** Hosts the boundary's network serves itself, such as a registry mirror. */
  readonly servedHosts: readonly string[];
  /**
   * A bare host (`ghcr.io`) or a host/namespace (`ghcr.io/owner`);
   * {@link import('./desired-state.ts').pullableFrom} decides a match.
   */
  readonly reachableRegistries: readonly string[];
}

/** The union, never a winner: picking one claim would hide a disagreement. */
export function unionOfClaims(
  claims: readonly (readonly string[] | undefined)[],
): string[] {
  return [...new Set(claims.flatMap((claim) => claim ?? []))].sort();
}

export function claimsDisagree(
  claims: readonly (readonly string[] | undefined)[],
): boolean {
  const stated = claims.filter((claim) => claim !== undefined);
  if (stated.length < 2) return false;
  const first = JSON.stringify([...(stated[0] ?? [])].sort());
  return stated.some((claim) => JSON.stringify([...claim].sort()) !== first);
}
