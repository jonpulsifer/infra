/**
 * The read models commands return and screens render, typed from the domain's
 * closed vocabularies so a view cannot show a phase or reason the domain lacks.
 */
import type {
  Blame,
  DeployPhase,
  FailureReason,
} from '../adapters/deploy/contract.ts';
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type {
  ArtifactType,
  Auth,
  ComponentKind,
  Reach,
} from '../domain/desired-state.ts';
import type { Exclusion } from '../domain/placement.ts';
import type { AnyPrerequisite, Remediation } from '../domain/remediation.ts';
import type {
  VesselDiscovery,
  VesselKind,
  VesselRole,
} from '../domain/vessel.ts';
import {
  FUNCTION_TARGETS,
  type FunctionTarget,
} from '../functions/contract.ts';
import type { FunctionProbe } from '../functions/readiness.ts';

/** One checklist row, shared by a Target's checklist and its boundary's. */
export interface PrerequisiteRowView {
  readonly name: AnyPrerequisite;
  readonly met: boolean;
  readonly detail?: string;
  /** On the Targets screen: present on every unmet row, absent on met ones. */
  readonly remediation?: Remediation;
}

export type { DeployPhase };

const PHASE_WORD = {
  PENDING: 'Queued',
  APPLYING: 'Applying',
  WAITING: 'Releasing',
  LIVE: 'Live',
  // A row cannot see whether a Build failed underneath.
  FAILED: 'Deploy failed',
} as const satisfies Record<DeployPhase, string>;

/** A phase in words for list rows; the detail screens compute a richer word. */
export function deployPhaseWord(phase: DeployPhase): string {
  return PHASE_WORD[phase];
}

export function isInFlight(phase: DeployPhase): boolean {
  return phase === 'PENDING' || phase === 'APPLYING' || phase === 'WAITING';
}

export type StepStatus = 'done' | 'running' | 'failed' | 'waiting';

export interface ChecklistItem {
  readonly name: string;
  readonly status: StepStatus;
  readonly detail?: string;
}

export interface LogLine {
  readonly text: string;
  readonly tone?: 'error' | 'muted';
}

/**
 * How live the runner's output is. The deploy screen states it, so a withheld
 * log never reads as empty.
 */
export type LogFidelity = 'LIVE_TEXT' | 'LIVE_STATUS' | 'ON_COMPLETION';

/**
 * What core persisted when the deploy went red. `blame` comes from
 * `blameFor(reason)`, never from an adapter.
 */
export interface Diagnosis {
  readonly reason: FailureReason;
  readonly blame: Blame | null;
  readonly detail: string;
  /**
   * What core saw (events, exit codes, probe results), or `null` when it
   * recorded nothing. Never a serialized empty object.
   */
  readonly evidence: string | null;
}

/** The build half of an attempt, present only when a builder ran. */
export interface BuildView {
  readonly status: StepStatus;
  readonly duration?: string;
  readonly fidelity: LogFidelity;
  readonly steps: readonly ChecklistItem[];
  /** `null` while no log text has arrived. */
  readonly log: readonly LogLine[] | null;
  /** How many lines the runner produced, of which {@link log} is the tail. */
  readonly logTotal: number;
  readonly runner: string;
  /**
   * The platform behind {@link runner}, from its route in
   * `manifest.build.routes`. `null` when no configured route has that name.
   */
  readonly runnerAdapter: string | null;
  /** Where the build can be watched on the runner's own surface, or `null`. */
  readonly runUrl: string | null;
}

/**
 * The headline, author and authored instant (ISO) a Build kept of its commit.
 * Absent or null for an archive, and for a Build that recorded none.
 */
export interface CommitHeadlineView {
  readonly commitMessage?: string | null;
  readonly commitAuthor?: string | null;
  readonly commitAuthoredAt?: string | null;
}

/**
 * Where a release's bytes came from. Every attempt has one; not every attempt
 * has a {@link BuildView}.
 */
export type SourceView =
  | ({
      readonly kind: 'repo';
      readonly repo: string;
      readonly commit: string;
      readonly subpath: string;
    } & CommitHeadlineView)
  | {
      readonly kind: 'archive';
      /** The digest over the staged bundle. */
      readonly digest: string;
      /** Where the staged bundle is fetched from, or `null` when unrecorded. */
      readonly location: string | null;
      readonly subpath: string;
      /** Finished output, extracted and never built: no Build is normal. */
      readonly extracted: boolean;
    };

