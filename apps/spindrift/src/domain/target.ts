/**
 * The Target (§13).
 *
 * "**`Target` keeps its name, stays flat, and has exactly one adapter type** —
 * forced, because placement determines artifact shape, so a single 'Cloud'
 * Target would leave a website ambiguous between the two renderings. Splitting
 * them is what makes picking the static Target *mean* public."
 *
 * Flat is the whole design. There is no `Provider` noun above this, and §13 says
 * why one would earn nothing: **the connect act is credential-shaped though the
 * noun is flat**, so one "connect a cloud project" registers both of that
 * project's Targets and the shared thing between them is an argument to a
 * command, not an entity.
 *
 * **The name is the one clause that did not survive.** §60 gave the boundary a
 * row, which made the name a string built out of two columns beside it; a Target
 * is `(vessel, adapter)` and carries no third field. See {@link TargetIdentity}
 * for why constructing one was worse than merely redundant.
 *
 * Two states this file owns:
 *
 * - **Health is a standing checklist, not a connect-time verdict.** Connect
 *   always succeeds; an unmet item makes the Target a non-candidate with a
 *   stated reason. See `capabilities.ts` for the checklist itself.
 * - **Disconnect strands rather than stops.** "Disconnect always works: live
 *   Deploys go `orphaned`, workloads keep running, reconnect re-adopts via
 *   `observe`, and the confirmation names what it strands."
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import {
  DATASTORE_SURFACE_BY_VESSEL_KIND,
  type VesselKind,
  type VesselLocation,
} from './vessel.ts';

/**
 * How to reach one Target, in whatever terms its adapter needs.
 *
 * Adapter-specific by necessity — a cluster is an API server and a cloud Target
 * is a project — and therefore a discriminated union rather than a bag of
 * nullable columns: a `cloudrun` Target with an API server is not a state the
 * domain has a name for. Core stores this and hands it to the adapter; core
 * never parses a backend's own naming out of it.
 *
 * **No credential is here, in any variant.** §13: "One auth mode — native OIDC
 * federation, nothing stored." A field for a token is a field something will
 * eventually put a token in.
 */
export type TargetConnection =
  | KubernetesConnection
  | CloudRunConnection
  | StaticConnection
  | VercelConnection
  | CloudflarePagesConnection;

/** A stored Target after its operator has supplied adapter connection facts. */
export type TargetWithConnection<
  T extends { connection: TargetConnection | null },
> = T & { readonly connection: TargetConnection };

/** Refine a manifest seed away from Targets an adapter can actually address. */
export function hasTargetConnection<
  T extends { connection: TargetConnection | null },
>(target: T): target is TargetWithConnection<T> {
  return target.connection !== null;
}

/**
 * How a Cloud Run Target is reached (§13, §14).
 *
 * **`endpoint` is not the analogue of {@link KubernetesConnection.apiServer}
 * it first looks like, and that took a wrong shape shipping to notice.** A
 * cluster's `apiServer` genuinely varies per installation — two clusters are
 * two different control planes. `run.googleapis.com` is not: every connected
 * project sits behind the *same* control API, because Google runs one of it.
 * What looked like connection material was a vendor constant wearing a
 * manifest field's clothes. So this stays optional rather than required, for
 * exactly the reason `apiServer` must not: an installation behind a perimeter
 * or a mirror is real and needs to say so, but the ordinary installation has
 * nothing to say here at all. Absent means the adapter's own default applies
 * — see `DEFAULT_ENDPOINT` in `adapters/deploy/cloudrun/index.ts`, resolved
 * there rather than in this file because `src/domain/` is backend-neutral and
 * a vendor's own hostname is exactly the kind of fact it must not know.
 *
 * **No credential here either** (§13). What authorizes a call is minted per
 * request by whatever federates.
 */
