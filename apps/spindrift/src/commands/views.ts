/**
 * The read models the commands project and the UI renders.
 *
 * Every command in this directory is an *act*. None of them is a query for a
 * screen, because §21 makes a command "one exported function per user act" and
 * a screen is not an act. So the shapes a view consumes are stated here, once,
 * and the views are written against them rather than against whatever a query
 * happens to return today.
 *
 * They live beside the commands and not under `src/web/` because they are the
 * contract *between* the two: §21's "nothing in this layer knows it is reached
 * over HTTP, from a page, or from a test" cannot hold while a command's return
 * type is imported out of the views' own tree. A command returns one of these;
 * a page renders one; neither owns the other's tree.
 *
 * That ordering is deliberate. These types are built out of the domain's own
 * closed vocabularies — {@link FailureReason}, {@link Blame},
 * {@link DeployPhase}, {@link ComponentKind}, {@link Reach},
 * {@link Exclusion} — so a view cannot render a phase, a blame, or an
 * exclusion the domain does not have, and the compiler rather than a reviewer
 * is what says whether a projection matches.
 *
 * What is **not** here is any string a human reads that the domain could have
 * decided. `reasonCovers` already says what a failure reason covers; a view
 * that restated it in its own words would be a second vocabulary to keep in
 * step with the first.
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
import type { VesselKind, VesselRole } from '../domain/vessel.ts';

/**
 * One checklist row, as either screen renders it.
 *
 * Shared between a Target's checklist and its boundary's because the two are
 * the same row with a different subject — and because the remediation half is
 * the part that must not be rendered two different ways.
 */
export interface PrerequisiteRowView {
  /**
   * The catalogued name, not a free string: the screen posts it back to
   * `openPrerequisiteRemediation`, and a name that command's schema does not
   * carry is a button that cannot work.
   */
  readonly name: AnyPrerequisite;
  readonly met: boolean;
  readonly detail?: string;
  /**
   * What would clear it, present on every unmet row and absent on every met
   * one.
   *
   * The union carries its own `none` arm, so "no change could be generated for
   * this" is a value with a reason rather than a missing field — which is what
   * keeps it renderable as something other than an empty box.
   */
  readonly remediation?: Remediation;
}

/**
 * §6's phases, re-exported from the deploy contract that declares them.
 *
 * One vocabulary and not a second spelling of it: a projection's phase is the
 * phase an adapter reported, and two identical unions declared apart would
 * typecheck while drifting the moment §6 gains a phase. Re-exported rather
 * than made an import site's problem because every screen that renders a phase
 * already reads this module and none of them has any other business with an
 * adapter contract.
 *
 * The UI collapses them into three tones and never into a stage rail — §18
 * rejects the rail explicitly, because the running App is the product and the
 * pipeline is only how it got there.
 */
export type { DeployPhase };

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
  /**
   * What a PENDING Build is stuck on, in the operator's own words — set by
   * `recordDispatchWait` (`commands/builds/dispatch.ts`) and cleared the
   * moment a route actually claims it. `null` covers both "never refused" and
   * "already running", which is the distinction `status` already carries.
   */
  readonly dispatchWaitingOn: string | null;
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
      /**
       * The two ids a run is acted on by: `runComponent` starts one here, and
       * the runtime stream reads one run's logs by naming it beside them.
       *
       * On this arm as well as on `stream` because a job has both — an act and
       * a tail — while a `none` has neither. Absent where the Component has
       * never been placed: there is no Target to run it on, and a button that
       * could not resolve one would be a button that only ever fails.
       */
      readonly componentId?: string;
      readonly targetId?: string;
      readonly executions: readonly Execution[];
      readonly retained: number;
      /**
       * Why this list is empty, when it is empty because the read failed.
       *
       * A job that is placed on a Target is runnable whether or not its runs
       * could be listed, so a failed read stays on this arm rather than
       * collapsing to `none` — collapsing took the Run now button away in
       * exactly the state its diagnostics matter, the one where the Target
       * answers `403` because the Role has not reconciled yet.
       */
      readonly because?: string;
    }
  | { readonly kind: 'none'; readonly because: string };

