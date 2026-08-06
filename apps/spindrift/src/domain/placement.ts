/**
 * Placement resolution (§3).
 *
 * **A filter, not a scheduler.** "Derived requirements filter connected Targets
 * to candidates, the first by a global admin rank is suggested, and the
 * developer may switch to any other candidate. **Non-candidates are listed,
 * disabled, and annotated with why** — the grammar reused by prerequisites
 * (§14), exposure (§28), quotas (§29), and offline capability (§33). This makes
 * 'nowhere fits' expressible, catches failures before deploy, and needs no cost
 * model because a human is the tie-break."
 *
 * Three things this file therefore does not have, each rejected in §3 by name:
 *
 * - **No requirements language.** The developer types nothing. Every
 *   {@link Requirement} below is *derived* from the App — its Component's kind,
 *   its reach and auth, the Datastores attached to it — and there is no field
 *   anywhere a developer can write one in.
 * - **No preferences and no cost model.** "Prefer cheap" is inexpressible. Rank
 *   is one global ordered list an admin sets, and a human breaks the tie.
 * - **No scheduling.** Nothing here bin-packs, scores, or balances. A Target
 *   either satisfies every derived requirement or it is listed with the reason
 *   it does not.
 *
 * **Resolution runs before the build**, and outputs placement *plus artifact
 * shape* — which is why a Build's key includes the target shape and why moving
 * across shapes forces a rebuild while moving within one does not (§3).
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
 * The platform a workload is assumed to need until detection says otherwise.
 *
 * §5 owns detection, and it arrives with the build pipeline. Until it does, the
 * derived platform is the one every Target in the model runs, so placement never
 * excludes a Target for an architecture nothing has established.
 */
export const DEFAULT_PLATFORM: Platform = { os: 'linux', arch: 'amd64' };

/**
 * Why a Target is not a candidate.
 *
 * A closed set, like §6's failure reasons and for the same reason: §3's grammar
 * is that a non-candidate is "listed, disabled, and annotated with why", and an
 * annotation the UI cannot key on is a string it can only print.
 */
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

/** One Target as placement sees it: rank, health, and what it can do. */
export interface PlacementTarget {
  readonly id: string;
  /** The boundary this Target is a surface on — half of what names it. */
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  /** §13: "Rank is one global ordered list." Lower is considered first. */
  readonly rank: number;
  readonly healthy: boolean;
  readonly capabilities: TargetCapabilities;
  /**
   * Whether a rendered route has something to attach to on this Target.
   *
   * A platform fact rather than a capability: on a cluster it is the gateway the
   * operator named in `chartValues`, and on a backend that routes its own
   * workloads there is nothing to name, so it is true by construction.
   */
  readonly routesAttachTo: boolean;
  /**
   * §8: "Quota exhaustion needs no new failure reason (`REJECTED` covers it) but
   * surfaces at **Place time** as a non-candidate." Set by whatever last
   * measured the Target's quota; absent means nothing has said it is full.
   */
  readonly quotaExhausted?: boolean;
}

/**
 * What the App needs, derived — never authored (§3).
 *
 * `datastores` is the field that carries §11's consequence: an attached
 * cluster-local Datastore pins its App to that Datastore's Target, and §11 makes
 * that true "at attach time" rather than at deploy time, because tunnelling a
 * database over a satellite uplink is the cloud-native path degraded.
 */
export interface DerivedRequirements {
  readonly kind: ComponentKind;
  readonly reach: Reach;
  readonly auth: Auth;
  /**
   * §2: "`schedule` is a field on a job, not a kind." Absent means unscheduled,
   * which every backend that runs a job can honour; present names a cadence
   * something has to keep, and not every backend has anything that keeps one.
   */
  readonly schedule?: string;
  readonly platform: Platform;
  readonly resources: Resources;
  readonly gpu: boolean;
  readonly persistence: boolean;
  readonly datastores: readonly RequiredDatastore[];
  /** §10's reach rule: the store must be reachable by the Target chosen. */
  readonly secretStore: TargetCapabilities['reachableSecretStores'][number];
  /**
   * The registries this installation pushes every artifact to (§16).
   *
   * Here because §3 filters on reachability *before* a Build is dispatched, and
   * a Target that can pull from none of them is a non-candidate rather than a
   * failed revision hours later — which is what a `ghcr.io` reference on a
   * Cloud Run service was, several layers past IAM and Binary Authorization.
   */
  readonly registries: readonly string[];
}

/** One attached Datastore, as a requirement. */
export interface RequiredDatastore {
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
  /**
   * §11: "In-cluster datastores stay cluster-local in v1." A cluster-local
   * Datastore names the one Target its App can be placed on.
   */
  readonly clusterLocalTargetId: string | null;
}

/** A Target that fits, in rank order. */
export interface Candidate {
  readonly target: PlacementTarget;
  /** What a Build for this placement must produce (§3). */
  readonly artifactType: ArtifactType;
}

