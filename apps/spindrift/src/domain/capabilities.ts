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
 *                         postgres, valkey, egressFiltering,
 *                         verifiedDeploy(enforcing), logHistory, offlineDeploy
 * asserted                reaches[], authReaches[]
 * derived                 reachableRegistries[], reachableSecretStores[]
 * ```
 *
 * - **From the adapter type** is a property of the code, so it is read off the
 *   {@link DeployAdapter} rather than stored — a Target cannot disagree with the
 *   adapter that drives it.
 * - **Discovered by default, refreshed on a schedule** (§3): "a connect-time
 *   snapshot rots, and the symptom is a Target disabled long after it stopped
 *   being incapable."
 * - **Asserted only where discovery is impossible.** §3 gave the reason for the
 *   one assertion it started with — "no cluster API reports whether a tunnel
 *   exists" — and the reason is what decides membership, not the count. Nothing
 *   reports whether an operator wired an authenticating proxy in front of you,
 *   or how wide its audience is, so `authReaches` is asserted for the same
 *   reason `reaches` is.
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
  Reach,
  Resources,
} from './desired-state.ts';
import type { Remediation } from './remediation.ts';
import type { SurfaceProbe } from './vessel.ts';

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
 * apart: a cluster can run Flux perfectly and still not carry the source object
 * the App chart is fetched from. §7 pins that chart per Target, so the object
 * is the Target's own — an `OCIRepository` over a pinned artifact, or a
 * `GitRepository` where the installation names a path — and naming the check
 * here is what makes a missing one a stated reason rather than a deploy that
 * fails late.
 *
 * `PLATFORM_API` is the cloud backends' equivalent of `DELIVERY_OPERATOR`, and
 * it is a separate name rather than a reuse because the two are unmet for
 * unrelated reasons and clear by unrelated remediations: one is an operator
 * this cluster does not run, the other is a service this project has not
 * enabled.
 *
 * `API_TOKEN` is `OIDC_FEDERATION`'s counterpart on the one backend that has no
 * federation to check. It is a separate name for the reason `PLATFORM_API` is:
 * the two are unmet for unrelated reasons and clear by unrelated acts — one is
 * a trust relationship an operator declares in Terraform, the other is a bearer
 * an operator issues and puts in this installation's Secret — and a Vercel
 * Target reading `OIDC_FEDERATION: unmet` would send them to configure a
 * federation that does not exist on either side.
 */
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
  // The same three questions with the middle one asked of a bearer instead of
  // a federation: is the platform answering, may this credential act here, and
  // does the team exist.
  vercel: ['PLATFORM_API', 'API_TOKEN', 'VESSEL'],
  // The identical three, one vendor over and for the identical reason: this
  // platform federates no workload identity either, so `OIDC_FEDERATION` would
  // be a row nothing performs and `API_TOKEN` is what actually gets checked.
  'cloudflare-pages': ['PLATFORM_API', 'API_TOKEN', 'VESSEL'],
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
  /**
   * Whether a probe reached a verdict on this row, as against never getting to
   * ask it.
   *
   * `false` is the arm `cloud/checklist.ts` spends its table keeping apart from
   * an observed fault — "not assessed", an unreachable service, a status
   * nothing here reads — and `unreachablePrerequisites` is the same arm one
   * layer out. Both report unmet, because §13 will not have core deciding that
   * what it failed to check was fine, and they mean opposite things about the
   * boundary: one says a fact was observed wrong, the other says no fact was
   * observed at all.
   *
   * Carried on the row because everything downstream of the checklist needs the
   * distinction the checklist already drew, and a reader that recovered it by
   * matching on `detail` would be parsing a sentence written for an operator.
   * `remediation.ts` is the consumer that makes it load-bearing: a change
   * generated for a row nobody assessed is a guess with a pull request button
   * beside it.
   *
   * Absent means assessed, which is every row a probe answered.
   */
  readonly assessed?: boolean;
  /**
   * The project whose switch a `SERVICE_DISABLED` refusal was actually about,
   * where that is not the project the call was aimed at.
   *
   * GCP refuses a call whose *consumer* — the project the federated token bills
   * — has the service off, whatever project the URL names. Ticket 90 made the
   * sentence say so; this is the same fact in a field, because the sentence is
   * written for an operator and `remediation.ts` must not parse it: a stanza
   * generated off `subject.project` enables the API on a project that was never
   * the problem, and files it in that project's root.
   *
   * Absent means the refusal named no consumer or named the probed project,
   * which is every other row.
   */
  readonly consumer?: string;
  /**
   * What would clear it, as Terraform, and where that belongs.
   *
   * Absent on a stored row and present on a read one: the loops store what was
   * observed and nothing they concluded, and a stanza is a conclusion that
   * moves when a root is declared or a surface is connected. `remediation.ts`
   * composes it, `commands/targets/remediation.ts` supplies the facts, and
   * nothing writes it back.
   */
  readonly remediation?: Remediation;
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
  valkey: boolean;
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
  /**
   * Whether the boundary turned out to carry this surface at all.
   *
   * The adapter's to answer rather than core's, for the reason the checklist
   * is: only the thing that made the call knows whether the runtime answered,
   * refused, or is not switched on here. Core decides what to *do* about it —
   * `connectTarget` withholds a Target for an `absent` surface and registers an
   * `undetermined` one unhealthy — so this stays an observation like every
   * other field on this type.
   */
  surface: SurfaceProbe;
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
  /**
   * Where the artifact is pulled from (§16) — one entry per registry the
   * installation pushes to.
   *
   * Plural because an installation whose Targets cannot share a registry pushes
   * to each, and a Target only ever pulls from **one** of them. `offlineDeploy`
   * is therefore satisfied when any one is served rather than when all are:
   * requiring every registry would make a Target that mirrors the one it
   * actually uses report that it cannot deploy offline.
   */
  images: readonly string[];
  /** Where signature verification fetches its material (§16). */
  verifier: string;
}

/** The three references, as this installation's manifest names them (§20). */
export function deployPathReferences(
  manifest: InstallationManifest,
): DeployPathReferences {
  return {
    chart: manifest.charts.app,
    images: manifest.supplyChain.registry,
    verifier: manifest.supplyChain.verifier,
  };
}

/** Everything §3 says a Target's capabilities are, after core has decided. */
export interface TargetCapabilities {
  // From the adapter type.
  kinds: readonly ComponentKind[];
  /**
   * From the adapter type **and** from this Target's connection: the code has
   * to fire a schedule and the Target has to give it something to fire as. See
   * {@link FIRES_SCHEDULES_BY_ADAPTER} and `CapabilityContext.firesSchedules`.
   */
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
 * Which Component kinds each adapter type can run.
 *
 * From the adapter type, per §3 — **a property of the code, not of a Target**,
 * and that phrase decides what belongs in each row: what the adapter driving it
 * actually renders. The `static` row is the one that matters most: it takes a
 * website and nothing else, which is what makes "picking the static Target
 * *mean* public" (§13) a consequence of the model rather than a rule bolted on
 * top of it.
 *
 * **A job on `cloudrun` is a Job resource with no cadence of its own**, which is
 * the same thing a job is on `kubernetes` until something schedules it: the App
 * chart renders an unscheduled job as a *suspended* CronJob, because the object
 * has to exist for anything to have something to trigger. Cloud Run reaches
 * that state by having no scheduler in front of the Job rather than by
 * suspending it. Put one there and both rows run the same Component the same
 * way — see {@link FIRES_SCHEDULES_BY_ADAPTER}. An on-demand run is
 * `DeployAdapter.run`, which both backends answer.
 */
export const KINDS_BY_ADAPTER = {
  kubernetes: ['service', 'website', 'job'],
  cloudrun: ['service', 'website', 'job'],
  static: ['website'],
  vercel: ['website'],
  'cloudflare-pages': ['website'],
} as const satisfies Record<TargetAdapter, readonly ComponentKind[]>;

/**
 * Which adapters fire a job at the times its `schedule` names.
 *
 * From the adapter type for the same reason {@link KINDS_BY_ADAPTER} is: what
 * the code driving the Target renders. Both backends that render a job now fire
 * one, by quite different machinery — the App chart renders a CronJob and the
 * cluster's own controller fires it, while a Cloud Run Job carries no cron
 * expression at all and the adapter puts a Cloud Scheduler job in front of it
 * (`adapters/deploy/cloudrun/scheduler.ts`). Which is exactly why this is a
 * capability and not an assumption: the *kind* being renderable says nothing
 * about whether anything keeps a cadence, and the two facts came true on this
 * backend a release apart.
 *
 * It is a row of its own rather than a second kind for that same reason, and
 * §3's grammar is what it buys: a Target that runs a job and fires no schedule
 * is a `NO_SCHEDULER` non-candidate at Place with a sentence naming which of
 * the two is missing, so a developer hears it before a build rather than after
 * one. The only `false` row left is `static`, which renders no job at all and
 * therefore never reaches that sentence — so the mechanism is dormant here
 * rather than dead, and it is what the next backend is measured against.
 *
 * **Not the whole answer for one Target, though.** This says what the code can
 * do; a Cloud Run Target that names no runtime identity has nothing for a
 * schedule to authenticate as, whatever its adapter is capable of. That half
 * arrives on the connection — see `CapabilityContext.firesSchedules` — and the
 * two are ANDed, so the row stays a property of the code and the Target's own
 * configuration can only ever subtract.
 */
export const FIRES_SCHEDULES_BY_ADAPTER = {
  kubernetes: true,
  cloudrun: true,
  static: false,
  vercel: false,
  'cloudflare-pages': false,
} as const satisfies Record<TargetAdapter, boolean>;

/**
 * What each adapter serves before an operator asserts anything.
 *
 * This is the floor, not the answer: an unasserted Target is held to what its
 * backend does by construction, and an operator widens it. A cluster serves
 * `private` without being asked because its load-balancer address exists whether
 * or not anyone says so; it does **not** serve `public` unasserted, because that
 * needs a tunnel and §3's whole reason for having assertions is that no API
 * reports one.
 *
 * `static` is the row that carries §13's "picking the static Target *means*
 * public": it serves that reach and no other, so a Component asking for anything
 * else is a non-candidate by the ordinary join rather than by a special case.
 */
export const ASSERTED_REACHES_BY_ADAPTER = {
  kubernetes: ['none', 'private'],
  // Cloud Run answers `none` with internal-only ingress and `public` with a
  // service URL the internet resolves. It has no `private` to offer: there is
  // no address on the operator's own network for a record to point at.
  cloudrun: ['none', 'public'],
  static: ['public'],
  // An edge network is public by construction and has no address on the
  // operator's own network for a `private` record to point at.
  vercel: ['public'],
  // §9's disqualification, reached by the same road: a site's own edge address
  // answers whatever else is put in front of it, so no non-public rendering
  // here has an origin that is not bypassable.
  'cloudflare-pages': ['public'],
} as const satisfies Record<TargetAdapter, readonly Reach[]>;

/**
 * The authenticated edge each adapter has before an operator wires one.
 *
 * A cluster has none: an authenticating proxy in front of a Gateway is
 * something someone installed, and §3's reason for assertions is that nothing
 * reports whether they did. A cloud runtime's invoker check is the opposite —
 * it is the platform's own identity-aware proxy, on unless it is turned off,
 * so claiming it needs no operator's word. Static hosting serves files with no
 * runtime to check anything.
 *
 * An operator still widens or narrows this: what they know that the adapter
 * cannot is the *audience*, which is why an assertion overrides the floor.
 */
export const ASSERTED_AUTH_REACHES_BY_ADAPTER = {
  kubernetes: [],
  cloudrun: ['none', 'public'],
  static: [],
  // Vercel Authentication is a paid plan's edge check rather than something on
  // by construction, so it is an operator's assertion like a cluster's proxy.
  vercel: [],
  // Cloudflare Access is the same shape of thing: bought and configured, not
  // on by construction, so it is asserted rather than claimed here.
  'cloudflare-pages': [],
} as const satisfies Record<TargetAdapter, readonly Reach[]>;

/**
 * Which adapters serve a Component without running anything (§17).
 *
 * A property of the code driving the Target, like the four tables above, and it
 * decides one thing: whether the workspace offers a runtime pipe or §17's
 * honest empty state. Both static backends serve files that no process
 * executes, so there is no stdout for a tail to be empty *of* — and a screen
 * that offered a stream anyway would show a live-looking pane that can only
 * ever have nothing in it.
 *
 * A table and not two equality checks at the call site, for the reason
 * {@link KINDS_BY_ADAPTER} is one: `satisfies` makes the fifth adapter a
 * compile error until somebody answers the question, and the alternative is a
 * screen that quietly regresses to the wrong pane the day one is added.
 */
export const RUNS_NOTHING_BY_ADAPTER = {
  kubernetes: false,
  cloudrun: false,
  static: true,
  vercel: true,
  'cloudflare-pages': true,
} as const satisfies Record<TargetAdapter, boolean>;

/** Whether a Target of this adapter type executes anything it serves. */
export function runsNothingOn(adapter: TargetAdapter): boolean {
  return RUNS_NOTHING_BY_ADAPTER[adapter];
}

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
  return (
    [references.chart, references.verifier].every((reference) =>
      served.has(hostOf(reference)),
    ) && references.images.some((reference) => served.has(hostOf(reference)))
  );
}

/** What {@link resolveCapabilities} needs that the inspection does not carry. */
export interface CapabilityContext {
  /** From the adapter type: what the code driving this Target can render. */
  adapter: TargetAdapter;
  artifactTypes: readonly ArtifactType[];
  /**
   * §3's assertions. `null` — nobody has stated it — falls back to
   * {@link ASSERTED_REACHES_BY_ADAPTER} rather than to nothing, because an
   * unasserted tunnel is one that does not exist while an unasserted
   * load-balancer address is one that does.
   */
  reaches: readonly Reach[] | null;
  /** `null` or empty both mean no authenticated edge has been claimed. */
  authReaches: readonly Reach[] | null;
  deployPath: DeployPathReferences;
  /**
   * Where this Target's own connection can stop it firing one, even though its
   * adapter fires them. Absent means nothing about it does — see
   * {@link FIRES_SCHEDULES_BY_ADAPTER}, which is the only other input.
   */
  firesSchedules?: boolean;
}

/** Fold one inspection into the capabilities §3 describes. */
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
 * The checklist result for a Target whose adapter could not be reached at all.
 *
 * §13: connect always succeeds. A Target that cannot be inspected is therefore
 * created — or kept — with every item unmet and the fault stated, rather than
 * the act failing and leaving nothing to look at.
 *
 * Every row `assessed: false`: nothing was asked, so nothing was observed, and
 * a reader must not be able to mistake this for a boundary that answered.
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

/** Capabilities for a Target nothing could be discovered about. */
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
  target: Pick<
    TargetRow,
    'adapter' | 'discovery' | 'reaches' | 'authReaches' | 'connection'
  >,
  options: {
    /** The adapter instance, or `null` when this installation ships none. */
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
 * Whether this Target's own connection lets a schedule fire, as opposed to its
 * adapter's code being able to.
 *
 * The one case, and the reason this is not purely from-the-adapter-type: a
 * Cloud Scheduler job authenticates the `jobs.run` call it makes, so a Cloud
 * Run Target that names no runtime identity has nothing for a schedule to fire
 * *as* — the adapter refuses it at apply, and §3's grammar says a refusal a
 * Target's own configuration already decides belongs at Place, before a build,
 * rather than after one. Every other flavour answers `true`: nothing in a
 * cluster connection or a static one can withdraw a cadence its adapter keeps.
 */
function firesSchedulesOn(connection: TargetRow['connection']): boolean {
  return (
    connection?.adapter !== 'cloudrun' ||
    connection.serviceAccount !== undefined
  );
}

/** The columns {@link capabilitiesOfRow} reads, without importing the schema. */
interface TargetRow {
  adapter: TargetAdapter;
  discovery: TargetDiscovery | null;
  reaches: readonly Reach[] | null;
  authReaches: readonly Reach[] | null;
  /**
   * `adapter` is named so this is not a weak type, exactly as
   * `placement.ts`'s own view of the same column is; `serviceAccount` is the
   * one member read here and most flavours carry none.
   */
  connection: {
    readonly adapter: TargetAdapter;
    readonly serviceAccount?: string;
  } | null;
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
