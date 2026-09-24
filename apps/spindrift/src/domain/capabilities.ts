/**
 * What a Target can do. Each capability comes from the adapter type, discovery,
 * an operator's assertion, or derivation here; `placement.ts` matches them to Apps.
 */
import type {
  InstallationManifest,
  StoreAdapter,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type {
  ArtifactType,
  ComponentKind,
  Reach,
  Resources,
} from './desired-state.ts';
import type { Remediation } from './remediation.ts';
import type { SurfaceProbe } from './vessel.ts';

/** Every prerequisite name. {@link PREREQUISITES_BY_ADAPTER} picks each Target's checklist. */
export const PREREQUISITES = [
  'DELIVERY_OPERATOR',
  'CHART_SOURCE',
  'WRITABLE_STORE',
  'OIDC_FEDERATION',
  'VESSEL',
  'CHART_CONTRACT',
  'PLATFORM_API',
  'API_TOKEN',
] as const;

export type Prerequisite = (typeof PREREQUISITES)[number];

/**
 * The checklist each adapter type is assessed against. Only a cluster checks
 * `WRITABLE_STORE`, because only a cluster can lack one.
 */
export const PREREQUISITES_BY_ADAPTER = {
  kubernetes: [
    'DELIVERY_OPERATOR',
    'CHART_SOURCE',
    'WRITABLE_STORE',
    'OIDC_FEDERATION',
    'VESSEL',
    'CHART_CONTRACT',
  ],
  cloudrun: ['PLATFORM_API', 'OIDC_FEDERATION', 'VESSEL'],
  static: ['PLATFORM_API', 'OIDC_FEDERATION', 'VESSEL'],
  // These two federate no workload identity, so the API token is checked instead.
  vercel: ['PLATFORM_API', 'API_TOKEN', 'VESSEL'],
  'cloudflare-pages': ['PLATFORM_API', 'API_TOKEN', 'VESSEL'],
} as const satisfies Record<TargetAdapter, readonly Prerequisite[]>;

export function prerequisitesFor(
  adapter: TargetAdapter,
): readonly Prerequisite[] {
  return PREREQUISITES_BY_ADAPTER[adapter];
}

export interface PrerequisiteResult {
  readonly name: Prerequisite;
  readonly met: boolean;
  /** Why it is unmet. */
  readonly detail?: string;
  /**
   * `false` when no probe reached a verdict. The row still reads unmet, and
   * remediation proposes no change for it. Absent means assessed.
   */
  readonly assessed?: boolean;
  /**
   * The project a `SERVICE_DISABLED` refusal was about, when it is not the probed
   * one: GCP checks the token's consumer project, whatever project the URL names.
   */
  readonly consumer?: string;
  /** The Terraform that would clear it. Composed on read and never stored. */
  readonly remediation?: Remediation;
}

export type PolicyMode = 'ENFORCE' | 'AUDIT';

export interface PolicyEngineState {
  installed: boolean;
  /** `null` when no engine is installed. */
  mode: PolicyMode | null;
}

/**
 * Observations only. Core derives `verifiedDeploy` and `offlineDeploy`, so two
 * adapters cannot disagree on them.
 */
export interface TargetDiscovery {
  /** For example `amd64` or `arm64`. */
  arch: readonly string[];
  gpu: boolean;
  /** The largest single workload the Target will admit. */
  resourceCeiling: Resources;
  persistence: boolean;
  postgres: boolean;
  valkey: boolean;
  egressFiltering: boolean;
  policyEngine: PolicyEngineState;
  /** How far back a log tail can reach. Zero means no history, not no logs. */
  logHistorySeconds: number;
  /** Hosts the Target serves itself, such as an in-cluster registry mirror. */
  servedHosts: readonly string[];
  reachableRegistries: readonly string[];
  reachableSecretStores: readonly StoreAdapter[];
}

export interface TargetInspection {
  prerequisites: readonly PrerequisiteResult[];
  discovery: TargetDiscovery;
  /** Whether the boundary carries this surface at all, as the adapter observed. */
  surface: SurfaceProbe;
}

export interface DeployPathReferences {
  /** The App chart every Component renders through. */
  chart: string;
  /**
   * One per registry. A Target pulls from only one, so any served entry
   * satisfies `offlineDeploy`.
   */
  images: readonly string[];
  /** Where signature verification fetches its material. */
  verifier: string;
}

export function deployPathReferences(
  manifest: InstallationManifest,
): DeployPathReferences {
  return {
    chart: manifest.charts.app,
    images: manifest.supplyChain.registry,
    verifier: manifest.supplyChain.verifier,
  };
}

export interface TargetCapabilities {
  // From the adapter type.
  kinds: readonly ComponentKind[];
  /** Needs the adapter's support and a connection a schedule can fire as. */
  firesSchedules: boolean;
  artifactTypes: readonly ArtifactType[];

  // Discovered.
  arch: readonly string[];
  gpu: boolean;
  resourceCeiling: Resources;
  persistence: boolean;
  postgres: boolean;
  valkey: boolean;
  egressFiltering: boolean;
  verifiedDeploy: boolean;
  logHistorySeconds: number;

  // Asserted.
  reaches: readonly Reach[];
  authReaches: readonly Reach[];

  // Derived.
  reachableRegistries: readonly string[];
  reachableSecretStores: readonly StoreAdapter[];
  offlineDeploy: boolean;
}

/**
 * What each adapter renders. An unscheduled job is a suspended CronJob on a
 * cluster and a Job with no scheduler in front of it on Cloud Run.
 */
export const KINDS_BY_ADAPTER = {
  kubernetes: ['service', 'website', 'job'],
  cloudrun: ['service', 'website', 'job'],
  static: ['website'],
  vercel: ['website'],
  'cloudflare-pages': ['website'],
} as const satisfies Record<TargetAdapter, readonly ComponentKind[]>;

/**
 * Which adapters fire a job on its `schedule`. A Cloud Run Target also needs a
 * runtime identity; see `firesSchedulesOn`.
 */
export const FIRES_SCHEDULES_BY_ADAPTER = {
  kubernetes: true,
  cloudrun: true,
  static: false,
  vercel: false,
  'cloudflare-pages': false,
} as const satisfies Record<TargetAdapter, boolean>;

/**
 * The reaches each adapter serves before an operator asserts any. A cluster
 * needs an assertion for `public`, because no API reports a tunnel.
 */
export const ASSERTED_REACHES_BY_ADAPTER = {
  kubernetes: ['none', 'private'],
  // No `private`: nothing has an address on the operator's own network.
  cloudrun: ['none', 'public'],
  static: ['public'],
  vercel: ['public'],
  // The site's own edge address bypasses anything put in front of it.
  'cloudflare-pages': ['public'],
} as const satisfies Record<TargetAdapter, readonly Reach[]>;

/**
 * The authenticated edge each adapter has before an operator asserts one. Only
 * Cloud Run's invoker check is on by default.
 */
export const ASSERTED_AUTH_REACHES_BY_ADAPTER = {
  kubernetes: [],
  cloudrun: ['none', 'public'],
  static: [],
  // Vercel Authentication and Cloudflare Access are bought and configured, so
  // an operator asserts them.
  vercel: [],
  'cloudflare-pages': [],
} as const satisfies Record<TargetAdapter, readonly Reach[]>;

/** Static backends run no process, so the workspace offers them no runtime log stream. */
export const RUNS_NOTHING_BY_ADAPTER = {
  kubernetes: false,
  cloudrun: false,
  static: true,
  vercel: true,
  'cloudflare-pages': true,
} as const satisfies Record<TargetAdapter, boolean>;

export function runsNothingOn(adapter: TargetAdapter): boolean {
  return RUNS_NOTHING_BY_ADAPTER[adapter];
}

/** Installed is not enough: an audit-only engine passes every deploy green. */
export function deriveVerifiedDeploy(engine: PolicyEngineState): boolean {
  return engine.installed && engine.mode === 'ENFORCE';
}

/**
 * The host of a reference, without scheme, path, port or tag. An unparseable
 * reference yields itself, matches no served host, and fails `offlineDeploy` closed.
 */
export function hostOf(reference: string): string {
  const withoutScheme = reference.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0] ?? withoutScheme;
  const host = authority.split('@').pop() ?? authority;
  return host.split(':')[0] ?? host;
}