/**
 * A `LIVE` release the platform has since stopped agreeing with: something else
 * serves (`observedDigest`), or nothing new can serve (`detail`).
 */
export interface DriftView {
  /** When the loop first saw the disagreement, in words. */
  readonly since: string;
  /** The ISO instant behind {@link since}. */
  readonly at: string;
  /** The digest actually serving, when that is what differs. */
  readonly observedDigest: string | null;
  /**
   * Why the platform will not converge, in its own words. `null` for an
   * ordinary digest mismatch.
   */
  readonly detail: string | null;
}

/** The deploy screen's whole state. */
export interface DeployView {
  /** The Deploy this attempt is, or `null` while it is only a Build. */
  readonly id: number | null;
  readonly buildId: number;
  readonly componentId: string;
  readonly targetId: string;
  /** `apps.name` is not unique, so acts on this screen take the id. */
  readonly appId: string;
  readonly app: string;
  readonly component: string;
  readonly target: string;
  readonly commit: string;
  readonly phase: DeployPhase;
  readonly phaseWord: string;
  readonly headline: string;
  /** The address this attempt published; empty when it has none. */
  readonly url: string;
  readonly urlLive: boolean;
  /**
   * Set when an older release still serves. A failed deploy never changes
   * exposure, so on red this is the normal case.
   */
  readonly previousReleaseServing: boolean;
  /**
   * Set on red, and on a `LIVE` release the post-readiness soak found failed
   * (see {@link faultyAt}).
   */
  readonly diagnosis: Diagnosis | null;
  /**
   * What the platform stopped agreeing with after this release went `LIVE`;
   * `null` when converged.
   */
  readonly drift: DriftView | null;
  /**
   * The ISO instant the post-readiness soak found this `LIVE` release failed.
   * `phase` stays `LIVE`; {@link diagnosis} carries why.
   */
  readonly faultyAt?: string;
  /** Who asked this attempt to stop; set only while it is still in flight. */
  readonly cancelRequestedBy?: string;
  readonly resources: readonly ChecklistItem[];
  readonly source: SourceView;
  /** `null` when no builder ran: a supplied artifact. */
  readonly build: BuildView | null;
  /** Controller and platform output for the deploy leg, or `null`. */
  readonly deployLog: readonly LogLine[] | null;
  /** How long ago this attempt was written, in words. */
  readonly when: string;
  /** The ISO instant behind {@link when}. */
  readonly at: string;
  /**
   * Whether the desired row names this release. A superseded Deploy can still
   * be `LIVE`.
   */
  readonly current: boolean;
  /** A hash over the config this release pinned, never the config itself. */
  readonly configVersion: string | null;
  readonly artifactDigest: string | null;
  /** The release before this one at this Component and Target, any outcome. */
  readonly previousDeployId: number | null;
  /**
   * Whether `rollbackDeploy` would take this release's Build: one older than
   * the desired Build.
   */
  readonly rollbackable: boolean;
  /**
   * The p90 of created-to-LIVE over up to 100 earlier releases here. Absent
   * under 3 samples, and on a Build with no release.
   */
  readonly expectedDuration?: ExpectedDuration;
  /** Who asked for this Deploy, as a screen prints it; absent if unrecorded. */
  readonly requestedBy?: string;
}

export interface ExpectedDuration {
  readonly p90Ms: number;
  /** How many earlier releases the estimate is from. */
  readonly samples: number;
}

/** One Deploy as a releases list presents it. */
export interface DeployListItem extends CommitHeadlineView {
  readonly id: number;
  readonly buildId: number;
  readonly componentId: string;
  readonly targetId: string;
  readonly component: string;
  readonly target: string;
  readonly commit: string;
  readonly phase: DeployPhase;
  readonly when: string;
  readonly at: string;
  /** Whether the desired row names this release. */
  readonly current: boolean;
  /** The pinned-config hash, which makes a rollback reproducible. */
  readonly configVersion: string | null;
  /** Whether `rollbackDeploy` would take this release's Build. */
  readonly rollbackable: boolean;
  /** Who asked, as {@link DeployView.requestedBy} prints it. */
  readonly requestedBy?: string;
  /** Whether the soak found this `LIVE` release failed. Absent: not faulty. */
  readonly faulty?: boolean;
}