/**
 * One Datastore as the global ledger lists it — every one this installation
 * holds, not one App's attached subset.
 *
 * `attachedTo` is the App's own name, which is what §11 attaches a Datastore
 * to. `vesselId` and `appId` travel with it because this is the screen that
 * Detaches and Destroys, and both acts resolve on an id.
 */
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
  /**
   * Whether `provision` ever returned a handle (§11).
   *
   * `false` covers both an `external` Datastore, which nothing ever
   * provisioned, and a `managed` one whose provisioning attempt has not
   * (yet, or ever) returned — the same two cases `destroyDatastore` collapses
   * before deciding whether it owes the adapter a call.
   */
  readonly provisioned: boolean;
  readonly detail?: string;
  readonly when: string;
  readonly at: string;
}

/**
 * A Vessel a managed Datastore can actually be created in — the ledger's
 * Create picker (§11).
 *
 * `createDatastore` takes a Vessel and no App, so this is the whole of what
 * the form needs to pick: creating storage has never required knowing which
 * App will read it. The list is what core would accept, not every Vessel that
 * exists — one whose hosting surface is missing or unconnected, or serves
 * neither engine, is one whose only answer is a refusal, so it is not offered.
 *
 * `engines` is per-Vessel because the two capabilities are independent (§3): a
 * cluster that serves Postgres and not Valkey is the ordinary case, and a
 * picker that showed one list for both would offer a choice core refuses.
 */
export interface DatastoreVesselOption {
  readonly vesselId: string;
  /** `datastoreVesselLabel` — the boundary-and-surface pair the rows use. */
  readonly label: string;
  readonly engines: readonly ('postgres' | 'valkey')[];
}

/**
 * One Datastore's own screen — the ledger row plus what the backend says about
 * it right now.
 *
 * The row's facts are `DatastoreListItem`'s, restated rather than extended
 * because this shape is reached by id and that one arrives in a list: a reader
 * of either should not have to know which. What is only here is `object` — the
 * far side's document, which no list would carry a copy of per row.
 *
 * No `connectionRef`. It names a Secret, and every screen states references
 * and never credentials: an `external` Datastore's is human-authored into the
 * same column a managed one's reference lands in,
 * and a human authoring a connection string writes the credential in it. The
 * variable it arrives on is a fact of the engine and is stated by the screen.
 */