/** A Target that does not fit, and every reason it does not. */
export interface NonCandidate {
  readonly target: PlacementTarget;
  readonly reasons: readonly Exclusion[];
  /** The sentence a developer reads, one per reason. */
  readonly detail: readonly string[];
}

/**
 * The whole answer, including the negative half.
 *
 * `suggested` is `null` when nothing fits — which §3 insists must be
 * *expressible*, not an error. The `nonCandidates` list is what makes that
 * useful: "nowhere fits" with eight annotated rows is a diagnosis, and without
 * them it is a shrug.
 */
export interface Placement {
  readonly suggested: Candidate | null;
  readonly candidates: readonly Candidate[];
  readonly nonCandidates: readonly NonCandidate[];
}

/**
 * The `targets` columns {@link placementTargetOf} reads.
 *
 * Structural rather than an import of the row type: this file is domain, and a
 * domain module that imports the schema is a domain module the schema can break.
 */
interface RankedTargetRow {
  id: string;
  /** The joined boundary row. A Target is not addressable or nameable without it. */
  vessel: { name: string };
  adapter: TargetAdapter;
  rank: number;
  health: 'healthy' | 'unhealthy';
  discovery: TargetDiscovery | null;
  reaches: readonly Reach[] | null;
  authReaches: readonly Reach[] | null;
  /**
   * `adapter` is named here only so this is not a weak type: a shape whose every
   * property is optional accepts nothing structurally, and the connection
   * flavours that carry no `chartValues` are most of them.
   *
   * `serviceAccount` is not read here — it is what `capabilitiesOfRow` reads
   * off the same column — and is named so this row satisfies that shape.
   */
  connection: {
    readonly adapter: TargetAdapter;
    readonly chartValues?: Record<string, unknown>;
    readonly serviceAccount?: string;
  } | null;
}

/**
 * One stored Target row, as placement sees it.
 *
 * Three commands now need a `PlacementTarget` out of a `targets` row —
 * resolution, upload, and deploy creation — and each was rebuilding the same
 * six-field object around the same `capabilitiesOfRow` call. That is one shape,
 * so it is one function: a Target that looked capable to the command that
 * resolved it and incapable to the command that deployed to it is a bug with no
 * single place to fix it.
 */
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

/**
 * Whether a route rendered for this Target attaches to anything.
 *
 * Only the chart-rendering adapter can fail this. Cloud Run and static hosting
 * route their own workloads, so there is no gateway for an operator to name and
 * nothing for the absence of one to break.
 */
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
 * The artifact shape a Component takes on a Target (§3, §6).
 *
 * Shape follows the Target, not the kind: a `website` is the one kind that can
 * land on either, rendered to files on a `static` Target and to a server image
 * anywhere else. That is the whole reason exposure "filters Targets and selects
 * artifact shape" rather than being a chart setting (§28).
 */
export function artifactTypeFor(
  kind: ComponentKind,
  target: PlacementTarget,
): ArtifactType {
  if (
    kind === 'website' &&
    target.capabilities.artifactTypes.includes('files')
  ) {
    return 'files';
  }
  return 'image';
}

/**
 * The sentence behind each exclusion, in the developer's terms.
 *
 * Exported, and narrowed to the three fields it actually reads, because the
 * deploy path refuses with {@link reachExclusions} and has to refuse in the
 * same words the placement screen offered — a developer told "this Target has
 * no way to serve a public address" when they picked it, and told something
 * else when they deployed, is being told about two different systems.
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
      // The two ways this fails read nothing alike, and saying so is the whole
      // point of the reason. A Target may have the mechanism and be unable to
      // widen it: an edge that admits a single account is an honest answer in
      // front of a private route and a false one in front of a public address.
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

/**
 * Quantities compare as opaque strings turned into one number.
 *
 * Core never invents a scheduler (§3), and this is the smallest thing that is
 * not one: enough to answer "does this exceed the ceiling", nothing more. An
 * unparseable quantity compares as unbounded on the Target side and as zero on
 * the workload side, so an unknown unit never silently excludes a Target.
 */
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
 * Whether a Target serves the reach a Component asks for, and can authenticate
 * it — §3's asserted half, and the only part of {@link exclusionsFor} the
 * deploy path re-asks.
 *
 * Reach and auth join separately, because they are separate facts: a Target can
 * serve a reach it cannot authenticate, and the sentence a developer needs is
 * different in each case. Filtering both ways is what makes picking the static
 * Target *mean* public (§13, §28) — it asserts `public` and nothing else, so
 * every other reach is excluded by the ordinary join.
 *
 * §9's hard rule is the second half, where it binds: a Component asking to be
 * authenticated must land on a Target whose edge can honestly authenticate
 * *that reach*. The case that shape exists for is a Target that has the
 * mechanism and an audience too narrow to stand in front of an address anyone
 * can reach — it answers for `private` and not for `public`.
 *
 * **One implementation for two callers, deliberately.** The screen that offers a
 * placement and the command that creates the Deploy have to answer this
 * identically or the boundary is advisory: a Target that declares it cannot
 * serve the public was excluded on the placement screen and deployed to anyway,
 * because nothing on the deploy path asked. Only these two exclusions are lifted
 * — a deploy that re-ran the whole of `exclusionsFor` would newly refuse an
 * UNHEALTHY Target, which is exactly the rollback `deploys/rollback.ts` exists
 * to keep possible during an incident.
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