export type BuildStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** One Build as the global artifact ledger presents it. */
export interface BuildListItem extends CommitHeadlineView {
  readonly id: number;
  readonly appId: string;
  readonly app: string;
  readonly componentId: string;
  readonly component: string;
  readonly commit: string;
  readonly targetShape: string;
  readonly artifactType: ArtifactType;
  readonly artifactDigest: string | null;
  readonly status: BuildStatus;
  readonly runner: string | null;
  readonly when: string;
  readonly at: string;
  /** The newest Deploy created from this Build, once placement has begun. */
  readonly deployId: number | null;
  /**
   * Why a `PENDING` Build is not yet claimed, from `recordDispatchWait`.
   * Cleared when a route claims it.
   */
  readonly dispatchWaitingOn: string | null;
}

/** One Deploy in the global placement ledger, including its owning App. */
export interface DeployLedgerItem extends DeployListItem {
  readonly appId: string;
  readonly app: string;
}

/** One App workspace timeline entry, linked to its attempt by id. */
export interface ActivityEntry {
  readonly kind: 'build' | 'deploy';
  readonly title: string;
  readonly detail: string;
  readonly when: string;
  readonly status: 'ok' | 'failed' | 'info';
  readonly deployId: number | null;
  readonly buildId: number | null;
}

/** One run of a job. */
export interface Execution {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'running';
  readonly detail: string;
  readonly when: string;
}

/**
 * A Component's output surface: a service's log stream, a job's executions, or
 * `none` with the reason.
 */
export type Runtime =
  | {
      readonly kind: 'stream';
      readonly componentId: string;
      readonly targetId: string;
      readonly lines: readonly LogLine[];
      /** How far back this Target's logs reach, in words. */
      readonly reach: string;
    }
  | {
      readonly kind: 'executions';
      /** The pair a run is started on and its logs are read by. */
      readonly componentId?: string;
      readonly targetId?: string;
      readonly executions: readonly Execution[];
      readonly retained: number;
      /** Why the list is empty, when reading it failed. Still runnable. */
      readonly because?: string;
    }
  | { readonly kind: 'none'; readonly because: string };

/** One Datastore as the workspace lists it. */
export interface DatastoreView {
  readonly id: string;
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
  readonly provenance: 'managed' | 'external';
  /**
   * The App's first Component, by name, once attached (the App's name when it
   * has none), or `null` while unattached.
   */
  readonly attachedTo: string | null;
  /** The hosting surface, as `datastoreVesselLabel` labels it. */
  readonly target: string;
  /** How far provisioning has got; a managed store converges like a Deploy. */
  readonly phase: DeployPhase;
  /** The operator's own sentence, which says why a Datastore is stuck. */
  readonly detail?: string;
  // No `connectionRef`: an external Datastore's is human-authored and can hold
  // the credential itself.
}

/** One Datastore as the global ledger lists it, attached or not. */
export interface DatastoreListItem {
  readonly id: string;
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
  readonly provenance: 'managed' | 'external';
  /** The App it is attached to, by name, or `null` while it is unattached. */
  readonly attachedTo: string | null;
  readonly target: string;
  readonly vesselId: string;
  readonly appId: string | null;
  readonly phase: DeployPhase;
  /** Whether `provision` returned a handle; `false` for any `external` one. */
  readonly provisioned: boolean;
  readonly detail?: string;
  readonly when: string;
  readonly at: string;
}

/**
 * A Vessel the ledger's Create picker offers: only one `createDatastore` would
 * accept, with the engines it serves.
 */
export interface DatastoreVesselOption {
  readonly vesselId: string;
  /** As `datastoreVesselLabel` renders it. */
  readonly label: string;
  readonly engines: readonly ('postgres' | 'valkey')[];
}

/**
 * One Datastore's own screen: the ledger row plus the backend's object. No
 * `connectionRef`, for the reason on {@link DatastoreView}.
 */
export interface DatastoreDetailView extends DatastoreListItem {
  /** The backend's object as JSON, or `null` when there is none to read. */
  readonly object: string | null;
  /** Set only when reading the object threw. */
  readonly objectError?: string;
}

