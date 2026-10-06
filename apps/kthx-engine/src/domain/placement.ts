/**
 * Placement filters connected Targets by requirements derived from the App,
 * suggests the first candidate by rank, and lists every non-candidate with why.
 * A human breaks ties; nothing scores, packs or balances.
 */
import type {
  InstallationManifest,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import {
  capabilitiesOfRow,
  type TargetCapabilities,
  type TargetDiscovery,
} from './capabilities.ts';
import {
  type ArtifactType,
  type Auth,
  type ComponentKind,
  type Platform,
  pullableFrom,
  type Reach,
  type Resources,
} from './desired-state.ts';

/**
 * Detection reports no platform, so every workload is assumed to need this one
 * and no Target is excluded for an architecture nothing established.
 */
export const DEFAULT_PLATFORM: Platform = { os: 'linux', arch: 'amd64' };

/** Why a Target is not a candidate: a closed set, so the UI can key on it. */
export const EXCLUSIONS = [
  'UNHEALTHY',
  'KIND_UNSUPPORTED',
  'REACH_UNSUPPORTED',
  'AUTH_UNSUPPORTED',
  'NO_GATEWAY',
  'NO_SCHEDULER',
  'ARCH_UNSUPPORTED',
  'RESOURCES_EXCEED_CEILING',
  'NO_GPU',
  'NO_PERSISTENCE',
  'DATASTORE_ENGINE_MISSING',
  'DATASTORE_IS_CLUSTER_LOCAL',
  'STORE_UNREACHABLE',
  'REGISTRY_UNREACHABLE',
  'QUOTA_EXHAUSTED',
  'NO_ADAPTER',
] as const;

export type Exclusion = (typeof EXCLUSIONS)[number];

export interface PlacementTarget {
  readonly id: string;
  /** The vessel this Target is a surface on; half of what names it. */
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  /** Lower is considered first. */
  readonly rank: number;
  readonly healthy: boolean;
  readonly capabilities: TargetCapabilities;
  /**
   * On a cluster, whether the operator named a gateway in `chartValues`. Always
   * true on a backend that routes its own workloads.
   */
  readonly routesAttachTo: boolean;
  /** Absent means nothing has reported the quota full. */
  readonly quotaExhausted?: boolean;
}

/** Derived from the App; a developer never writes a requirement. */
export interface DerivedRequirements {
  readonly kind: ComponentKind;
  readonly reach: Reach;
  readonly auth: Auth;
  /** Absent means unscheduled; present needs a Target that can fire it. */
  readonly schedule?: string;
  readonly platform: Platform;
  readonly resources: Resources;
  readonly gpu: boolean;
  readonly persistence: boolean;
  readonly datastores: readonly RequiredDatastore[];
  readonly secretStore: TargetCapabilities['reachableSecretStores'][number];
  /**
   * Where every artifact is pushed. Checked before a Build dispatches, so a Target
   * that can pull from none is a non-candidate, never a failed revision.
   */
  readonly registries: readonly string[];
}

export interface RequiredDatastore {
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
  /** The one Target a cluster-local Datastore pins its App to; `null` otherwise. */
  readonly clusterLocalTargetId: string | null;
}

export interface Candidate {
  readonly target: PlacementTarget;
  readonly artifactType: ArtifactType;
}

export interface NonCandidate {
  readonly target: PlacementTarget;
  readonly reasons: readonly Exclusion[];
  /** One sentence per reason. */
  readonly detail: readonly string[];
}

/** `suggested` is `null` when nothing fits; `nonCandidates` say why. */
export interface Placement {
  readonly suggested: Candidate | null;
  readonly candidates: readonly Candidate[];
  readonly nonCandidates: readonly NonCandidate[];
}

/**
 * The `targets` columns {@link placementTargetOf} reads, typed structurally so
 * this domain module never imports the schema.
 */
interface RankedTargetRow {
  id: string;
  vessel: { name: string };
  adapter: TargetAdapter;
  rank: number;
  health: 'healthy' | 'unhealthy';
  discovery: TargetDiscovery | null;
  reaches: readonly Reach[] | null;
  authReaches: readonly Reach[] | null;
  /**
   * `adapter` keeps this from being a weak type, which flavours without
   * `chartValues` would fail. {@link capabilitiesOfRow} reads `serviceAccount`.
   */
  connection: {
    readonly adapter: TargetAdapter;
    readonly chartValues?: Record<string, unknown>;
    readonly serviceAccount?: string;
  } | null;
}

export function placementTargetOf(
  target: RankedTargetRow,
  options: {
    readonly artifactTypes: readonly ArtifactType[] | null;
    readonly manifest: InstallationManifest;
  },
): PlacementTarget {
  return {
    id: target.id,
    vessel: target.vessel.name,
    adapter: target.adapter,
    rank: target.rank,
    healthy: target.health === 'healthy',
    capabilities: capabilitiesOfRow(target, options),
    routesAttachTo: routesAttachTo(target),
  };
}

function routesAttachTo(target: RankedTargetRow): boolean {
  if (target.adapter !== 'kubernetes') return true;
  const platform = target.connection?.chartValues?.platform as
    | { gateway?: { name?: unknown } }
    | undefined;
  return (
    typeof platform?.gateway?.name === 'string' && platform.gateway.name !== ''
  );
}

/**
 * The shape a fresh Build for this placement produces. Whether an existing
 * artifact can be placed here is {@link takesShape}.
 */
export function artifactTypeFor(
  kind: ComponentKind,
  target: { readonly capabilities: Pick<TargetCapabilities, 'artifactTypes'> },
): ArtifactType {
  if (kind !== 'website') return 'image';
  // The edge platform's format first: it runs functions, so the site keeps SSR,
  // ISR and API routes.
  if (target.capabilities.artifactTypes.includes('vercel-output')) {
    return 'vercel-output';
  }
  if (target.capabilities.artifactTypes.includes('files')) {
    return 'files';
  }
  return 'image';
}

/**
 * The deploy path refuses with the same sentences, so a developer reads one
 * explanation at placement and at deploy.
 */
export function sentence(
  reason: Exclusion,
  requirements: Pick<DerivedRequirements, 'kind' | 'reach' | 'platform'>,
): string {
  switch (reason) {
    case 'UNHEALTHY':
      return 'this Target has unmet prerequisites';
    case 'KIND_UNSUPPORTED':
      return `this Target does not run ${requirements.kind}s`;
    case 'REACH_UNSUPPORTED':
      return requirements.reach === 'public'
        ? 'this Target has no way to serve a public address'
        : requirements.reach === 'private'
          ? 'this Target has no address on your own network to serve'
          : 'this Target serves everything it runs, so it cannot hold a Component with no route';
    case 'AUTH_UNSUPPORTED':
      return requirements.reach === 'public'
        ? "this Target's authenticated edge admits a single user, so it cannot stand in front of a public address"
        : 'this Target has no authenticated edge to put in front of this Component';
    case 'NO_GATEWAY':
      return 'this Target names no gateway for a route to attach to';
    case 'NO_SCHEDULER':
      return 'this Target runs a job but has nothing to fire it on a schedule';
    case 'ARCH_UNSUPPORTED':
      return `this Target does not run ${requirements.platform.arch}`;
    case 'RESOURCES_EXCEED_CEILING':
      return 'this workload asks for more than this Target admits';
    case 'NO_GPU':
      return 'this Target has no GPU';
    case 'NO_PERSISTENCE':
      return 'this Target has no persistent storage';
    case 'DATASTORE_ENGINE_MISSING':
      return 'this Target cannot host an attached datastore';
    case 'DATASTORE_IS_CLUSTER_LOCAL':
      return 'an attached datastore is cluster-local and lives elsewhere';
    case 'STORE_UNREACHABLE':
      return 'this Target cannot reach the secret store this App is configured through';
    case 'REGISTRY_UNREACHABLE':
      return 'this Target cannot pull from any registry this installation publishes to';
    case 'QUOTA_EXHAUSTED':
      return 'this Target has no quota left';
    case 'NO_ADAPTER':
      return 'this installation has no adapter for this Target';
    default:
      return unreachable(reason);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled exclusion: ${String(value)}`);
}

/** `null` for a missing or unparseable quantity, which {@link fits} reads as fitting. */
function quantity(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) return null;
  const scale: Record<string, number> = {
    '': 1,
    m: 0.001,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  const unit = scale[match[2] ?? ''];
  if (unit === undefined) return null;
  return Number(match[1]) * unit;
}

/** Does `asked` fit under `ceiling`? Unknown on either side means yes. */
function fits(asked: string | undefined, ceiling: string | undefined): boolean {
  const wanted = quantity(asked);
  const limit = quantity(ceiling);
  if (wanted === null || limit === null) return true;
  return wanted <= limit;
}

/**
 * The only exclusions the deploy path re-asks, so reach and auth hold at deploy.
 * Deploy skips the rest, so a rollback to an unhealthy Target still works.
 */
export function reachExclusions(
  can: Pick<TargetCapabilities, 'reaches' | 'authReaches'>,
  requirements: Pick<DerivedRequirements, 'reach' | 'auth'>,
): readonly Exclusion[] {
  const reasons: Exclusion[] = [];
  if (!can.reaches.includes(requirements.reach)) {
    reasons.push('REACH_UNSUPPORTED');
  }
  if (
    requirements.auth === 'proxy' &&
    !can.authReaches.includes(requirements.reach)
  ) {
    reasons.push('AUTH_UNSUPPORTED');
  }
  return reasons;
}

export function exclusionsFor(
  target: PlacementTarget,
  requirements: DerivedRequirements,
): readonly Exclusion[] {
  const reasons: Exclusion[] = [];
  const can = target.capabilities;

  if (can.artifactTypes.length === 0) reasons.push('NO_ADAPTER');
  if (!target.healthy) reasons.push('UNHEALTHY');
  if (!can.kinds.includes(requirements.kind)) reasons.push('KIND_UNSUPPORTED');

  reasons.push(...reachExclusions(can, requirements));

  // Running a job and firing it on a schedule are separate facts. Gated on the
  // kind so this never sits beside a contradicting KIND_UNSUPPORTED.
  if (
    requirements.schedule !== undefined &&
    can.kinds.includes(requirements.kind) &&
    !can.firesSchedules
  ) {
    reasons.push('NO_SCHEDULER');
  }

  // Otherwise the route's `parentRefs` names an empty Gateway and the Deploy
  // goes green with a URL that answers nothing.
  if (requirements.reach !== 'none' && !target.routesAttachTo) {
    reasons.push('NO_GATEWAY');
  }

  if (can.arch.length > 0 && !can.arch.includes(requirements.platform.arch)) {
    reasons.push('ARCH_UNSUPPORTED');
  }
  if (
    !fits(requirements.resources.cpu, can.resourceCeiling.cpu) ||
    !fits(requirements.resources.memory, can.resourceCeiling.memory)
  ) {
    reasons.push('RESOURCES_EXCEED_CEILING');
  }
  if (requirements.gpu && !can.gpu) reasons.push('NO_GPU');
  if (requirements.persistence && !can.persistence) {
    reasons.push('NO_PERSISTENCE');
  }

  for (const datastore of requirements.datastores) {
    if (
      datastore.clusterLocalTargetId !== null &&
      datastore.clusterLocalTargetId !== target.id
    ) {
      reasons.push('DATASTORE_IS_CLUSTER_LOCAL');
      continue;
    }
    const engine = datastore.engine === 'postgres' ? can.postgres : can.valkey;
    if (!engine) reasons.push('DATASTORE_ENGINE_MISSING');
  }

  // A website's config is all build arguments (`isBuildTimeConfig`), so it
  // reaches no store. The two must agree.
  if (
    requirements.kind !== 'website' &&
    !can.reachableSecretStores.includes(requirements.secretStore)
  ) {
    reasons.push('STORE_UNREACHABLE');
  }

  // Images only: other artifacts come from the depot. An empty
  // `reachableRegistries` declares no restriction.
  if (
    artifactTypeFor(requirements.kind, target) === 'image' &&
    can.reachableRegistries.length > 0 &&
    !requirements.registries.some((registry) =>
      pullableFrom(registry, can.reachableRegistries),
    )
  ) {
    reasons.push('REGISTRY_UNREACHABLE');
  }

  if (target.quotaExhausted === true) reasons.push('QUOTA_EXHAUSTED');

  return [...new Set(reasons)];
}

export function resolvePlacement(
  targets: readonly PlacementTarget[],
  requirements: DerivedRequirements,
): Placement {
  const ranked = [...targets].sort((a, b) => a.rank - b.rank);
  const candidates: Candidate[] = [];
  const nonCandidates: NonCandidate[] = [];

  for (const target of ranked) {
    const reasons = exclusionsFor(target, requirements);
    if (reasons.length === 0) {
      candidates.push({
        target,
        artifactType: artifactTypeFor(requirements.kind, target),
      });
    } else {
      nonCandidates.push({
        target,
        reasons,
        detail: reasons.map((reason) => sentence(reason, requirements)),
      });
    }
  }

  return {
    suggested: candidates[0] ?? null,
    candidates,
    nonCandidates,
  };
}

/**
 * The one shape gate deploy admission and build dispatch share. The equality arm
 * keeps a Target whose adapter is not shipped (an empty accept list) on `image`.
 */
export function takesShape(
  kind: ComponentKind,
  shape: ArtifactType,
  target: { readonly capabilities: Pick<TargetCapabilities, 'artifactTypes'> },
): boolean {
  return (
    shape === artifactTypeFor(kind, target) ||
    target.capabilities.artifactTypes.includes(shape)
  );
}