/** Proves the configuration, never the outcome: a served host can still be down. */
export function deriveOfflineDeploy(
  references: DeployPathReferences,
  servedHosts: readonly string[],
): boolean {
  const served = new Set(servedHosts.map(hostOf));
  return (
    [references.chart, references.verifier].every((reference) =>
      served.has(hostOf(reference)),
    ) && references.images.some((reference) => served.has(hostOf(reference)))
  );
}

export interface CapabilityContext {
  adapter: TargetAdapter;
  artifactTypes: readonly ArtifactType[];
  /** `null` means unasserted, and falls back to {@link ASSERTED_REACHES_BY_ADAPTER}. */
  reaches: readonly Reach[] | null;
  /** `null` falls back to {@link ASSERTED_AUTH_REACHES_BY_ADAPTER}; empty claims none. */
  authReaches: readonly Reach[] | null;
  deployPath: DeployPathReferences;
  /** `false` when the connection leaves a schedule nothing to fire as. Absent means true. */
  firesSchedules?: boolean;
}

export function resolveCapabilities(
  discovery: TargetDiscovery,
  context: CapabilityContext,
): TargetCapabilities {
  return {
    kinds: KINDS_BY_ADAPTER[context.adapter],
    firesSchedules:
      FIRES_SCHEDULES_BY_ADAPTER[context.adapter] &&
      (context.firesSchedules ?? true),
    artifactTypes: context.artifactTypes,

    arch: discovery.arch,
    gpu: discovery.gpu,
    resourceCeiling: discovery.resourceCeiling,
    persistence: discovery.persistence,
    postgres: discovery.postgres,
    valkey: discovery.valkey,
    egressFiltering: discovery.egressFiltering,
    verifiedDeploy: deriveVerifiedDeploy(discovery.policyEngine),
    logHistorySeconds: discovery.logHistorySeconds,

    reaches: context.reaches ?? ASSERTED_REACHES_BY_ADAPTER[context.adapter],
    authReaches:
      context.authReaches ?? ASSERTED_AUTH_REACHES_BY_ADAPTER[context.adapter],

    reachableRegistries: discovery.reachableRegistries,
    reachableSecretStores: discovery.reachableSecretStores,
    offlineDeploy: deriveOfflineDeploy(
      context.deployPath,
      discovery.servedHosts,
    ),
  };
}