/** One Component as the workspace lists it. */
export interface ComponentView {
  readonly id: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly phase: DeployPhase;
  readonly artifact: string;
  readonly reach: Reach;
  readonly auth: Auth;
  /** Where its newest release went; absent before its first Deploy. */
  readonly target?: string;
  /**
   * Every Target this Component still serves on, sorted by label: two during a
   * move, until `unplaceComponent` retires the old one. Empty if never placed.
   */
  readonly serving?: readonly {
    readonly targetId: string;
    readonly label: string;
  }[];
  readonly url?: string;
  readonly urlLive?: boolean;
  /** When this Component's newest release was written, in words. */
  readonly when?: string;
}

/** One zone this installation mints in, as the Domain control offers it. */
export interface ZoneOptionView {
  readonly name: string;
  /** A zone that cannot serve a placed Component's reach is shown disabled. */
  readonly reaches: readonly ('private' | 'public')[];
}

/** The App's own shared name, as the screen that sets it needs it. */
export interface AppDomainView {
  /** The label the App named, `@` for the zone itself, or null for none. */
  readonly label: string | null;
  /** The zone the App pinned, or null to take the first that serves. */
  readonly zone: string | null;
  /** Every zone it mints in, in the order an unpinned App takes. */
  readonly zones: readonly ZoneOptionView[];
  /** What the placed Components will answer on once a Deploy publishes. */
  readonly hostnames: readonly string[];
  /**
   * Whether more than one Component serves; the reconciler then publishes no
   * shared name.
   */
  readonly ambiguous: boolean;
  /** The Component carrying it while there is exactly one. */
  readonly servedBy: string | null;
}

/** The App workspace's whole state. */
export interface WorkspaceView extends CommitHeadlineView {
  readonly app: string;
  readonly appId?: string;
  readonly domain?: AppDomainView;
  /**
   * The Component the per-Component fields describe: the App's first when the
   * request named none. Absent for an App with no Components.
   */
  readonly componentId?: string;
  readonly targetId?: string;
  /** The placed Target's Vessel, which the Create-Datastore form submits. */
  readonly vesselId?: string;
  readonly latestDeployId?: number;
  readonly latestBuildId?: number;
  /**
   * The placed Target's runtime surface, or `none`. The boundary is
   * {@link vessel}.
   */
  readonly target: string;
  readonly vessel: string;
  readonly prerequisitesMet: boolean;
  readonly phase: DeployPhase;
  /** Where {@link componentId} answers; empty when it answers nowhere. */
  readonly url: string;
  /** Never true without a {@link url}, nor over a faulty release. */
  readonly urlLive: boolean;
  /**
   * Whether the post-readiness soak found the release behind {@link phase}
   * failed. {@link phase} stays `LIVE`.
   */
  readonly faulty?: boolean;
  readonly release: string;
  readonly components: readonly ComponentView[];
  /**
   * Every key configured for this pair, sorted. Never a value: the store is
   * write-only.
   */
  readonly configKeys: readonly string[];
  readonly datastores: readonly DatastoreView[];
  readonly activity: readonly ActivityEntry[];
  readonly runtime: Runtime;
  /**
   * Whether a push redeploys this App; `null` for an archive App, which no push
   * reaches.
   */
  readonly autoDeploy: boolean | null;
  /**
   * The App's chosen build route, or `null` for rank order. Also `null` for an
   * archive App, which consults no route.
   */
  readonly buildRoute: string | null;
  /**
   * Tells an archive App from a repo App on rank order; {@link buildRoute} is
   * `null` for both.
   */
  readonly archiveSourced?: boolean;
  /**
   * Every configured route in rank order, judged on the placed Target's level
   * only; `setAppBuildRoute` also checks the registry on submit. Empty for an
   * archive App and before any Target is placed.
   */
  readonly buildRouteOptions: readonly BuildRouteOptionView[];
  /** The latest Deploy's commit and time; absent before the first Deploy. */
  readonly commit?: string;
  readonly when?: string;
  readonly at?: string;
  /** Why the latest release failed or went faulty; absent otherwise. */
  readonly diagnosis?: Diagnosis;
  readonly drift?: DriftView;
  /**
   * The placed Target's unmet prerequisites, without `remediation`: the
   * Targets screen generates that.
   */
  readonly unmetPrerequisites?: readonly PrerequisiteRowView[];
  /** The hold on this App's deploys (`setAppLock`); absent when none. */
  readonly lock?: AppLockView;
  /** What the repository has that this release lacks; absent with no repo. */
  readonly source?: WorkspaceSourceView;
}

