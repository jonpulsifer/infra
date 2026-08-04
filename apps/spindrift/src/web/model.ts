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
 * {@link ComponentKind}, {@link Reach}, {@link Exclusion} — so a view cannot
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
  Auth,
  ComponentKind,
  Reach,
} from '../domain/desired-state.ts';
import type { Exclusion } from '../domain/placement.ts';
import type { VesselKind } from '../domain/vessel.ts';

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
  /**
   * What core actually saw — events, exit codes, probe results — or `null`
   * where it recorded nothing.
   *
   * Nullable for the same reason `BuildView.log` is: a Deploy that went red
   * before anything observable happened has no evidence, and the honest
   * rendering of that is no pane at all. Rendering `"{}"` — a serialised
   * absence — puts a line on the screen no runner ever emitted, which is the
   * fabrication §6 exists to refuse.
   */
  readonly evidence: string | null;
}

/** The build half of an attempt, present only when a builder actually ran. */
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
  /**
   * How many lines the runner actually produced, of which {@link log} is the
   * tail.
   *
   * Carried rather than inferred from `log.length`, because those two numbers
   * disagreeing is the whole point: a screen that shows sixty lines of eight
   * hundred and says nothing has silently edited the evidence. The count is
   * what lets it say so, and say where the rest is.
   */
  readonly logTotal: number;
  /** The runner that produced it, for the header. */
  readonly runner: string;
  /**
   * The *platform* behind {@link runner}, as `manifest.build.routes` declares
   * it — `github-actions`, `cloud-build`, `in-cluster`.
   *
   * Carried beside the runner rather than instead of it, because the two answer
   * different questions and only one of them is stable. `runner` is the route's
   * name, which an installation chooses: "hosted" says which of *this*
   * installation's routes ran and nothing at all about what it is. The platform
   * is what tells an operator which failure modes are on the table — hosted CI
   * and the cloud builder fail in entirely different ways — and it is the key
   * the screen draws a mark from, the way a Target's adapter is.
   *
   * `null` for a Build whose recorded runner matches no configured route: a
   * route can be retired while its Builds stay readable, and naming no platform
   * is the honest answer there rather than guessing at one.
   */
  readonly runnerAdapter: string | null;
  /**
   * Where this build can be watched on the runner's own surface, or `null`
   * where the runner has none.
   *
   * It exists for the fidelity gap: a `LIVE_STATUS` route withholds its text
   * until the run ends, and the honest thing to do with a reader who wants it
   * now is send them where it is rather than ask them to wait at an empty pane.
   */
  readonly runUrl: string | null;
}

/**
 * Where a release's bytes came from (§4, §5).
 *
 * Every attempt has one of these; not every attempt has a {@link BuildView}.
 * §4: "Repo and archive share **one pipeline** — unpack, detect, build. An
 * archive of *finished output* is a supplied artifact, digested over the
 * uploaded bundle; an archive of *source* builds normally." So the origin is
 * the constant and the build is the variable, and a screen that led with the
 * build would have nothing to say about the release that was only ever
 * extracted.
 *
 * `subpath` is on both arms because §5's scope "is named, never searched" — the
 * bytes that were staged are the bytes under that path, and a reader comparing
 * two releases of a monorepo needs it as much as the commit.
 */
export type SourceView =
  | {
      readonly kind: 'repo';
      /** The repository, as the App names it. */
      readonly repo: string;
      /** The exact commit staged (§15). */
      readonly commit: string;
      readonly subpath: string;
    }
  | {
      readonly kind: 'archive';
      /** §16's join: the digest over the staged bundle, on both arms. */
      readonly digest: string;
      /** Where the staged bundle is fetched from, when it is recorded. */
      readonly location: string | null;
      readonly subpath: string;
      /**
       * Whether this upload was finished output rather than code — recorded and
       * extracted, never built (§4). It is the case that makes a release with no
       * Build a normal state instead of a missing one.
       */
      readonly extracted: boolean;
    };

/**
 * The deploy screen's whole state (Task 39).
 *
 * `previousReleaseUrl` is the field §18 singles out: **the red screen says the
 * previous release is still serving**, and that changed the feel of failure
 * more than anything else in the prototypes. It is set whenever a release is
 * still up, so the view never has to infer "nothing went down" from the absence
 * of something.
 */
/**
 * A `LIVE` release the platform has since stopped agreeing with (§6).
 *
 * Two shapes reach this one type, because a reader's next move is the same for
 * both — press re-converge — and the difference is only what to say first:
 * something else is serving (`observedDigest` differs), or nothing new can
 * serve at all (`detail` carries the platform's refusal).
 */