export interface CloudRunConnection {
  adapter: 'cloudrun';
  region: string;
  /**
   * The runtime's API root, without a trailing slash. Optional override; see
   * the interface doc above for why this is a vendor constant rather than an
   * installation fact.
   */
  endpoint?: string;
  /**
   * The binary-authorization API root, where this project's admission policy is
   * read from (§16: "one signature, two verifiers").
   *
   * Optional, and absent means **not known** rather than absent-so-fine: with
   * nowhere to look, `verifiedDeploy` derives `false`, which is the direction a
   * claim about verification has to fail in.
   *
   * **Deliberately carries no default, unlike {@link endpoint} above.** The two
   * look alike — both name a Google API root — but presence here is a second
   * signal doing double duty: `useProjectAdmissionPolicy` in the deploy
   * adapter reads `policyEndpoint !== undefined` to decide whether this
   * project's admission policy applies at all. A compiled-in default would
   * make every Cloud Run Target start submitting to binary authorization
   * whether the operator installed it or not, which is the opposite of
   * "not known".
   */
  policyEndpoint?: string;
  /**
   * The identity a revision runs as (§13, §14).
   *
   * Connection material rather than a manifest-wide value, for the same reason
   * `project` is: it is a fact about this Target's project, and two connected
   * projects have different ones.
   *
   * **Absent is a footgun rather than a default**, and the reason it is still
   * optional is that only the runtime can supply the alternative. Omit it and
   * Cloud Run runs the revision as the project's default compute account —
   * which the controller has no `iam.serviceAccounts.actAs` on, because nobody
   * granted it any, so the apply is refused with an IAM sentence naming an
   * account the operator never chose. Naming the account here is what turns
   * that into a deliberate choice; `bluenose` already has a `spindrift-runtime`
   * account and the `actAs` grant for exactly this.
   */
  serviceAccount?: string;
  /** §18: how far back a tail can honestly reach, in seconds. */
  logHistorySeconds?: number;
}

/**
 * How a static-hosting Target is reached (§13, §14).
 *
 * No region: the hosting product serves one site from its own edge rather than
 * from a location an operator picks, so there is nothing here for a region to
 * name. No log history either — §17 gives static hosting an honest empty state
 * rather than a duration, because there is no runtime to have produced output.
 *
 * `endpoint` is optional for the same reason {@link CloudRunConnection.endpoint}
 * is: Firebase Hosting's API root is one hostname for every project, not a
 * per-installation fact, so the adapter's own default applies when this is
 * absent — see `DEFAULT_ENDPOINT` in `adapters/deploy/static/index.ts`.
 */
export interface StaticConnection {
  adapter: 'static';
  /** The hosting product's API root, without a trailing slash. Optional override. */
  endpoint?: string;
}

/**
 * How a Vercel Target is reached (§13).
 *
 * The same shape `StaticConnection` has, for the same reason: an edge platform
 * serves one site from its own network rather than from a region an operator
 * picks, and there is no runtime whose output a tail could reach back into.
 *
 * **No credential here either** (§13's rule), though this is the one backend
 * where what authorizes a call is not federated: Vercel has no inbound OIDC to
 * exchange a projected token for, so the bearer is an installation-Secret
 * value read per request — `SPINDRIFT_VERCEL_TOKEN` in `adapters/registry.ts`,
 * exactly where the 1Password Connect token already lives. A field for it here
 * would put one copy per Target in the database, which is the thing the rule is
 * actually about.
 *
 * `endpoint` is optional for the same reason {@link CloudRunConnection.endpoint}
 * is: Vercel's API root is one hostname for every team, not a per-installation
 * fact, so the adapter's own default applies when this is absent — see
 * `DEFAULT_ENDPOINT` in `adapters/deploy/vercel/index.ts`.
 */
export interface VercelConnection {
  adapter: 'vercel';
  /** The platform's API root, without a trailing slash. Optional override. */
  endpoint?: string;
}

/**
 * How a Cloudflare Pages Target is reached (§13, §14).
 *
 * The same one field its two siblings carry, for the same reasons: no region,
 * because the product serves one site from its own network; and no log history,
 * because §17 gives static hosting an honest empty state rather than a duration.
 *
 * **No credential here either**, and the same exception {@link VercelConnection}
 * documents applies for the same reason — this platform has no inbound OIDC to
 * exchange a projected token for, so the bearer is an installation-Secret value
 * read per request (`SPINDRIFT_CLOUDFLARE_TOKEN` in `adapters/registry.ts`).
 *
 * **The production branch is not here.** A project has one, and the adapter
 * reads it back off the project it ensures rather than being told — an operator
 * who states it can state it wrong, and the API already knows the answer.
 *
 * `endpoint` is optional for the same reason {@link CloudRunConnection.endpoint}
 * is: Cloudflare's API root is one hostname for every account, not a
 * per-installation fact, so the adapter's own default applies when this is
 * absent — see `DEFAULT_ENDPOINT` in `adapters/deploy/pages/index.ts`.
 */