/** A deploy lock as the workspace banner prints it. */
export interface AppLockView {
  readonly reason: string;
  /** Who set it, as {@link DeployView.requestedBy} prints a principal. */
  readonly by: string;
  /** How long ago, in words. */
  readonly since: string;
  /** The ISO instant behind {@link since}. */
  readonly at: string;
}

/** Pushed but not live: the adopted commit beside the serving one. */
export interface WorkspaceSourceView {
  /** The default branch commits are adopted from. */
  readonly branch: string;
  /** The repository's web address; a commit links to `{url}/commit/{sha}`. */
  readonly url?: string;
  /**
   * The adopted commit when it is not what serves. `null` when it is, and
   * before anything has served.
   */
  readonly pending: {
    readonly commit: string;
    /** Whether the newest Build is of this commit and has not failed. */
    readonly dispatched: boolean;
  } | null;
}

/**
 * Where an App's code comes from and what governs its build. Read by
 * `getAppSource` apart from {@link WorkspaceView}: `manifest` is a live host
 * read, and the workspace polls every 2s while a release is in flight.
 */
export interface AppSourceView {
  /** `owner/name` when connected, else the URL the App was authored with. */
  readonly repo: string;
  /** Where to go and read it, or `null` when no address is known. */
  readonly url: string | null;
  /** The default branch, or `null` where no repository is connected. */
  readonly branch: string | null;
  /** Repository-relative; `.` is the root. */
  readonly subpath: string;
  /** The adopted commit {@link manifest} was read at. */
  readonly commit: string | null;
  readonly manifest: AppManifestView;
}

/**
 * The scope's `spindrift.yaml` at the adopted commit, carried whole. `unread`
 * means this installation could not look; `absent` means the file is not there.
 */
export type AppManifestView =
  | { readonly path: string; readonly state: 'present'; readonly text: string }
  | { readonly path: string; readonly state: 'absent' }
  | {
      readonly path: string;
      readonly state: 'unread';
      readonly because: string;
    };

/**
 * One build route, as the workspace's picker offers it. `level` is what the
 * route's profile guarantees, never a verified Build's level.
 */
export interface BuildRouteOptionView {
  readonly name: string;
  /** `null` when the route's manifest entry is missing. */
  readonly adapter: string | null;
  readonly level: 1 | 2 | 3;
  readonly eligible: boolean;
  /** `buildRouteCandidates`'s sentence; empty exactly when `eligible`. */
  readonly reason: string;
}

/**
 * One Target as the creation flow's Place step lists it; non-candidates are
 * listed disabled with why. `reasons` and `detail` are parallel arrays.
 */
export interface TargetOptionView {
  readonly targetId: string;
  /** The boundary this Target is a surface on. Half of what names it. */
  readonly vessel: string;
  /** The runtime surface it is. The other half. */
  readonly adapter: string;
  readonly rank: number;
  readonly candidate: boolean;
  readonly artifactType: ArtifactType | null;
  /**
   * `*.<zone>` for the zone core would mint this Component's canonical name in.
   * `null` when `coreMintsCanonical` is off: the adapter names its workloads.
   */
  readonly canonical: string | null;
  readonly reasons: readonly Exclusion[];
  readonly detail: readonly string[];
}

/** Everything both repository lists say about one repository. */
interface RepositoryIdentityView {
  readonly repositoryId: string | number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch: string;
  /**
   * Composed on the server: the repository host is an installation fact the
   * browser cannot read.
   */
  readonly cloneUrl: string;
}

/** A repository with a connection row here. */
export interface RepositoryOptionView extends RepositoryIdentityView {
  /** Whether an App already deploys from this repository. */
  readonly alreadyDeploys: boolean;
}

/**
 * A repository the GitHub App installation grants, or a connected one when
 * there is no App identity.
 */
export interface GrantedRepositoryView extends RepositoryIdentityView {
  /** Whether a connection row exists for it. */
  readonly rowExists: boolean;
}

