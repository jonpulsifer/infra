/**
 * What a Target can do (§3).
 *
 * §3 keeps two vocabularies apart: **capabilities describe Targets, requirements
 * are derived from the app.** This file is the first half. Nothing here knows
 * what an App wants; `placement.ts` is where the two meet.
 *
 * The four provenances §3 names are the whole structure of this file, and the
 * distinction is not decorative — it is what decides who is allowed to be wrong
 * about a value:
 *
 * ```
 * from the adapter type   kinds[], artifactTypes[]
 * discovered              arch[], gpu, resourceCeiling, persistence,
 *                         postgres, redis, egressFiltering,
 *                         verifiedDeploy(enforcing), logHistory, offlineDeploy
 * asserted                publicExposure
 * derived                 reachableRegistries[], reachableSecretStores[]
 * ```
 *
 * - **From the adapter type** is a property of the code, so it is read off the
 *   {@link DeployAdapter} rather than stored — a Target cannot disagree with the
 *   adapter that drives it.
 * - **Discovered by default, refreshed on a schedule** (§3): "a connect-time
 *   snapshot rots, and the symptom is a Target disabled long after it stopped
 *   being incapable."
 * - **Asserted only where discovery is impossible.** `publicExposure` is the
 *   single genuine assertion, because no cluster API reports whether a tunnel
 *   exists (§3).
 * - **Derived** values are computed here, from what was discovered. Two of them
 *   are subtle enough that §3 and §32/§33 call them out by name, and both are
 *   derived in core rather than trusted from an adapter:
 *   {@link deriveVerifiedDeploy} and {@link deriveOfflineDeploy}.
 */