export interface DatastoreDetailView extends DatastoreListItem {
  /**
   * The backend's own object, serialized, or `null` where there is none to
   * read — a `managed` row still provisioning, an `external` one nothing ever
   * created, a cloud backend whose API hands back no such document.
   *
   * JSON, because JSON is valid YAML and `Declaration` already renders it (its
   * note: "an emitter would be a thing to maintain for output nobody parses
   * back").
   */
  readonly object: string | null;
  /**
   * Why there is no object, when the reason is that reading it failed.
   *
   * Separate from `object: null` because the two are different answers and the
   * screen says different things about them: an unreachable cluster is a
   * sentence an operator acts on, and "nothing provisioned here" is not. The
   * rest of the screen renders either way — a Datastore whose Target is down is
   * exactly when its stored facts are worth reading.
   */
  readonly objectError?: string;
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
  /**
   * Where this Component is placed, and what it answers on.
   *
   * The hero states the placement of the *selected* Component only, so for an
   * App with three of them the other two's placement was unobtainable without
   * pressing each row in turn — which is the one thing a list of Components
   * exists to spare a reader. The workspace query already loads every
   * Component's newest Deploy with its Target and vessel; these are that row.
   *
   * Optional for the reason every other addition to this file is: the fixtures
   * build `ComponentView` literally, and a Component that has never been
   * placed genuinely has no answer here.
   */
  readonly target?: string;
  /**
   * Every (Component, Target) pair that still serves — the desired rows, not
   * the placement.
   *
   * A move is what makes the two differ: `placeComponent` leaves the pair it
   * moved away from in place, because what is live there keeps serving until
   * `unplaceComponent` retires it. So {@link target} is where this Component's
   * newest release went and this is every pair still standing behind one — one
   * row on an ordinary Component, two through a move, and that difference is
   * the whole reason `unplaceComponent` needs a control per pair rather than
   * one button.
   *
   * Empty is also the answer for a Component nothing has placed, which is what
   * the screen tests before it offers a move at all: a first placement is
   * `deployApp`'s to write, not a move.
   *
   * The id travels because the act does: `unplaceComponent` resolves on
   * (componentId, targetId), and a label is not one. Optional for the reason
   * every other addition to this file is — the fixtures build `ComponentView`
   * literally.
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

/**
 * The App workspace's whole state (Task 40).
 *
 * `vessel` is the boundary the placed Target is a surface on, read from that
 * Target rather than from the App. An App is not in a vessel; its Components
 * are placed, and where they land is what the screen states. Moving a Component
 * therefore moves what this field says, which is the honest behaviour — the
 * column that used to answer this could not change and could not be checked.
 */
export interface WorkspaceView {
  readonly app: string;
  readonly appId?: string;
  /**
   * Which of {@link components} this view's per-Component half is about — its
   * runtime, its placement, its release and its config keys.
   *
   * The selection the read resolved, echoed rather than assumed: a screen that
   * asked for no Component is answered with the App's first, so the list can
   * mark the row it is showing without holding a second idea of which one that
   * is. Absent for an App with no Components at all.
   */
  readonly componentId?: string;
  readonly targetId?: string;
  /**
   * The boundary the placed Target is a surface on, by id — what the inline
   * Create-Datastore form submits, since `createDatastore` takes a Vessel and
   * this screen binds the choice rather than offering a picker.
   */
  readonly vesselId?: string;
  readonly latestDeployId?: number;
  readonly latestBuildId?: number;
  /** The runtime surface the placed Target is — the boundary is {@link vessel}. */
  readonly target: string;
  readonly vessel: string;
  readonly prerequisitesMet: boolean;
  readonly phase: DeployPhase;
  /**
   * Where {@link componentId} answers, empty for a Component that answers
   * nowhere — every job, and anything not deployed under a vanity domain.
   */
  readonly url: string;
  /** That {@link url} is being served. Never true without one. */
  readonly urlLive: boolean;
  readonly release: string;
  readonly components: readonly ComponentView[];
  /**
   * Every key configured for this pair (§10), sorted — never a value. Core's
   * store is write-only, so this is the same read `setConfig` uses to know
   * what is already there, and it is the only shape the workspace is
   * allowed to render.
   */
  readonly configKeys: readonly string[];
  readonly activity: readonly ActivityEntry[];
  /**
   * The Component's output surface (§17) — one of three, never a nullable log.
   * A `website` on a static Target is the case that forced the union: §17 gives
   * it an **honest empty state** rather than a disabled tab, and a job gets a
   * list of executions rather than a tail it has nothing to put in.
   */
  readonly runtime: Runtime;
  /**
   * Whether a push to this App's repository redeploys it (§15).
   *
   * `null` for an App deployed from an uploaded archive: no push can reach it,
   * so "off" would be a state it could be turned out of and this is not one.
   * The screen renders the absence, never a disabled switch pretending there
   * is a choice.
   */
  readonly autoDeploy: boolean | null;
  /**
   * Which route this App builds on, or `null` for rank order (§4, §16) — the
   * App's own opinion, narrower than but never overriding the installation's
   * rank (`setAppBuildRoute`).
   *
   * `null` for an archive App too, for the same reason {@link autoDeploy} is:
   * §4's supplied artifact "consults no route at all", so there is nothing
   * here to choose.
   */
  readonly buildRoute: string | null;
  /**
   * Whether this App's source is an uploaded archive rather than a repo.
   *
   * Not derivable from what is already here: `buildRoute` and `autoDeploy` are
   * both null for an archive App and for a repo App that has set neither, so a
   * screen reading them cannot tell "there is nothing to choose" from "nothing
   * has been chosen". The Component upload control needs the distinction —
   * an archive App's bytes cannot be fetched again, so uploading is the only
   * way to give it a new release, which is a different sentence from the
   * escape hatch a repo App gets.
   *
   * Optional because every fixture in the tree builds this row literally.
   */
  readonly archiveSourced?: boolean;
  /**
   * Every build route this installation configures, in rank order, judged
   * against the placed Target's minimum level alone.
   *
   * That is the same half `setAppBuildRoute` checks before it ever looks at a
   * registry — so a route this screen offers as eligible is one the command
   * will not refuse on the level threshold. It is not the whole of what the
   * command checks: the registry half is a live round trip made at submit
   * time, not repeated by this read.
   *
   * Empty for the same two absences {@link buildRoute} answers with `null`,
   * plus a third: no Target placed yet to judge a level against.
   */
  readonly buildRouteOptions: readonly BuildRouteOptionView[];
  /**
   * What the release named by {@link release} delivered, and when.
   *
   * The workspace held a phase pill and a release id and nothing that could
   * date either: an operator looking at `LIVE` could not tell whether it went
   * out four minutes or four months ago, and could not tell which commit is
   * serving without opening the attempt screen. Both facts are on the Deploy
   * row the query already reads.
   */
  readonly commit?: string;
  readonly when?: string;
  readonly at?: string;
  /**
   * Why the release went red (§6), and what the platform has since stopped
   * agreeing with (§6's drift).
   *
   * These are the two panels the App surface was missing entirely. §6 persists
   * a diagnosis on red because the platform will not keep it, and records
   * `drifted_at` when a LIVE release stops matching what is running — and
   * until now both were readable only at `/deploys/:id`, which meant a drifted
   * App read "is live" and a failed one read "has no release serving yet" with
   * no reason and no evidence anywhere on the screen an operator was on.
   *
   * Absent rather than nullable: a healthy release has no diagnosis, and a
   * field that is present-and-null asks every reader to distinguish two
   * spellings of nothing.
   */
  readonly diagnosis?: Diagnosis;
  readonly drift?: DriftView;
  /**
   * The prerequisites of the placed Target that are *not* met.
   *
   * `prerequisitesMet` is a boolean, and "A prerequisite is unmet" over an App
   * that will not deploy is a dead end on the one screen where the question is
   * being asked. These are the rows behind that word.
   *
   * Only the unmet ones, and without `remediation`: the whole standing
   * checklist and the change that clears each row belong to the Targets screen,
   * which has the manifest and the boundary in hand to generate one. This says
   * what is blocking and points there — a second, thinner generator here would
   * be a second answer to a question §13 already answers once.
   */
  readonly unmetPrerequisites?: readonly PrerequisiteRowView[];
}

/**
 * One build route, as the workspace's picker offers it (§16).
 *
 * `level` is what the route's *profile* guarantees, never a verified Build's —
 * `domain/build-route.ts`'s `BuildRouteProfile.level` is the type this comes
 * from, and that field's own note draws the same line. `adapter` is `null`
 * only where this route's manifest entry could not be found, which the picker
 * renders as a name with no mark rather than a missing tile.
 */
export interface BuildRouteOptionView {
  readonly name: string;
  readonly adapter: string | null;
  readonly level: 1 | 2 | 3;
  readonly eligible: boolean;
  /** The sentence `buildRouteCandidates` composed. Empty exactly when `eligible`. */
  readonly reason: string;
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
  /** The boundary this Target is a surface on. Half of what names it. */
  readonly vessel: string;
  /** The runtime surface it is. The other half. */
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

/** Everything both repository lists say about one repository. */
interface RepositoryIdentityView {
  /** GitHub's stable numeric or UUID repository ID, used as the selection key. */
  readonly repositoryId: string | number;
  /** The owner/name a human reads — e.g. `example-org/hub`. */
  readonly fullName: string;
  /** The branch Spindrift watches. */
  readonly defaultBranch: string;
  /**
   * Where this repository is cloned from.
   *
   * Composed here rather than in the browser because the repository host is an
   * installation fact (§20) and the browser reads no manifest: a client-side
   * template would name the public host on an installation that has its own.
   */
  readonly cloneUrl: string;
}

/**
 * A repository Spindrift holds a connection row for.
 *
 * §20: Spindrift stores installation and stable repository IDs; the display
 * fields (fullName, defaultBranch) are refreshable.
 */
export interface RepositoryOptionView extends RepositoryIdentityView {
  /**
   * Whether an App already deploys from this repository.
   *
   * Named for what it is because the grant list carries a boolean about the
   * same repository meaning something else entirely: two fields called
   * `connected` on one response, rendered with one green badge, is a badge that
   * claims whichever of the two the reader happens to assume.
   */
  readonly alreadyDeploys: boolean;
}

/**
 * A repository the GitHub App installation currently grants.
 *
 * The grant is a fact about GitHub, so the only thing this list knows about
 * Spindrift is whether a row for it exists here yet.
 */
export interface GrantedRepositoryView extends RepositoryIdentityView {
  /** Whether Spindrift already holds a connection row for it. */
  readonly rowExists: boolean;
}

/**
 * Whether this installation has a GitHub App identity to speak as.
 *
 * `unauthorized` carries the manifest-flow form that creates one: a POST
 * straight from the operator's browser to the repository host, whose redirect
 * lands on the setup route with a conversion code. `authorized` names the App
 * and links where installations are added — the two acts GitHub requires a
 * human click for.
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
  /**
   * Why the last refresh of this row from the host failed, if it did.
   *
   * Separate from `error`, which is about access being lost. This one is a row
   * that is still connected and whose commit is older than it looks: listing
   * every repository refreshes them all, and one the host would not answer
   * about is a stale row rather than a missing one.
   */
  readonly staleReason: string | null;
  /** App subpaths connected to this repository. */
  readonly appSubpaths: readonly string[];
  /**
   * The configuration pull request this connection opened, while it is still
   * the thing standing between the repository and its own builds.
   *
   * Null once the repo loop has adopted a Spindrift file from the default
   * branch, which is what merging it looks like from here: nothing subscribes
   * to `pull_request` deliveries, so a merge is observed as configuration
   * arriving on the default branch rather than as a pull request closing.
   */
  readonly configPullRequest: number | null;
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
  /**
   * The runtime surface the placed Target is, beside the boundary it sits on.
   * The two together are what identify it; neither alone does.
   */
  readonly target: string;
  /** The boundary the placed Target is a surface on. Empty when unplaced. */
  readonly vessel: string;
  readonly url: string;
  readonly urlLive: boolean;
  /**
   * The kind of the Component this row is reporting on — the one whose phase
   * became {@link phase} — for the list's icon.
   *
   * Not the App's first Component. Every fact on the row belongs to one
   * Component and it has to be the same one throughout, or the icon says
   * `website` over a job's failure.
   */
  readonly kind: ComponentKind;
  /** The source: repo fullName or 'archive'. */
  readonly source: string;
  /**
   * The live Component's artifact, as {@link
   * import('../domain/artifact-name.ts').artifactSummary} renders it —
   * `image · a1b2c3d4e5f6`, never a config hash.
   *
   * Not called `release`: {@link WorkspaceView.release} already owns that name
   * for `Deploy <id>`, a reference to the release row rather than to the bytes
   * it delivers, and the two answer different questions an operator asks —
   * "which attempt is this" versus "what is actually running". Reusing one
   * name for both was the bug this field exists to close: a row's `release`
   * used to read `deploy.configVersion`, which is total over an empty
   * document (§10) and so is byte-identical across every App with no config,
   * rendered as `sha256:…` so it looked like the artifact digest while
   * answering nothing about which artifact was live.
   */
  readonly artifact: string;
  /**
   * How many Components this App has, and how many of them are red.
   *
   * {@link phase} is the worst of them, which is the only honest single word
   * for an App with a green `web` and a red `worker` — but "failed" over a
   * three-Component App says nothing about how much of it is down. These two
   * are what turn that word back into a fact: `failed · 1 of 3`.
   *
   * Optional because every fixture in the tree builds this row literally, and
   * a count that is absent reads the same as an App nobody has told the list
   * about yet. A row without them renders the word alone, as it always did.
   */
  readonly componentCount?: number;
  readonly failing?: number;
  /**
   * The commit the row's release was built from, and when that release was
   * written.
   *
   * All three describe the same Component the rest of the row does — the one
   * whose phase became the App's. A row that named one Component's artifact
   * beside another's commit would be two answers wearing one line.
   */
  readonly commit?: string;
  readonly when?: string;
  readonly at?: string;
  /**
   * The release behind {@link phase}, so the row can reach the attempt that
   * produced what it is reporting rather than only the App that owns it.
   */
  readonly deployId?: number;
}

/**
 * A cloud boundary's own facts, which an edit restates rather than re-derives.
 *
 * `connectTarget` writes the whole connection and the whole vessel row, so a
 * fact the form does not send back is a fact the edit deletes — the identity a
 * scheduled job fires as, the hosts §33 resolves against, the registries §3
 * reads. None of them may be *proposed* to a different project, which is
 * exactly why they travel beside the boundary's own id rather than in
 * {@link TargetConnectionProposal}.
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
  /**
   * The runtime surface it is. The other half — and the enum rather than a
   * string, because the screens post this pair back to `disconnectTarget`.
   */
  readonly adapter: TargetAdapter;
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
  readonly prerequisites: readonly PrerequisiteRowView[];
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
   *
   * Named `connectionDivergence` rather than `manifestDivergence` — the name
   * this field used to share with `GetInstallationManifestResult`'s field —
   * because the two answer different questions over the same
   * `diffManifestPaths` walk: this one compares a Target's row against its own
   * manifest entry; that one compares the mounted declaration against the
   * stored manifest.
   */
  readonly connectionDivergence: readonly string[];
  /**
   * Where an edit of this Target's connection starts, or `null` where there is
   * no connection to start from.
   *
   * Editing is `connectTarget` again — idempotent by `(vessel, adapter)`, and
   * already the act that writes these facts (§13). What it needs that a fresh
   * connect does not is *this* boundary's own address:
   * `TargetConnectionProposal` deliberately omits `apiServer` and `project`
   * because a second boundary prefilled with the first one's would read as
   * correct and deploy somewhere else, and that reasoning is exactly inverted
   * here — this is the one boundary the address does name.
   *
   * **It is also the only re-probe an operator has.** One connect asks the
   * boundary about every surface `surfacesToProbe` names, so re-running it is
   * how a project whose Cloud Run API was switched off at connect time gets its
   * `cloudrun` Target the day somebody switches it on. The absence a connect
   * reported is deliberately not stored — what a boundary carries is a fact
   * about the boundary, and a copy of it here would be a copy that goes stale
   * the moment the API is enabled — so being able to ask again is what stands
   * in for remembering the answer.
   *
   * Discriminated on the vessel's kind, because the address the form starts
   * from is the location's shape.
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
   * What this Target's boundary is to the installation, from
   * `vesselRolesOf` — `['app']` for an ordinary one.
   *
   * The screen reads it to decide whether this Target is the operator's to
   * change. A boundary the installation itself is built on reconciles from the
   * declaration on every boot, so an edit here would be reverted by the next
   * restart with nothing on screen saying why; the honest surface is one that
   * does not offer the control, and says where the values come from instead.
   */
  readonly vesselRoles: readonly VesselRole[];
}