/**
 * Whether this installation has a GitHub App identity to speak as.
 * `unauthorized` carries the manifest-flow form, POSTed from the browser to the
 * host, which redirects to the setup route with a conversion code.
 */
export type RepositoryConnectorView =
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'unauthorized';
      readonly setup: {
        /** Where the create-the-App form POSTs, `state` included. */
        readonly action: string;
        /** The manifest document, as the `manifest` form field's value. */
        readonly manifest: string;
      };
    }
  | {
      readonly state: 'authorized';
      readonly slug: string;
      readonly appId: string;
      /** `…/apps/<slug>/installations/new` on the host's web origin. */
      readonly installUrl: string;
    };

export type RepoConnectionHealth = 'connected' | 'connection_lost';

/** A linked repository as the repositories view lists it. */
export interface LinkedRepoView {
  readonly repositoryId: string | number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly health: RepoConnectionHealth;
  /** The error message when health is `connection_lost`. */
  readonly error: string | null;
  /** The last commit reconciled. */
  readonly lastReconciledSha: string | null;
  /**
   * Why the last refresh from the host failed. The row stays connected, but its
   * commit may be stale.
   */
  readonly staleReason: string | null;
  /** Subpaths of the Apps that deploy from it, sorted. */
  readonly appSubpaths: readonly string[];
  /**
   * The configuration pull request this connection opened. `null` once the repo
   * loop adopts a file from the default branch or sees the pull request closed.
   */
  readonly configPullRequest: number | null;
}

/**
 * One App as the app list presents it. Its per-Component fields all describe
 * the worst Component, whose phase is {@link phase}.
 */
export interface AppListItem extends CommitHeadlineView {
  /** `apps.name` is not unique, so the row keys, links and deletes by id. */
  readonly id: string;
  readonly name: string;
  readonly phase: DeployPhase;
  /**
   * The placed Target's runtime surface, marked while awaiting a first deploy;
   * `none` when unplaced.
   */
  readonly target: string;
  /** The boundary the placed Target is a surface on. Empty when unplaced. */
  readonly vessel: string;
  readonly url: string;
  readonly urlLive: boolean;
  /** Whether the soak found the row Component faulty. Absent: not faulty. */
  readonly faulty?: boolean;
  /** The row Component's kind, for the list's icon. */
  readonly kind: ComponentKind;
  /** `owner/name` plus any subpath, or `archive`. */
  readonly source: string;
  /** The row Component's artifact, as `artifactSummary` renders it. */
  readonly artifact: string;
  /** How many Components this App has, and how many are failed or faulty. */
  readonly componentCount?: number;
  readonly failing?: number;
  /** The row Component's latest release: its commit and when it was written. */
  readonly commit?: string;
  readonly when?: string;
  readonly at?: string;
  /** The release behind {@link phase}. */
  readonly deployId?: number;
}

/**
 * A cloud boundary's own facts, sent back unchanged on edit: `connectTarget`
 * rewrites the whole row, and these are never proposed to another project.
 */
export interface CloudBoundaryFacts {
  readonly serviceAccount?: string;
  readonly servedHosts?: string[];
  readonly reachableRegistries?: string[];
  readonly logHistorySeconds?: number;
}

