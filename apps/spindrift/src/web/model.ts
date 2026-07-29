/**
 * The read models the UI renders.
 *
 * Every command in `src/commands/` is an *act*. None of them is a query for a
 * screen, because §21 makes a command "one exported function per user act" and
 * a screen is not an act. So the shapes a view consumes live here, stated once,
 * and the views are written against them rather than against whatever a query
 * happens to return today.
 *
 * That ordering is deliberate. These types are built out of the domain's own
 * closed vocabularies — {@link FailureReason}, {@link Blame},
 * {@link ComponentKind}, {@link Exposure}, {@link Exclusion} — so a view cannot
 * render a phase, a blame, or an exclusion the domain does not have. When the
 * query commands land they will be typed to return these, and the compiler,
 * not a reviewer, is what will say whether they match.
 *
 * What is **not** here is any string a human reads that the domain could have
 * decided. `reasonCovers` already says what a failure reason covers; a view
 * that restated it in its own words would be a second vocabulary to keep in
 * step with the first.
 */
import type { Blame, FailureReason } from '../adapters/deploy/contract.ts';
import type {
  ArtifactType,
  ComponentKind,
  Exposure,
} from '../domain/desired-state.ts';
import type { Exclusion } from '../domain/placement.ts';

/**
 * §6's phases, verbatim: `PENDING → APPLYING → WAITING → LIVE | FAILED`.
 *
 * The UI collapses these into three tones and never into a stage rail — §18
 * rejects the rail explicitly, because the running App is the product and the
 * pipeline is only how it got there.
 */
export type DeployPhase =
  | 'PENDING'
  | 'APPLYING'
  | 'WAITING'
  | 'LIVE'
  | 'FAILED';

/** Whether a phase is still moving. Drives the pulsing dot and nothing else. */
export function isInFlight(phase: DeployPhase): boolean {
  return phase === 'PENDING' || phase === 'APPLYING' || phase === 'WAITING';
}

/** The status of one line in a checklist — a build step or a deployed resource. */
export type StepStatus = 'done' | 'running' | 'failed' | 'waiting';

/** One line of a checklist. §18: per-resource detail is one line, no tree. */
export interface ChecklistItem {
  /** The resource or step, named as the platform names it. */
  readonly name: string;
  readonly status: StepStatus;
  /** What it is doing, in the platform's own words. */
  readonly detail?: string;
}

/** One line of machine output. */
export interface LogLine {
  readonly text: string;
  /** `error` colours the line; `muted` recedes it. Neither is decoration. */
  readonly tone?: 'error' | 'muted';
}

/**
 * §4's `logFidelity`, which the deploy screen must state rather than paper
 * over: a runner that reports step status live but withholds log text until the
 * build finishes leaves the checklist as the only live view, and §18 requires
 * that sentence to be on the screen.
 */
export type LogFidelity = 'LIVE_TEXT' | 'LIVE_STATUS' | 'ON_COMPLETION';

/**
 * What core persisted when the deploy went red (§6, §12).
 *
 * Persisted, not fetched: §6 reads pods and events **once** on red and stores
 * the result, because the platform will not keep it. `blame` is derived from
 * the reason by `blameFor` and is never reported by an adapter, so it is
 * carried here rather than recomputed by a view.
 */
export interface Diagnosis {
  readonly reason: FailureReason;
  readonly blame: Blame | null;
  /** The sentence the developer reads. */
  readonly detail: string;
  /** What core actually saw — events, exit codes, probe results. */
  readonly evidence: string;
}

/** The build half of an attempt. */
export interface BuildView {
  readonly status: StepStatus;
  readonly duration?: string;
  readonly fidelity: LogFidelity;
  readonly steps: readonly ChecklistItem[];
  /**
   * `null` where the runner has not released log text yet — which is a state
   * to state, not an empty pane to show.
   */
  readonly log: readonly LogLine[] | null;
  /** The runner that produced it, for the header. */
  readonly runner: string;
}

/**
 * The deploy screen's whole state (Task 39).
 *
 * `previousReleaseUrl` is the field §18 singles out: **the red screen says the
 * previous release is still serving**, and that changed the feel of failure
 * more than anything else in the prototypes. It is set whenever a release is
 * still up, so the view never has to infer "nothing went down" from the absence
 * of something.
 */
export interface DeployView {
  readonly app: string;
  readonly component: string;
  readonly target: string;
  readonly commit: string;
  readonly phase: DeployPhase;
  /** The phase in the words a human reads — "Live", "Build failed". */
  readonly phaseWord: string;
  /** One sentence under the phase: what just happened, and when. */
  readonly headline: string;
  /** The canonical or vanity name this Component answers on (§9). */
  readonly url: string;
  /** Whether {@link url} currently serves this attempt's artifact. */
  readonly urlLive: boolean;
  /**
   * Set when an older release is still serving {@link url}. §6: exposure is
   * never mutated by a failed deploy, so on red this is the normal case.
   */
  readonly previousReleaseServing: boolean;
  readonly diagnosis: Diagnosis | null;
  readonly resources: readonly ChecklistItem[];
  readonly build: BuildView;
}

/** One activity-timeline entry on the App workspace. */
export interface ActivityEntry {
  readonly title: string;
  readonly detail: string;
  readonly when: string;
  readonly status: 'ok' | 'failed' | 'info';
}

/**
 * One run of a job (§17).
 *
 * §17: "**A job is not a stream but a list of executions.** An execution
 * terminates, so it is attempt-shaped; this pipe covers services only." That
 * sentence is why this type exists rather than a job's output being rendered
 * through the same `LogLine[]` a service uses — the two are different surfaces,
 * and giving a job a tail would say it has something to follow.
 */