import type {
  InstallationManifest,
  StoreAdapter,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type {
  ArtifactType,
  ComponentKind,
  Resources,
} from './desired-state.ts';

/**
 * Every prerequisite any Target can be asked about (§13).
 *
 * "Connect always succeeds; health is a standing prerequisite checklist —
 * Flux-or-Argo, a reachable writable store, OIDC both ways, the vessel, chart
 * contract compatibility. An unmet item makes the Target a non-candidate with a
 * stated reason, which merges capability refresh and health into one loop, not
 * two."
 *
 * This list is the **vocabulary**, not any one Target's checklist — see
 * {@link PREREQUISITES_BY_ADAPTER}, which is what a Target is actually assessed
 * against. §13's list is written in a cluster's terms because a cluster is the
 * backend it was written about; a Cloud Run Target has no delivery operator and
 * no chart, and a checklist row that can never fail is a row that teaches a
 * reader the wrong thing about what was checked.
 *
 * `OIDC_FEDERATION` is one item rather than two because §13 states it as "both
 * ways": half of a federation is not a state a Target can usefully be in, and
 * splitting it would put two rows in the UI that always agree.
 *
 * `CHART_SOURCE` is separate from `DELIVERY_OPERATOR` because the two fail
 * apart: a cluster can run Flux perfectly and still not carry the repository
 * the App chart is fetched from. It exists at all because v1 sources the chart
 * from a repository rather than from OCI (plan, Milestone 3) — **it is the
 * first thing that breaks on extraction**, and naming it here is what makes
 * that visible as a stated reason rather than as a deploy that fails late.
 *
 * `PLATFORM_API` is the cloud backends' equivalent of `DELIVERY_OPERATOR`, and
 * it is a separate name rather than a reuse because the two are unmet for
 * unrelated reasons and clear by unrelated remediations: one is an operator
 * this cluster does not run, the other is a service this project has not
 * enabled.
 */
export const PREREQUISITES = [
  'DELIVERY_OPERATOR',
  'CHART_SOURCE',
  'WRITABLE_STORE',
  'OIDC_FEDERATION',
  'VESSEL',
  'CHART_CONTRACT',
  'PLATFORM_API',
] as const;

export type Prerequisite = (typeof PREREQUISITES)[number];

/**
 * The checklist one adapter type is assessed against.
 *
 * A Target has exactly one adapter type (§13), so its checklist is decided by
 * the code that drives it rather than by anything an operator states. The two
 * cloud rows are identical and deliberately short: what a cloud Target can fail
 * at before anything is deployed to it is the service being off, the identity
 * being unauthorized, and the vessel not existing.
 *
 * The store is absent from both, and that is not an oversight. A cluster can
 * genuinely have no writable store — nothing installs one by default — so
 * `WRITABLE_STORE` is a real failure there. A cloud runtime reads its own
 * project's secret manager natively, and static hosting has no runtime to read
 * anything at all; both facts belong in `reachableSecretStores`, where
 * placement's reach rule (§10) already consumes them, rather than as a health
 * row that would be permanently green on one and permanently red on the other.
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
} as const satisfies Record<TargetAdapter, readonly Prerequisite[]>;

/** What a Target of this adapter type is asked, in the order it is shown. */
export function prerequisitesFor(
  adapter: TargetAdapter,
): readonly Prerequisite[] {
  return PREREQUISITES_BY_ADAPTER[adapter];
}

/** One checklist item, and the sentence behind an unmet one. */
export interface PrerequisiteResult {
  readonly name: Prerequisite;
  readonly met: boolean;
  /** Why it is unmet. §3's grammar: non-candidates are annotated with a reason. */
  readonly detail?: string;
}

/**
 * What a policy engine was found doing.
 *
 * §32: `verifiedDeploy` "must discover **enforcing** mode, not merely installed
 * — under an audit-only policy a green deploy proves nothing." An adapter
 * therefore reports what it saw and core decides what it means, which is why
 * this is two fields rather than the one boolean it eventually becomes.
 */
export type PolicyMode = 'ENFORCE' | 'AUDIT';

export interface PolicyEngineState {
  installed: boolean;
  /** `null` when nothing is installed to have a mode. */
  mode: PolicyMode | null;
}

/**
 * What an adapter reports after looking at its Target.
 *
 * Everything here is an observation. No field is a judgement — `verifiedDeploy`
 * and `offlineDeploy` are both absent, because both are conclusions core draws
 * from these observations and two adapters must not be able to disagree about
 * how they are drawn.
 */
export interface TargetDiscovery {
  /** Architectures the Target can run, e.g. `amd64`, `arm64`. */
  arch: readonly string[];
  gpu: boolean;
  /** The largest single workload the Target will admit (§3). */
  resourceCeiling: Resources;
  persistence: boolean;
  postgres: boolean;
  redis: boolean;
  egressFiltering: boolean;
  policyEngine: PolicyEngineState;
  /**
   * How far back a log tail can honestly reach, in seconds.
   *
   * §18: "not a separate capability; it is how far back a tail can honestly
   * reach, and the UI states reach rather than disabling a tab." A duration, so
   * zero means no history rather than no logs.
   */
  logHistorySeconds: number;
  /**
   * Hosts this Target serves itself — the input to {@link deriveOfflineDeploy}.
   * A registry mirror running in the cluster is one; the public internet is not.
   */
  servedHosts: readonly string[];
  reachableRegistries: readonly string[];
  reachableSecretStores: readonly StoreAdapter[];
}

/** One pass of the checklist plus one pass of discovery — §13's single loop. */
export interface TargetInspection {
  prerequisites: readonly PrerequisiteResult[];
  discovery: TargetDiscovery;
}

/**
 * The three references a deploy has to resolve (§33).
 *
 * `offlineDeploy` is "derived from a **static reachability check over the deploy
 * path's three references** — chart, image, verifier — true only when every host
 * is one the Target itself serves. It proves the configuration, never the
 * outcome."
 */
export interface DeployPathReferences {
  /** The App chart every Component renders through (§7). */
  chart: string;
  /** Where the artifact is pulled from (§16). */
  image: string;
  /** Where signature verification fetches its material (§16). */
  verifier: string;
}

/** The three references, as this installation's manifest names them (§20). */
export function deployPathReferences(
  manifest: InstallationManifest,
): DeployPathReferences {
  return {
    chart: manifest.charts.app,
    image: manifest.supplyChain.registry,
    verifier: manifest.supplyChain.verifier,
  };
}

/** Everything §3 says a Target's capabilities are, after core has decided. */
export interface TargetCapabilities {
  // From the adapter type.
  kinds: readonly ComponentKind[];
  artifactTypes: readonly ArtifactType[];

  // Discovered.
  arch: readonly string[];
  gpu: boolean;
  resourceCeiling: Resources;
  persistence: boolean;
  postgres: boolean;
  redis: boolean;
  egressFiltering: boolean;
  verifiedDeploy: boolean;
  logHistorySeconds: number;

  // Asserted.
  publicExposure: boolean;

  // Derived.
  reachableRegistries: readonly string[];
  reachableSecretStores: readonly StoreAdapter[];
  offlineDeploy: boolean;
}

/**
 * Which Component kinds each adapter type can run.
 *
 * From the adapter type, per §3 — **a property of the code, not of a Target**,
 * and that phrase decides what belongs in each row: what the adapter driving it
 * actually renders. The `static` row is the one that matters most: it takes a
 * website and nothing else, which is what makes "picking the static Target
 * *mean* public" (§13) a consequence of the model rather than a rule bolted on
 * top of it.
 *
 * **`cloudrun` runs no job yet**, and that is this table's honest reading
 * rather than a disagreement with §3. A job on this backend is a second
 * resource with its own API and a schedule that lives in a separate scheduling
 * service — Task 33's work, not the Service path Task 28 built. Until it
 * exists, a job's placement here is a non-candidate with the sentence "this
 * Target does not run jobs" (§3's grammar), which is refused at Place rather
 * than accepted and failed at apply.
 */
export const KINDS_BY_ADAPTER = {
  kubernetes: ['service', 'website', 'job'],
  cloudrun: ['service', 'website'],
  static: ['website'],
} as const satisfies Record<TargetAdapter, readonly ComponentKind[]>;

/**
 * `verifiedDeploy`, decided in core (§32).
 *
 * Installed is not enough: under an audit-only policy every deploy comes back
 * green whether or not it was verified, so an installed-but-auditing engine is
 * reported as **not** capable of a verified deploy.
 */
export function deriveVerifiedDeploy(engine: PolicyEngineState): boolean {
  return engine.installed && engine.mode === 'ENFORCE';
}

/**
 * The host part of a reference, without scheme, path, port, or tag.
 *
 * Deliberately total: an unparseable reference yields the string itself, which
 * then matches no served host and makes {@link deriveOfflineDeploy} answer
 * `false`. Failing closed is the right direction here — the claim being made is
 * that a deploy needs nothing off-Target.
 */
export function hostOf(reference: string): string {
  const withoutScheme = reference.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0] ?? withoutScheme;
  const host = authority.split('@').pop() ?? authority;
  return host.split(':')[0] ?? host;
}