/** A Target as the targets management view lists it. */
export interface TargetListItem {
  readonly id: string;
  /** The boundary this Target is a surface on. Half of what names it. */
  readonly vessel: string;
  /** The runtime surface; the screens post this pair to `disconnectTarget`. */
  readonly adapter: TargetAdapter;
  readonly rank: number;
  readonly health: 'healthy' | 'unhealthy';
  /** Prerequisite failure details when the Target is unhealthy. */
  readonly prerequisiteFailures?: readonly string[];
  /** The whole standing checklist, met rows included. */
  readonly prerequisites: readonly PrerequisiteRowView[];
  readonly kinds: readonly ComponentKind[];
  /**
   * `*.<zone>` for the zone core mints canonical names in on this Target.
   * `null` when `coreMintsCanonical` is off: the adapter names its workloads.
   */
  readonly canonical: string | null;
  /** A `disconnected` Target keeps serving, with its Deploys stranded. */
  readonly status: 'connected' | 'disconnected';
  /**
   * Whether anything has supplied this Target's connection. `false` is the
   * manifest-seeded state, distinct from `disconnected`.
   */
  readonly configured: boolean;
  /** When the standing checklist last ran, ISO-8601, or null if never. */
  readonly inspectedAt: string | null;
  /**
   * Dotted paths, never values, where this Target's row and its manifest entry
   * disagree. Saving Settings (`configureInstallation`) reverts them.
   */
  readonly connectionDivergence: readonly string[];
  /**
   * Where an edit of this connection starts, or `null` with no connection. An
   * edit reruns `connectTarget`, which also re-probes the boundary's surfaces.
   */
  readonly edit:
    | {
        readonly kind: 'cluster';
        readonly apiServer: string;
        readonly proposal: TargetConnectionProposal;
      }
    | {
        readonly kind: 'gcp-project';
        readonly project: string;
        readonly carried: CloudBoundaryFacts;
        readonly proposal: TargetConnectionProposal;
      }
    | {
        readonly kind: 'vercel-team';
        readonly team: string;
        readonly proposal: TargetConnectionProposal;
      }
    | {
        readonly kind: 'cloudflare-account';
        readonly account: string;
        readonly proposal: TargetConnectionProposal;
      }
    | null;
  /**
   * From `vesselRolesOf`. A boundary with any role but `app` reconciles from
   * the declaration on boot, so the screen offers no edit.
   */
  readonly vesselRoles: readonly VesselRole[];
}

/** One tenancy boundary, as the Targets screen shows it. */
export interface VesselListItem {
  readonly name: string;
  readonly kind: VesselKind;
  /** What the installation asks of it. `['app']` is an ordinary boundary. */
  readonly roles: readonly VesselRole[];
  readonly health: 'healthy' | 'unhealthy';
  /**
   * The boundary's standing checklist, met rows included. Empty when the
   * catalogue asks nothing of this vessel, which is not a pass.
   */
  readonly prerequisites: readonly PrerequisiteRowView[];
  /** When the standing pass last ran against it, ISO-8601, or null if never. */
  readonly inspectedAt: string | null;
  /** What that pass found in the boundary; `null` with no account-wide list. */
  readonly discovery: VesselDiscovery | null;
}

/**
 * A connect act this installation is waiting on: one per vessel, since one
 * connect registers every surface on it.
 */
export interface PendingTargetConnection {
  /** What `connectTarget` takes as its `kind`: the vessel's kind. */
  readonly kind: VesselKind;
  /** What `connectTarget` takes as its `vessel`. */
  readonly vessel: string;
  /** Every surface the connect probes for; only those found get registered. */
  readonly surfaces: readonly string[];
  readonly proposal: TargetConnectionProposal;
}

/**
 * Values proposed for a connect, carried from a configured Target of the same
 * adapter. Per-instance facts (`apiServer`, `project`, a Target's name) and
 * endpoints are never carried; each adapter defaults its own endpoint.
 */
export interface TargetConnectionProposal {
  /** The Target these values were read off, or null when there was none. */
  readonly carriedFrom: string | null;
  readonly namespace?: string;
  readonly deliveryFlavour?: 'flux-helmrelease' | 'argo-application';
  readonly sourceRef?: {
    readonly name: string;
    readonly namespace: string;
  };
  /**
   * Carried whole from a working cluster. `platform.dns.privateAddress` is
   * per-gateway, so the screen fills that one from the probe.
   */
  readonly chartValues?: Record<string, unknown>;
  readonly region?: string;
  /** Carried whole: unlike the endpoints, it has no default. */
  readonly policyEndpoint?: string;
}

export type { FunctionTarget };
export { FUNCTION_TARGETS };

/** One Function, as the ledger lists it (`listFunctions`). */
export interface FunctionListItem {
  readonly id: string;
  readonly name: string;
  readonly target: FunctionTarget;
  /** Where it answers, or `null` before its first successful deploy. */
  readonly url: string | null;
  /** ISO 8601, or `null` before its first successful deploy. */
  readonly deployedAt: string | null;
  /** The last deploy's failure, in operator words, or `null`. */
  readonly error: string | null;
  readonly updatedAt: string;
}

/** One Function's own screen: the ledger row plus the source it holds. */
export interface FunctionDetail extends FunctionListItem {
  readonly source: string;
  /** The names its environment holds, never the write-only values. */
  readonly envKeys: readonly string[];
}

export type { FunctionProbe };