export interface DriftView {
  /** When the loop first saw the disagreement, in words — "2h ago". */
  readonly since: string;
  /** The instant behind {@link since}, for the title a reader hovers. */
  readonly at: string;
  /** The digest actually serving, when that is what differs. */
  readonly observedDigest: string | null;
  /**
   * Why the platform will not converge, in its own words.
   *
   * Present for a release whose delivery object is failing every reconcile —
   * stored values the current chart no longer accepts is the case this exists
   * for. `null` when the drift is an ordinary digest mismatch, which
   * {@link observedDigest} already explains.
   */
  readonly detail: string | null;
}

export interface DeployView {
  /**
   * The Deploy this attempt is, or `null` while it is still only a Build.
   *
   * §4: "a build records an artifact rather than deploying one", so a Build in
   * flight has no intent row and therefore no id — and §6 will not let one be
   * invented, because an intent naming a Build that has not succeeded could not
   * pass `checkDeployable`. The screen is addressable either way: `/builds/:id`
   * keeps this artifact attempt inspectable, while a related `/deploys/:id`
   * holds placement state.
   */
  readonly id: number | null;
  readonly buildId: number;
  readonly componentId: string;
  readonly targetId: string;
  /**
   * The App's id, beside its name because only the id identifies it: `apps` has
   * no unique constraint on `name`, so the redeploy button on this screen has to
   * act on the id or it acts on whichever row shares the name.
   */
  readonly appId: string;
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
  /**
   * What the platform stopped agreeing with, once this release was `LIVE` (§6).
   *
   * Separate from {@link diagnosis}, which belongs to an attempt that failed.
   * A drifted release succeeded; the disagreement started afterwards, and §6
   * wants it "a visible state with a one-click re-converge" — so it has to
   * reach a screen. `null` is the ordinary case: converged.
   */
  readonly drift: DriftView | null;
  readonly resources: readonly ChecklistItem[];
  /** Where this release's bytes came from. Always present (§4). */
  readonly source: SourceView;
  /**
   * The build that produced the artifact, or `null` when none ran.
   *
   * §4's supplied-artifact arm ends at a Build row that was born `SUCCEEDED`
   * with "no build adapter looked up, let alone invoked" — `runner` and
   * `logFidelity` are null on that row precisely because "saying so is more
   * useful than naming a runner that never ran". This field carries that
   * sentence into the UI rather than letting a screen invent a builder.
   */
  readonly build: BuildView | null;
  /** Controller and platform output for the deploy leg of this attempt. */
  readonly deployLog: readonly LogLine[] | null;
  /** How long ago this attempt was written — "8m ago". */
  readonly when: string;
  /** The instant behind {@link when}, for the title a reader hovers. */
  readonly at: string;
  /**
   * Whether this release is the one currently desired at its Component@Target.
   *
   * Read from the desired row rather than from the phase: a LIVE Deploy that a
   * newer intent has superseded is still LIVE — it is just no longer what
   * should be running — and only the desired row knows the difference.
   */
  readonly current: boolean;
  /** §10's hash over what this release pinned. Never the config itself. */
  readonly configVersion: string | null;
  /** The artifact this release delivers, as the Build recorded it. */
  readonly artifactDigest: string | null;
  /** The release immediately before this one here, for stepping back. */
  readonly previousDeployId: number | null;
  /**
   * Whether `rollbackDeploy` would take this release's Build (§6).
   *
   * Computed rather than inferred from `current`: §6 refuses a "rollback" to a
   * Build that is not older than what is desired, so the affordance appears
   * only where the act would be accepted.
   */
  readonly rollbackable: boolean;
}

/**
 * One Deploy as a releases list presents it (§2, §6).
 *
 * A list rather than a rolled-up "current release" because §2's "one Build →
 * many Deploys" only pays for itself if the many are visible: a rollback is an
 * ordinary deploy naming an older Build, and choosing which older Build means
 * reading the releases that named them.
 */
export interface DeployListItem {
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
  /** Whether this release is what the desired row currently names. */
  readonly current: boolean;
  /** §10's pinned-config hash, which is what makes rollback reproducible. */
  readonly configVersion: string | null;
  /**
   * Whether `rollbackDeploy` would take this release's Build.
   *
   * §6 refuses a "rollback" to a Build that is not older than what is desired —
   * a roll-forward somebody typed the wrong word for. The list computes the
   * same comparison so it can offer the act only where it would be accepted,
   * rather than offering it everywhere and refusing half the presses.
   */
  readonly rollbackable: boolean;
}