/**
 * `offlineDeploy`, derived (§33).
 *
 * True only when every one of the three references resolves to a host the
 * Target serves itself. It proves the configuration, never the outcome — a
 * served host can still be down, and this says nothing about that.
 */
export function deriveOfflineDeploy(
  references: DeployPathReferences,
  servedHosts: readonly string[],
): boolean {
  const served = new Set(servedHosts.map(hostOf));
  return [references.chart, references.image, references.verifier].every(
    (reference) => served.has(hostOf(reference)),
  );
}

/** What {@link resolveCapabilities} needs that the inspection does not carry. */
export interface CapabilityContext {
  /** From the adapter type: what the code driving this Target can render. */
  adapter: TargetAdapter;
  artifactTypes: readonly ArtifactType[];
  /**
   * The single genuine assertion (§3). `null` — nobody has stated it — is
   * treated as `false`: an unasserted tunnel is one that does not exist.
   */
  publicExposure: boolean | null;
  deployPath: DeployPathReferences;
}

/** Fold one inspection into the capabilities §3 describes. */
export function resolveCapabilities(
  discovery: TargetDiscovery,
  context: CapabilityContext,
): TargetCapabilities {
  return {
    kinds: KINDS_BY_ADAPTER[context.adapter],
    artifactTypes: context.artifactTypes,

    arch: discovery.arch,
    gpu: discovery.gpu,
    resourceCeiling: discovery.resourceCeiling,
    persistence: discovery.persistence,
    postgres: discovery.postgres,
    redis: discovery.redis,
    egressFiltering: discovery.egressFiltering,
    verifiedDeploy: deriveVerifiedDeploy(discovery.policyEngine),
    logHistorySeconds: discovery.logHistorySeconds,

    publicExposure: context.publicExposure ?? false,

    reachableRegistries: discovery.reachableRegistries,
    reachableSecretStores: discovery.reachableSecretStores,
    offlineDeploy: deriveOfflineDeploy(
      context.deployPath,
      discovery.servedHosts,
    ),
  };
}