/**
 * One tenancy boundary, as the Targets screen shows it.
 *
 * A peer of {@link TargetListItem} rather than a field on it, because a
 * boundary's checklist is one fact and a vessel may carry two surfaces — folded
 * into the Target rows it would be the same four answers rendered twice, which
 * is the duplication the vessel noun exists to remove.
 */
export interface VesselListItem {
  readonly name: string;
  /** The shape of its address, and nothing else — see `domain/vessel.ts`. */
  readonly kind: VesselKind;
  /** What the installation asks of it. `['app']` is an ordinary boundary. */
  readonly roles: readonly VesselRole[];
  readonly health: 'healthy' | 'unhealthy';
  /**
   * The whole standing checklist for the boundary, met rows included — and
   * empty for a vessel the catalogue asks nothing of, which is not the same as
   * a vessel that passed.
   */
  readonly prerequisites: readonly PrerequisiteRowView[];
  /** When the standing pass last ran against it, ISO-8601, or null if never. */
  readonly inspectedAt: string | null;
}

/**
 * A connect act this installation is waiting on (§13).
 *
 * **One entry per vessel**, which is the same thing as one per act: connecting
 * a project registers every surface on it, so a project's `cloudrun` and
 * `static` surfaces are one pending connection named for the project. §13 is
 * explicit that the split is "a consequence of the model, not a decision", and
 * a screen listing two cards would make the operator learn it.
 *
 * The grouping is a read rather than a reconstruction. These rows share a
 * `vesselId`, which is what a Target is a surface on — there is no name to
 * slice a suffix off of.
 */