/** The lifecycle of one Build attempt, kept distinct from Deploy phases. */
export type BuildStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** One Build as the global artifact ledger presents it. */
export interface BuildListItem {
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
  /** The newest Deploy created from this Build, when placement has begun. */
  readonly deployId: number | null;
}

/** One Deploy in the global placement ledger, including its owning App. */
export interface DeployLedgerItem extends DeployListItem {
  readonly appId: string;
  readonly app: string;
}

/**
 * One activity-timeline entry on the App workspace.
 *
 * The two ids are what make the timeline a way *into* the system rather than a
 * wall of past tense: every event belongs to exactly one attempt (the
 * `attempt_events` check constraint enforces it), so every entry has somewhere
 * to go — `/deploys/:id` or `/builds/:id`.
 */
export interface ActivityEntry {
  /**
   * Which stage this checkpoint belongs to.
   *
   * Build and Deploy are two stages, not one pipeline with a tail, and the
   * timeline is where that is most easily lost: a column of "failed" lines
   * cannot say whether the image or its placement is the problem. The lane a
   * row sits in answers that before the words do.
   */
  readonly kind: 'build' | 'deploy';
  readonly title: string;
  readonly detail: string;
  readonly when: string;
  readonly status: 'ok' | 'failed' | 'info';
  readonly deployId: number | null;
  readonly buildId: number | null;
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
      readonly componentId: string;
      readonly targetId: string;
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
  readonly engine: 'postgres' | 'valkey';
  readonly provenance: 'managed' | 'external';
  /** The Component it is attached to, or `null` while it is unattached. */
  readonly attachedTo: string | null;
  /** Where it lives — a cluster-local one pins its App to that Target (§11). */
  readonly target: string;
}

/** One Component as the workspace lists it. */
export interface ComponentView {
  /**
   * The Component's id, and the only thing on this row an act can be aimed at.
   *
   * `setComponentReach` resolves on it. A row that carried only a name could
   * not, because `components` is unique per App and this list is per App — the
   * name is enough to read and not enough to write.
   */
  readonly id: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly phase: DeployPhase;
  readonly artifact: string;
  readonly reach: Reach;
  readonly auth: Auth;
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
  readonly appId?: string;
  readonly componentId?: string;
  readonly targetId?: string;
  readonly latestDeployId?: number;
  readonly latestBuildId?: number;
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
  /**
   * The zone core would mint this Component's canonical name into here (§9),
   * as `*.<zone>` — not the minted name itself; nothing has been named yet at
   * Place. `null` on a Target whose adapter names its own workloads
   * (`coreMintsCanonical` false), which must be rendered as that fact, never
   * defaulted back to a suffix.
   */
  readonly canonical: string | null;
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

/** Whether the repository connector can currently call GitHub for this user. */
export type RepositoryConnectorView =
  | { readonly state: 'unavailable' }
  | { readonly state: 'unauthorized' }
  | {
      readonly state: 'authorized';
      readonly login: string;
      readonly githubUserId: string;
    };

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
  /**
   * The App's id, and the only thing on this row that identifies it.
   *
   * `apps` carries no unique constraint on `name` — §2's Components and Targets
   * do, `apps` does not — so two rows can wear one name. A list that keyed,
   * linked, and deleted by name would hand both of them the same React key, the
   * same workspace, and a delete `deleteApp` refuses as ambiguous. Every
   * consumer already takes an id in the field it takes a name in
   * (`getAppWorkspace`, `deleteApp`), so the id travels with the row.
   */
  readonly id: string;
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
  readonly id: string;
  readonly name: string;
  readonly adapter: string;
  readonly rank: number;
  readonly health: 'healthy' | 'unhealthy';
  /** Prerequisite failure details when target is unhealthy. */
  readonly prerequisiteFailures?: readonly string[];
  /**
   * The whole standing checklist, met items included (§13).
   *
   * Not only the failures: §13 makes health "a standing prerequisite
   * checklist", and a list that showed only what is broken cannot answer *what
   * was checked* — which is the question an operator staring at a healthy
   * Target that will not take their app is actually asking.
   */
  readonly prerequisites: readonly {
    readonly name: string;
    readonly met: boolean;
    readonly detail?: string;
  }[];
  /** Supported component kinds on this target. */
  readonly kinds: readonly ComponentKind[];
  /**
   * The zone core mints canonical names into on this Target (§9), as
   * `*.<zone>`. `null` when the adapter names its own workloads instead
   * (`coreMintsCanonical` false, e.g. `cloudrun`, `static`) — the screen must
   * say that rather than show a suffix core will never mint.
   */
  readonly canonical: string | null;
  /** `disconnected` keeps serving; it strands Deploys rather than ending them. */
  readonly status: 'connected' | 'disconnected';
  /**
   * Whether anything has ever supplied this Target's connection facts.
   *
   * False is the manifest-seeded state: an identity and a rank exist and
   * nothing else does. It is a different state from a Target an operator
   * deliberately disconnected, and the two want opposite words on a button.
   */
  readonly configured: boolean;
  /** When the standing checklist last ran, ISO-8601, or null if never. */
  readonly inspectedAt: string | null;
  /**
   * Dotted paths where this Target's row and the manifest's entry for it
   * disagree, from `targetConnectionDivergence` — **paths, never values**.
   *
   * The row wins: a boot writes the stored manifest back without re-asserting a
   * declared connection over it, so an operator's correction survives a
   * restart. `configureInstallation` still writes the whole document, so this
   * is what a Target owes an operator before they save Settings and take their
   * own edit back. Empty is the ordinary case — and is also what a Target the
   * manifest declares no connection for correctly reports.
   */
  readonly manifestDivergence: readonly string[];
  /**
   * Where an edit of this Target's connection starts, or `null` on an adapter
   * the product has no edit surface for.
   *
   * Editing is `connectTarget` again — idempotent by name, and already the act
   * that writes these facts (§13). What it needs that a fresh connect does not
   * is *this* Target's own address: `TargetConnectionProposal` deliberately
   * omits `apiServer` because a second cluster prefilled with the first one's
   * would read as correct and deploy somewhere else, and that reasoning is
   * exactly inverted here — this is the one Target the address does name.
   *
   * `null` for `cloudrun` and `static`: `platform` chart values are a cluster's,
   * and a cloud project has no probe to read itself back through, so the edit
   * this field exists for has nothing to offer there.
   */
  readonly edit: {
    readonly apiServer: string;
    readonly proposal: TargetConnectionProposal;
  } | null;
}