export interface CloudflarePagesConnection {
  adapter: 'cloudflare-pages';
  /** The platform's API root, without a trailing slash. Optional override. */
  endpoint?: string;
}

/**
 * How a Kubernetes Target is reached, and by which GitOps operator.
 *
 * §6: **the Target declares the delivery flavour.** "The GitOps operator *is*
 * the pluggable machinery, so Spindrift applies a `HelmRelease` or an Argo
 * `Application` **through the API**" — which is why the flavour is connection
 * material rather than an installation-wide setting: two clusters may run
 * different operators and neither is more correct.
 *
 * Everything below the flavour is an operator's statement about their own
 * cluster. None of it is a credential (§13), and none of it is interpreted
 * here: core stores it and hands it to the adapter, which is the only thing
 * that knows what a `GitRepository` is.
 */
export interface KubernetesConnection {
  adapter: 'kubernetes';
  /** The namespace an App's workloads land in. Never created by Spindrift (§7). */
  namespace: string;
  delivery: KubernetesDelivery;
  /**
   * §18: "how far back a tail can honestly reach", in seconds. Stated rather
   * than discovered, because the log store is beside the cluster and not in it.
   */
  logHistorySeconds?: number;
  /**
   * §7's per-Target chart-values field: the operator's half of the value
   * contract. Untyped here on purpose — the chart's classes are the adapter's
   * knowledge, and the boundary between what an operator may write and what
   * Spindrift writes is enforced where this is saved, not where it is stored.
   */
  chartValues?: Record<string, unknown>;
}

/**
 * The two delivery flavours §6 names, each carrying what its operator needs.
 *
 * A direct apply and a Flux Kustomization are designed-for and deferred — note
 * the inversion §6 records: applying manifests directly is the *expensive*
 * flavour, being the only one with no controller to report status.
 *
 * **Both carry the chart's source**, because the App chart is fetched from an
 * object the Target already carries — a pinned OCI artifact or a repository it
 * trusts (§7). That makes "this source object exists in this cluster" a Target
 * prerequisite, and the prerequisite is checkable exactly because the reference
 * is here.
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
      /**
       * The Flux source object the App chart is fetched from — an
       * `OCIRepository` or a `GitRepository`, decided by the installation's
       * own `charts.app` reference rather than restated here.
       */
      sourceRef: { name: string; namespace: string };
    }
  | {
      flavour: 'argo-application';
      /** Namespace the Argo `Application` object is created in. */
      namespace: string;
      /** The Argo project the Application belongs to. */
      project: string;
      /** The repository the App chart is fetched from, and at which revision. */
      repoUrl: string;
      revision: string;
      /** The cluster Argo deploys to, in Argo's own vocabulary. */
      server: string;
    };

/**
 * What the deploy contract's verbs need to name one Target (§6).
 *
 * Identity plus how to reach it. The identity is the vessel and the surface —
 * see {@link TargetIdentity} — which is what an adapter puts in a sentence when
 * it has to name the Target it was handed.
 */
export interface DeployTargetRef extends TargetIdentity {
  readonly connection: AdapterConnection;
}

/**
 * The flat connection an adapter receives — surface facts plus its vessel's.
 *
 * **This is why splitting the row did not move the adapter seam.** An adapter
 * has always been handed one object carrying everything it needs to reach a
 * Target, and it still is; core assembles it from two rows instead of one.
 * Neither `DeployAdapter` nor any conformance test knows the difference, which
 * is what made normalizing the storage affordable.
 */
export type AdapterConnection =
  | (KubernetesConnection & VesselFacts & { apiServer: string })
  | (CloudRunConnection & VesselFacts & { project: string })
  | (StaticConnection & VesselFacts & { project: string })
  | (VercelConnection & VesselFacts & { team: string })
  | (CloudflarePagesConnection & VesselFacts & { account: string });

/** The boundary's half of the flat view, identical for every surface on it. */
interface VesselFacts {
  servedHosts?: readonly string[];
  reachableRegistries?: readonly string[];
}

