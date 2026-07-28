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
  | StaticConnection;

/**
 * How a Cloud Run Target is reached (§13, §14).
 *
 * `endpoint` is the exact analogue of {@link KubernetesConnection.apiServer}:
 * the control API this Target is driven through. It is connection material
 * rather than an installation-wide manifest value for the same reason a cluster's
 * is — two connected projects may sit behind different regional or
 * perimeter-fronted endpoints, and neither is more correct than the other.
 *
 * **No credential here either** (§13). What authorizes a call is minted per
 * request by whatever federates.
 */
export interface CloudRunConnection {
  adapter: 'cloudrun';
  /** The vessel project this Target deploys into (§14). */
  project: string;
  region: string;
  /** The runtime's API root, without a trailing slash. */
  endpoint: string;
  /**
   * The binary-authorization API root, where this project's admission policy is
   * read from (§16: "one signature, two verifiers").
   *
   * Optional, and absent means **not known** rather than absent-so-fine: with
   * nowhere to look, `verifiedDeploy` derives `false`, which is the direction a
   * claim about verification has to fail in.
   */
  policyEndpoint?: string;
  /** §33's static reachability input, stated by the operator (§3). */
  servedHosts?: readonly string[];
  reachableRegistries?: readonly string[];
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
 */
export interface StaticConnection {
  adapter: 'static';
  /** The vessel project this Target's sites live in (§14). */
  project: string;
  /** The hosting product's API root, without a trailing slash. */
  endpoint: string;
  /** §33's static reachability input, stated by the operator (§3). */
  servedHosts?: readonly string[];
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
  /** The API server endpoint (§13's prerequisite is OIDC against it). */
  apiServer: string;
  /** The namespace an App's workloads land in. Never created by Spindrift (§7). */
  namespace: string;
  delivery: KubernetesDelivery;
  /**
   * §33: hosts this Target serves itself, the input to the static reachability
   * check `offlineDeploy` is derived from. An operator's statement, because no
   * cluster API reports what it can reach.
   */
  servedHosts?: readonly string[];
  /** Registries reachable from this Target, likewise stated (§3). */
  reachableRegistries?: readonly string[];
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
  /**
   * The value-contract version the App chart pinned for this Target declares
   * (§7, read at pin time).
   *
   * Stated rather than read, because v1 sources the chart from a branch rather
   * than from a pinned OCI artifact — so skew is **detected** here rather than
   * prevented, and detection needs the operator to say what they pinned.
   */
  chartContract?: string;
}

/**
 * The two delivery flavours §6 names, each carrying what its operator needs.
 *
 * A direct apply and a Flux Kustomization are designed-for and deferred — note
 * the inversion §6 records: applying manifests directly is the *expensive*
 * flavour, being the only one with no controller to report status.
 *
 * **Both carry the chart's source**, because until the OCI swap the App chart
 * is fetched from a repository the Target already trusts (plan, Milestone 3).
 * That makes "a `GitRepository` in this cluster" a Target prerequisite, and the
 * prerequisite is checkable exactly because the reference is here.
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
      /** The `GitRepository` the App chart is fetched from. */
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

/** What the deploy contract's verbs need to name one Target (§6). */
export interface DeployTargetRef {
  readonly name: string;
  readonly adapter: TargetAdapter;
  readonly connection: TargetConnection;
}

/** The narrow view of a Target row the adapter contract takes. */
export function deployTargetOf(target: {
  name: string;
  adapter: TargetAdapter;
  connection: TargetConnection;
}): DeployTargetRef {
  return {
    name: target.name,
    adapter: target.adapter,
    connection: target.connection,
  };
}

/**
 * Whether the Target passes §13's standing checklist.
 *
 * Two states, not three. A Target is only ever created by the connect act, and
 * that act runs one pass of the checklist before it returns — so there is no
 * moment at which a Target exists and has never been assessed, and no
 * `unknown` for the UI to render as a shrug.
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
 * The connect act's two shapes (§13).
 *
 * "The connect act is credential-shaped though the noun is flat: one 'connect a
 * cloud project' registers both project-specific Targets, so a `Provider` noun
 * earns nothing." A cluster is one Target; a cloud project is two, and which two
 * is a fact about the cloud rather than a choice the operator makes.
 */
export const CLOUD_ADAPTERS = ['cloudrun', 'static'] as const;

/** Names for the Targets one connect act registers, from the operator's name. */
export function targetNames(
  kind: 'kubernetes' | 'cloud',
  name: string,
): { name: string; adapter: TargetAdapter }[] {
  if (kind === 'kubernetes') return [{ name, adapter: 'kubernetes' }];
  // Suffixed rather than asked for, because the operator connected one project
  // and §13 makes the split a consequence of the model, not a decision.
  return CLOUD_ADAPTERS.map((adapter) => ({
    name: `${name}-${adapter}`,
    adapter,
  }));
}