/** Every reason one Target fails one App's derived requirements. */
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

  // Rendering a job and keeping a cadence are two facts, so this is its own
  // reason rather than KIND_UNSUPPORTED: a Target that runs the Job and has
  // nothing to fire it would be described by "this Target does not run jobs"
  // falsely, in the sentence a developer reads. Both backends that render a job
  // now fire one, and they came true a release apart on Cloud Run — which is
  // exactly why the two are separate rows rather than one assumption (see
  // `FIRES_SCHEDULES_BY_ADAPTER`). Refused at Place because §3 refuses a
  // non-candidate there — the alternative is a build and a Deploy that end in
  // the adapter's REJECTED.
  //
  // Gated on the kind for the same reason it exists at all. Its sentence opens
  // by granting that this Target "runs a job", so on a Target that renders none
  // — `static` — it would sit beside KIND_UNSUPPORTED contradicting it on one
  // row. A reason speaks only where its own sentence is true.
  if (
    requirements.schedule !== undefined &&
    can.kinds.includes(requirements.kind) &&
    !can.firesSchedules
  ) {
    reasons.push('NO_SCHEDULER');
  }

  // A route needs something to attach to. Without this the Deploy goes green
  // with `parentRefs` naming a Gateway that is the empty string, which is a
  // route attached to nothing and a URL that answers nothing.
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
      // §11, at attach time: attaching a cluster-local Datastore is what makes
      // the App a non-candidate everywhere else, not the deploy that follows.
      reasons.push('DATASTORE_IS_CLUSTER_LOCAL');
      continue;
    }
    const engine = datastore.engine === 'postgres' ? can.postgres : can.valkey;
    if (!engine) reasons.push('DATASTORE_ENGINE_MISSING');
  }

  // §10's reach rule: "a store must be reachable by **the Target the Component
  // is placed on** — not by every Target."
  //
  // It does not bind a `website`, because a website reaches no store at all.
  // That is not a judgement made here: §10's one exception makes a website's
  // configuration build arguments **derived mechanically from Component kind**,
  // and `commands/config/isBuildTimeConfig` is that derivation — it takes a
  // kind and nothing else, so a website has no runtime rows for a store to
  // deliver whichever rendering it takes. The two must agree, and this comment
  // is where a future reader is told they are locked together rather than
  // re-deriving the question from the spec.
  //
  // Applying the rule anyway would exclude every Target that cannot deliver
  // config from holding a Component that never asks for any — which is exactly
  // what static hosting is, and it would make §13's "picking the static Target
  // *means* public" unreachable by construction.
  if (
    requirements.kind !== 'website' &&
    !can.reachableSecretStores.includes(requirements.secretStore)
  ) {
    reasons.push('STORE_UNREACHABLE');
  }

  // Only where an image is what gets pulled: a `files` artifact is fetched from
  // the depot, and a static Target's discovery says `reachableRegistries: []`
  // for exactly that reason — reading it as "reaches nothing" would exclude the
  // one Target the rule does not apply to.
  //
  // An empty list is **no declared restriction**, not "reaches nothing", which
  // is every Target until an operator says otherwise. So this only bites where
  // a Target names registries and none of them is one an artifact is pushed to.
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

  // Deduplicated: two attached datastores missing the same engine is one reason
  // a developer has to act on, not two rows saying the same sentence.
  return [...new Set(reasons)];
}

/**
 * Filter connected Targets to candidates and annotate the rest (§3).
 *
 * The order of `targets` is not consulted; `rank` is, because §13 makes rank one
 * global ordered list and a caller that happened to select rows in insertion
 * order must not be able to change what is suggested.
 */
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
    // "The first by a global admin rank is suggested." Not the best fit — there
    // is no fit score, and inventing one here would be the cost model §3
    // declines to have.
    suggested: candidates[0] ?? null,
    candidates,
    nonCandidates,
  };
}

/**
 * Whether moving a Component from one placement to another forces a rebuild.
 *
 * §3: "changing placement across shapes forces a rebuild" — a Build's key
 * includes the target shape, so a website moving from a cluster to the static
 * Target has no artifact of the right shape to deploy. Within one shape the
 * existing Build is deployable as is, which is what makes a cluster-to-cluster
 * move free (§10).
 */
export function requiresRebuild(from: ArtifactType, to: ArtifactType): boolean {
  return from !== to;
}