export interface PendingTargetConnection {
  /** What `connectTarget` takes as its `kind` — the vessel's kind. */
  readonly kind: VesselKind;
  /** What `connectTarget` takes as its `vessel`. */
  readonly vessel: string;
  /**
   * Every surface this one act would probe that vessel for.
   *
   * What it registers is what the probe establishes, which may be fewer: a
   * boundary that turns out not to carry one of these gets a sentence saying
   * so instead of a Target.
   */
  readonly surfaces: readonly string[];
  readonly proposal: TargetConnectionProposal;
}

/**
 * Values proposed for a connect, and where each came from.
 *
 * Carried from a Target of the same adapter this installation has **already**
 * configured, never from a literal in this repository. §20 puts every value
 * naming a far side in the manifest, and a value that genuinely differs per
 * project or team is only safe to propose because a working Target already
 * proved it.
 *
 * What is **not** carried matters as much: an `apiServer`, a `project`, and a
 * Target's name are per-instance facts, and a plausible wrong default for one
 * of those is worse than an empty field. A second cluster prefilled with the
 * first one's in-cluster address would look right and be wrong.
 *
 * **No `runEndpoint`, `hostingEndpoint`, `vercelEndpoint` or `pagesEndpoint`
 * here.** Those four were never a proposal in the sense the rest of this type
 * is — they were the one value every cloud Target of a given adapter shares,
 * carried forward only because the connect screen used to make an operator
 * type it. Each adapter now applies its own default (`DEFAULT_ENDPOINT`
 * beside its implementation) when a Target's `connection.endpoint` is absent,
 * so there is nothing left here to propose. An installation that genuinely
 * needs a non-default endpoint — a perimeter, a mirror — still has one: the
 * manifest declares `targets[].connection.endpoint` directly (§20), which
 * this screen never mediates.
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
  /**
   * Where this project's admission policy is read from, as an already-working
   * Cloud Run Target states it. Unlike the endpoints above, this genuinely has
   * no default (`domain/target.ts`'s `CloudRunConnection.policyEndpoint`
   * explains why), so it stays a real proposal — carried whole, with no visible
   * control, the same way `chartValues` is.
   */
  readonly policyEndpoint?: string;
}