/**
 * Every row unmet and unassessed, so connect still keeps the Target and states
 * the fault.
 */
export function unreachablePrerequisites(
  detail: string,
  adapter: TargetAdapter,
): readonly PrerequisiteResult[] {
  return prerequisitesFor(adapter).map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

export function noCapabilities(context: CapabilityContext): TargetCapabilities {
  return resolveCapabilities(
    {
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      valkey: false,
      egressFiltering: false,
      policyEngine: { installed: false, mode: null },
      logHistorySeconds: 0,
      servedHosts: [],
      reachableRegistries: [],
      reachableSecretStores: [],
    },
    context,
  );
}

/**
 * One stored Target row as capabilities, shared so every caller agrees on them.
 * Derived values are recomputed from the manifest on every read.
 */
export function capabilitiesOfRow(
  target: Pick<
    TargetRow,
    'adapter' | 'discovery' | 'reaches' | 'authReaches' | 'connection'
  >,
  options: {
    /** The adapter's artifact types, or `null` when this installation ships no adapter. */
    readonly artifactTypes: readonly ArtifactType[] | null;
    readonly manifest: InstallationManifest;
  },
): TargetCapabilities {
  const context: CapabilityContext = {
    adapter: target.adapter,
    artifactTypes: options.artifactTypes ?? [],
    reaches: target.reaches,
    authReaches: target.authReaches,
    deployPath: deployPathReferences(options.manifest),
    firesSchedules: firesSchedulesOn(target.connection),
  };
  return target.discovery === null || options.artifactTypes === null
    ? noCapabilities(context)
    : resolveCapabilities(target.discovery, context);
}

/**
 * A Cloud Scheduler job authenticates its call, so a Cloud Run Target with no
 * runtime identity cannot fire one. Every other connection can.
 */
function firesSchedulesOn(connection: TargetRow['connection']): boolean {
  return (
    connection?.adapter !== 'cloudrun' ||
    connection.serviceAccount !== undefined
  );
}

/** The columns {@link capabilitiesOfRow} reads, declared without importing the schema. */
interface TargetRow {
  adapter: TargetAdapter;
  discovery: TargetDiscovery | null;
  reaches: readonly Reach[] | null;
  authReaches: readonly Reach[] | null;
  /** Names `adapter` so this is not a weak type, which would reject most flavours. */
  connection: {
    readonly adapter: TargetAdapter;
    readonly serviceAccount?: string;
  } | null;
}

/** Healthy only when every item the adapter is asked is met; a missing row counts as unmet. */
export function deriveHealth(
  prerequisites: readonly PrerequisiteResult[],
  adapter: TargetAdapter,
): 'healthy' | 'unhealthy' {
  const seen = new Set(prerequisites.filter((p) => p.met).map((p) => p.name));
  return prerequisitesFor(adapter).every((name) => seen.has(name))
    ? 'healthy'
    : 'unhealthy';
}