export interface Execution {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'running';
  readonly detail: string;
  readonly when: string;
}

/**
 * What a Component's output surface is, and there are exactly three (§17, §18).
 *
 * §18: "Service logs, job executions, and the website no-runtime state stay
 * honestly distinct one level beneath it." A discriminated union rather than a
 * nullable log, because the three are different things and collapsing two of
 * them is precisely the dishonesty §17 names.
 *
 * `reach` on the service case is §17's other requirement: `logHistory` "is how
 * far back `since` can honestly reach... so a Target never *lacks* logs; it
 * only has a shorter memory, and the UI **states reach** rather than disabling
 * a tab."
 */
export type Runtime =
  | {
      readonly kind: 'stream';
      readonly lines: readonly LogLine[];
      readonly reach: string;
    }
  | {
      readonly kind: 'executions';
      readonly executions: readonly Execution[];
      readonly retained: number;
    }
  | { readonly kind: 'none'; readonly because: string };

/** One Datastore as the workspace lists it (§11). */
export interface DatastoreView {
  readonly name: string;
  readonly engine: 'postgres' | 'redis';
  readonly provenance: 'managed' | 'external';
  /** The Component it is attached to, or `null` while it is unattached. */
  readonly attachedTo: string | null;
  /** Where it lives — a cluster-local one pins its App to that Target (§11). */
  readonly target: string;
}

/** One Component as the workspace lists it. */
export interface ComponentView {
  readonly name: string;
  readonly kind: ComponentKind;
  readonly phase: DeployPhase;
  readonly artifact: string;
  readonly exposure: Exposure;
}

/**
 * The App workspace's whole state (Task 40).
 *
 * `vessel` is present and marked immutable because §14 makes it so: an App's
 * cloud project is chosen once, at creation, and the workspace is where a
 * developer would otherwise go looking for the setting that does not exist.
 */
export interface WorkspaceView {
  readonly app: string;
  readonly target: string;
  readonly vessel: string;
  readonly prerequisitesMet: boolean;
  readonly phase: DeployPhase;
  readonly url: string;
  readonly urlLive: boolean;
  readonly release: string;
  readonly components: readonly ComponentView[];
  readonly datastores: readonly DatastoreView[];
  readonly activity: readonly ActivityEntry[];
  /**
   * The Component's output surface (§17) — one of three, never a nullable log.
   * A `website` on a static Target is the case that forced the union: §17 gives
   * it an **honest empty state** rather than a disabled tab, and a job gets a
   * list of executions rather than a tail it has nothing to put in.
   */
  readonly runtime: Runtime;
}

/**
 * One Target as the creation flow's Place step lists it.
 *
 * §3's grammar in one type: candidates are selectable, non-candidates are
 * **listed, disabled, and annotated with why**. `reasons` and `detail` are
 * parallel arrays because that is what `resolveComponentPlacement` already
 * returns, and a view that re-shaped them would be inventing a second answer.
 */
export interface TargetOptionView {
  readonly targetId: string;
  readonly name: string;
  readonly adapter: string;
  readonly rank: number;
  readonly candidate: boolean;
  readonly artifactType: ArtifactType | null;
  /** The name this Component would answer on here (§9). */
  readonly canonical: string;
  readonly reasons: readonly Exclusion[];
  readonly detail: readonly string[];
}

/**
 * A connected repository as the repository picker lists it.
 *
 * §20: `Link repo` lists repositories currently granted to the installation.
 * Spindrift stores installation and stable repository IDs; the display fields
 * (fullName, defaultBranch) are refreshable.
 */
export interface RepositoryOptionView {
  /** GitHub's stable numeric or UUID repository ID, used as the selection key. */
  readonly repositoryId: string | number;
  /** The owner/name a human reads — e.g. `example-org/hub`. */
  readonly fullName: string;
  /** The branch Spindrift watches. */
  readonly defaultBranch: string;
  /** Whether this repository already has an App connected to it. */
  readonly connected: boolean;
}

/** The connection health of a linked repository (§20). */
export type RepoConnectionHealth = 'connected' | 'connection_lost';

/**
 * A linked repository as the repositories management view lists it.
 *
 * §20: Postgres stores installation and repository IDs, refreshable display
 * data, App subpaths, last-reconciled SHA, connection health, and error.
 */
export interface LinkedRepoView {
  readonly repositoryId: string | number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly health: RepoConnectionHealth;
  /** The error message when health is `connection_lost`. */
  readonly error: string | null;
  /** The last commit SHA Spindrift reconciled. */
  readonly lastReconciledSha: string | null;
  /** App subpaths connected to this repository. */
  readonly appSubpaths: readonly string[];
}

/**
 * One App as the app list presents it.
 *
 * Not the workspace — the list is the fast scan of what exists, and clicking
 * one navigates to the workspace.
 */
export interface AppListItem {
  readonly name: string;
  readonly phase: DeployPhase;
  readonly target: string;
  readonly vessel: string;
  readonly url: string;
  readonly urlLive: boolean;
  /** The first Component's kind, for the list's icon. */
  readonly kind: ComponentKind;
  /** The source: repo fullName or 'archive'. */
  readonly source: string;
  readonly release: string;
}

/** A Target as the targets management view lists it. */
export interface TargetListItem {
  readonly name: string;
  readonly adapter: string;
  readonly rank: number;
  readonly health: 'healthy' | 'unhealthy';
  /** Supported component kinds on this target. */
  readonly kinds: readonly ComponentKind[];
  /** The canonical hostname prefix for apps on this target. */
  readonly canonical: string;
}