/**
 * The checklist result for a Target whose adapter could not be reached at all.
 *
 * §13: connect always succeeds. A Target that cannot be inspected is therefore
 * created — or kept — with every item unmet and the fault stated, rather than
 * the act failing and leaving nothing to look at.
 */
export function unreachablePrerequisites(
  detail: string,
  adapter: TargetAdapter,
): readonly PrerequisiteResult[] {
  return prerequisitesFor(adapter).map((name) => ({
    name,
    met: false,
    detail,
  }));
}

/** Capabilities for a Target nothing could be discovered about. */
export function noCapabilities(context: CapabilityContext): TargetCapabilities {
  return resolveCapabilities(
    {
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      redis: false,
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
 * One stored Target row, as capabilities.
 *
 * §3 gives capabilities four provenances and this is where the two that are not
 * stored get supplied: from-the-adapter-type comes off the adapter instance, and
 * the derived values are recomputed from the manifest every read (see
 * `target-loop.ts` — "a stored derivation can never be stale in a way nothing
 * notices").
 *
 * It lives here rather than in whichever command needed it first because three
 * of them now do — placement, build dispatch, and deploy creation — and a Target
 * that looks capable to one and incapable to another is a bug with no single
 * place to fix it. A Target whose adapter this installation does not ship, or
 * that has never been inspected, resolves to no capabilities: excluded with a
 * reason, never silently dropped.
 */
export function capabilitiesOfRow(
  target: Pick<TargetRow, 'adapter' | 'discovery' | 'publicExposure'>,
  options: {
    /** The adapter instance, or `null` when this installation ships none. */
    readonly artifactTypes: readonly ArtifactType[] | null;
    readonly manifest: InstallationManifest;
  },
): TargetCapabilities {
  const context: CapabilityContext = {
    adapter: target.adapter,
    artifactTypes: options.artifactTypes ?? [],
    publicExposure: target.publicExposure,
    deployPath: deployPathReferences(options.manifest),
  };
  return target.discovery === null || options.artifactTypes === null
    ? noCapabilities(context)
    : resolveCapabilities(target.discovery, context);
}

/** The columns {@link capabilitiesOfRow} reads, without importing the schema. */
interface TargetRow {
  adapter: TargetAdapter;
  discovery: TargetDiscovery | null;
  publicExposure: boolean | null;
}

/**
 * Healthy is every item met. §13 makes an unmet item a non-candidate.
 *
 * The adapter is a parameter because it decides *which* items had to be met: a
 * checklist that answered fewer rows than its Target is asked is treated as
 * unhealthy, so an adapter that silently stops reporting one cannot make a
 * Target look healthier than it was assessed.
 */
export function deriveHealth(
  prerequisites: readonly PrerequisiteResult[],
  adapter: TargetAdapter,
): 'healthy' | 'unhealthy' {
  const seen = new Set(prerequisites.filter((p) => p.met).map((p) => p.name));
  return prerequisitesFor(adapter).every((name) => seen.has(name))
    ? 'healthy'
    : 'unhealthy';
}