/**
 * One adapter's arm of the flat view.
 *
 * Each adapter narrows `DeployTarget.connection` to its own arm before reading
 * it, exactly as it did when the connection was one row — the discriminant is
 * still `adapter`, and the shape it selects now simply includes the vessel's
 * contribution.
 */
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

/** The Vessel columns {@link deployTargetOf} reads, without importing the row. */
export interface VesselRef {
  readonly name: string;
  readonly location: VesselLocation;
  readonly servedHosts: readonly string[] | null;
  readonly reachableRegistries: readonly string[] | null;
}

/**
 * Whether a vessel has been told where it is.
 *
 * The mirror of {@link hasTargetConnection}, and used beside it: a Target is
 * addressable exactly when the surface carries its own facts *and* the boundary
 * carries its location. Both are set by the same act, so in practice they agree
 * — but the types do not know that, and a guard is cheaper than an invariant
 * nobody checks.
 */
export function hasVesselLocation<
  T extends { location: VesselLocation | null },
>(vessel: T): vessel is T & VesselRef {
  return vessel.location !== null;
}

/**
 * The narrow view of a Target row the adapter contract takes.
 *
 * Composes the surface's connection with its vessel's location and reach. The
 * vessel is a parameter rather than something this reads, because a domain
 * function that queried would be a domain function the database could break —
 * every caller already joins the row it needs.
 */
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
    // The union is discriminated on `adapter`, and the surface half already
    // carries it, so the spread lands in exactly one arm. The cast is what
    // {@link unstatedAddress} exists to check: `where` is the boundary's own
    // kind's address, and only the compiler is told it is the one this arm
    // needs.
    connection: {
      ...target.connection,
      ...reach,
      ...where,
    } as AdapterConnection,
  };
}

/** The one address a boundary of this kind states, in its own kind's terms. */
function addressOf(location: VesselLocation): Record<string, string> {
  switch (location.kind) {
    case 'cluster':
      return { apiServer: location.apiServer };
    case 'gcp-project':
      return { project: location.project };
    case 'vercel-team':
      return { team: location.team };
    case 'cloudflare-account':
      return { account: location.account };
  }
}

/**
 * The field name each surface's arm of {@link AdapterConnection} requires.
 *
 * Keyed by adapter rather than derived from a Target's vessel, because that is
 * the direction the question runs: the surface needs one address and the
 * boundary either stated that one or stated another kind's.
 */
const ADDRESS_BY_ADAPTER = {
  kubernetes: 'apiServer',
  cloudrun: 'project',
  static: 'project',
  vercel: 'team',
  'cloudflare-pages': 'account',
} as const satisfies Record<TargetAdapter, string>;

/**
 * The address this surface needs that its vessel's location does not state.
 *
 * `null` when {@link deployTargetOf} composed a whole connection, which is the
 * ordinary case. Each arm of {@link AdapterConnection} requires exactly one
 * address — `apiServer` for `kubernetes`, `project` for both cloud surfaces —
 * and a boundary states only its own kind's, so a surface on a boundary of the
 * other shape composes to a connection with a hole where its address goes.
 *
 * **That pairing is a document somebody may write, deliberately.** Which
 * runtimes a boundary carries is established by probing it rather than by a
 * table of surfaces per kind, so the manifest no longer refuses a project that
 * runs a cluster — it just has no way to address one yet. What must not happen
 * is an adapter being handed the hole: Cloud Run would request
 * `projects/undefined` on every pass of the loop and report a sentence with
 * `undefined` in it to the operator. So this is an unmet checklist item
 * instead, which is §3's grammar for exactly this — a stated reason a Target is
 * a non-candidate.
 */
export function unstatedAddress(target: DeployTargetRef): string | null {
  const { connection } = target;
  const address = ADDRESS_BY_ADAPTER[target.adapter];
  // `in` rather than a property read: the arm the compiler picked is the one
  // the cast asserted, so the key is only actually there when the boundary's
  // location was the matching shape.
  const stated =
    address in connection &&
    (connection as unknown as Record<string, unknown>)[address] !== '';
  if (stated) return null;
  return `this vessel's location states no ${address}, so a ${target.adapter} surface on it has no address to be reached at`;
}