/**
 * A connect act this installation is waiting on (§13).
 *
 * **One entry per vessel**, which is the same thing as one per act: connecting
 * a project registers every surface on it, so `bluenose-cloudrun` and
 * `bluenose-static` are one pending connection named `bluenose`. §13 is
 * explicit that the split is "a consequence of the model, not a decision", and
 * a screen listing two cards would make the operator learn it.
 *
 * The grouping is now a read rather than a reconstruction. These rows share a
 * `vesselId`; nothing recovers the act's name by slicing a suffix off a
 * Target's, which is what used to make an off-convention name unconnectable.
 */
export interface PendingTargetConnection {
  /** What `connectTarget` takes as its `kind` — the vessel's kind. */
  readonly kind: VesselKind;
  /** What `connectTarget` takes as its `name`. */
  readonly name: string;
  /** Every Target name this one act would configure. */
  readonly targets: readonly string[];
  readonly proposal: TargetConnectionProposal;
}

/**
 * Values proposed for a connect, and where each came from.
 *
 * Carried from a Target of the same adapter this installation has **already**
 * configured, never from a literal in this repository. §20 puts every value
 * naming a far side in the manifest, and a default compiled into `src/` would
 * be that contract broken quietly — so the only thing that can teach Spindrift
 * what a Cloud Run endpoint looks like here is a Cloud Run Target that is
 * already working here.
 *
 * What is **not** carried matters as much: an `apiServer`, a `project`, and a
 * Target's name are per-instance facts, and a plausible wrong default for one
 * of those is worse than an empty field. A second cluster prefilled with the
 * first one's in-cluster address would look right and be wrong.
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
   * §7's operator class, as an already-working cluster states it.
   *
   * Carried whole, and then read apart by the screen rather than by anything
   * here: `platform.externalAuth` names an authenticated edge that
   * `clusters/base` puts in the same namespace on every cluster, so the value
   * a working Target holds is the right proposal for the next one — while
   * `platform.dns.privateAddress` names one gateway's address and is the
   * opposite, which is why the screen fills that one from the probe and this
   * one from here. Untyped for the reason `KubernetesConnection.chartValues`
   * gives: the chart's classes are the adapter's knowledge.
   */
  readonly chartValues?: Record<string, unknown>;
  readonly region?: string;
  readonly runEndpoint?: string;
  readonly hostingEndpoint?: string;
  readonly policyEndpoint?: string;
}