/**
 * Whether the Target passes §13's standing checklist.
 *
 * Two states, not three. A manifest-seeded Target starts unhealthy with every
 * prerequisite carrying the reason that it has not been connected. The connect
 * act replaces that checklist with one real inspection before it returns, so
 * there is no `unknown` for the UI to render as a shrug.
 */
export type TargetHealth = 'healthy' | 'unhealthy';

/**
 * Why a Deploy is no longer core's to manage.
 *
 * §13: disconnect leaves live Deploys `orphaned` and "workloads keep running".
 * That is deliberately **not** a sixth {@link DeployPhase}: the phases are the
 * platform's verdict on a rollout (§6), and a workload that is still perfectly
 * live has no new verdict — what changed is that Spindrift stopped being able to
 * observe it. So orphaning is a core-side timestamp beside the phase, and
 * `deployState` below is the one place the two are read together.
 */
export type DeployState = 'orphaned' | 'live' | 'pending' | 'failed';

/** The two fields {@link deployState} reads. */
export interface DeployStateInput {
  phase: 'PENDING' | 'APPLYING' | 'WAITING' | 'LIVE' | 'FAILED';
  orphanedAt: Date | null;
}

/**
 * What the UI shows for one Deploy.
 *
 * Orphaning wins over the phase, because it is the more recent fact: a Deploy
 * that reads `LIVE` on a disconnected Target is telling the truth about the last
 * thing Spindrift saw and nothing about what is running now.
 */
export function deployState(deploy: DeployStateInput): DeployState {
  if (deploy.orphanedAt !== null) return 'orphaned';
  switch (deploy.phase) {
    case 'LIVE':
      return 'live';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The Deploy phases a disconnect strands — anything that reached the Target. */
export const STRANDABLE_PHASES = ['APPLYING', 'WAITING', 'LIVE'] as const;

/**
 * What identifies one Target: the boundary it is on, and the runtime it is.
 *
 * There is no third field, and that is the point. A Target used to carry a
 * constructed `name` — the vessel's, plus the adapter as a suffix where the
 * vessel had siblings to tell apart — and that name was decorative the moment
 * §60 gave the boundary a row of its own. Constructing it was worse than
 * redundant: the suffix appeared only where a vessel carried more than one
 * surface, so a vessel *discovering* a second surface would have had to rename
 * the first, and a Target cannot be renamed.
 *
 * The pair is naturally unique — a boundary carries one runtime of each kind —
 * so it is the unique index too (`targets_vessel_adapter_unique`).
 */
export interface TargetIdentity {
  readonly vessel: string;
  readonly adapter: TargetAdapter;
}

/**
 * One Target, spelled for a human: `<vessel>/<adapter>`.
 *
 * Two segments where there was one, and legible in a way the flat name was not:
 * `bluenose` is visibly a boundary and `bluenose/cloudrun` is visibly a surface
 * on it, rather than two sibling strings that read as peers.
 *
 * **Nothing parses this back out.** It is written into sentences and into store
 * item names; every act that addresses a Target takes its id, or its vessel and
 * adapter as two fields.
 */
export function targetLabel(target: TargetIdentity): string {
  return `${target.vessel}/${target.adapter}`;
}

/**
 * {@link targetLabel} over a `targets` row with its vessel joined.
 *
 * The join is the point: a Target row on its own cannot say what it is, because
 * half of what names it lives on the boundary. `'none'` is the answer for an
 * absent row — a Component that has never been placed has no Target, which is a
 * fact rather than a missing lookup.
 */
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
 * Where a Datastore lives, spelled for a human.
 *
 * A Datastore is anchored to its vessel, but the sentence a reader knows is
 * still `<vessel>/<adapter>` — the boundary plus the one surface on it that
 * hosts databases, resolved through the same two-row table every adapter
 * lookup reads. For every installation that exists this is byte-identical to
 * labelling the Target the row used to reference.
 *
 * The bare-name fallback should be unreachable: `createDatastore` refuses a
 * vessel whose kind has no hosting surface before any row exists to label.
 * If it is ever hit, the label quietly loses its `/adapter` suffix — a
 * display degradation, deliberately not a throw, because a labelling helper
 * that crashes a screen over one malformed row hides every other row with it.
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
