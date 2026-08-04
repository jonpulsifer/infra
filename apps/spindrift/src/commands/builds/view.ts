/**
 * The source and build halves of an attempt, projected once for both screens.
 *
 * `/deploys/:id` and `/builds/:id` render the same drawers, and they have to
 * agree about what they say: a build that reads "5 steps, 42s, LIVE_STATUS" on
 * one screen and "1 step, no duration" on the other is one screen lying.
 * Projecting here is what makes that a structural guarantee rather than two
 * copies somebody keeps in step.
 *
 * The asymmetry between the two exports is §4's, not a convenience: **every
 * attempt has a source, and only some have a build.** An archive of finished
 * output is "a supplied artifact, digested over the uploaded bundle" — recorded
 * with no adapter looked up — so {@link buildViewOf} answers `null` for it,
 * while {@link sourceViewOf} always answers.
 */
import type { App, AttemptEvent, Build } from '../../db/schema.ts';
import type {
  BuildView,
  ChecklistItem,
  LogFidelity,
  LogLine,
  SourceView,
  StepStatus,
} from '../../web/model.ts';
import type { CommandContext } from '../types.ts';

/** How a Build's status reads as a checklist status. */
export function buildStepStatus(status: Build['status']): StepStatus {
  if (status === 'SUCCEEDED') return 'done';
  if (status === 'FAILED') return 'failed';
  if (status === 'PENDING') return 'waiting';
  return 'running';
}

/**
 * Whether this Build row records finished output rather than something built.
 *
 * The two facts checked are exactly the two `uploadArchive` writes on its
 * supplied arm: the artifact digest **is** the bundle digest — core digested
 * what was uploaded rather than something a builder emitted — and no runner
 * ever claimed it. A source archive gets a runner and an artifact digest of its
 * own, so the pair is what separates "extracted" from "built" without a column
 * saying which.
 */
export function isSuppliedArtifact(build: Build): boolean {
  return (
    build.runner === null &&
    build.artifactDigest !== null &&
    build.artifactDigest === build.bundleDigest
  );
}

/**
 * Where this release's bytes came from (§4, §5).
 *
 * Read off the App's declared source kind rather than guessed from the Build:
 * §2 puts the origin on the App — "immutable vessel reference, domain, config"
 * — and the Build carries only what staging produced from it.
 */
export function sourceViewOf(app: App, build: Build): SourceView {
  const subpath = build.bundleSubpath ?? app.sourceRepoSubpath ?? '.';

  if (app.sourceKind === 'repo') {
    return {
      kind: 'repo',
      repo: app.sourceRepoUrl ?? 'unknown repository',
      // §2 keys a Build on the commit, so the Build is the authority on which
      // one this release delivers — the App only says where commits come from.
      commit: build.commit,
      subpath,
    };
  }

  return {
    kind: 'archive',
    // `commitOf` puts the bundle digest in the commit column for an upload, so
    // either column answers; `bundleDigest` is the one that means it.
    digest: build.bundleDigest ?? build.commit,
    location: build.bundleLocation,
    subpath,
    extracted: isSuppliedArtifact(build),
  };
}

/**
 * One Build, plus whatever its runner has said so far — or `null` where no
 * builder ran at all (§4).
 *
 * The events are read here rather than passed in because the two callers reach
 * this from different directions — one holds a Deploy, the other a Build — and
 * the query is the same either way.
 */
export async function buildViewOf(
  context: CommandContext,
  build: Build,
): Promise<{ view: BuildView | null; events: readonly AttemptEvent[] }> {
  if (isSuppliedArtifact(build)) {
    // Nothing ran, so there is nothing to project. Returning an empty
    // `BuildView` here would put a checklist and a fidelity on a release that
    // never had either, which is the fiction the null exists to refuse.
    return { view: null, events: [] };
  }

  const events = await context.db.query.attemptEvents.findMany({
    where: (rows, { eq }) => eq(rows.buildId, build.id),
    orderBy: (rows, { asc }) => [asc(rows.id)],
  });

  const status = buildStepStatus(build.status);

  const log: LogLine[] = events
    .filter((event) => event.eventType === 'log' && event.line)
    .map((event) => ({
      text: event.line!,
      tone: event.reason ? ('error' as const) : undefined,
    }));

  const steps = checkpointsOf(events, status);

  return {
    view: {
      status,
      duration: durationOf(context, build, events),
      fidelity: (build.logFidelity ?? 'LIVE_TEXT') as LogFidelity,
      // A Build with no step events is still a Build doing one thing, and
      // saying so beats an empty checklist that reads as a broken stream.
      steps: steps.length > 0 ? steps : [{ name: 'build artifact', status }],
      // Null rather than `[]`: §4's `logFidelity` distinguishes "the runner has
      // released nothing yet" from "the runner printed nothing", and the screen
      // states the first rather than rendering the second as an empty pane.
      log: log.length > 0 ? log.slice(-LOG_TAIL) : null,
      logTotal: log.length,
      runner: build.runner ?? 'hosted runner',
      // §20: the route table is a manifest value, so the route name a Build
      // recorded is resolved against it here rather than by the screen — the
      // browser has no manifest, and inventing a name→platform table in the
      // client would be a second copy of an installation's configuration.
      runnerAdapter:
        context.manifest.build.routes.find(
          (route) => route.name === build.runner,
        )?.adapter ?? null,
      runUrl: build.runUrl ?? null,
    },
    events,
  };
}

/**
 * How much of the runner's transcript the drawer carries.
 *
 * A build prints thousands of lines and the screen is not a terminal — the
 * checkpoints above it are what says how the build went, and the text is the
 * evidence for the last thing that happened. The tail is the part that holds
 * that evidence: a failure is at the end of the log, never in the middle. The
 * whole transcript stays one click away on the runner's own page, which is what
 * `runUrl` is for, and `logTotal` says how much was left there.
 */
const LOG_TAIL = 60;

/** A step's reported state in the checklist's words. */
function stepStatusOf(phase: string | null, failed: boolean): StepStatus {
  if (failed || phase === 'FAILED') return 'failed';
  if (phase === 'SUCCEEDED') return 'done';
  if (phase === 'RUNNING') return 'running';
  return 'waiting';
}

/**
 * The named checkpoints of a build, in the order the runner reached them.
 *
 * A step is not one event — a route reports `RUNNING` and then a verdict for
 * the same name (`stepEvents` in the GitHub Actions route emits exactly that
 * pair), and log lines arrive under it in between. Folding them by name is what
 * turns a flat event list into a checklist that says what each step *is doing*
 * rather than marking everything done because it was mentioned. The latest
 * status event for a name wins; the pair of timestamps around it gives the step
 * a duration, which is the whole reason a reader scans this list.
 *
 * A name carried only by log lines — `dispatch`, `provenance`, and the runner's
 * own job entry — never gets a status event, so it keeps its sentence as its
 * detail instead of a duration. That is the one thing it has to say, and
 * dropping it would leave a bare word.
 *
 * **A finished run leaves nothing in progress**, which is why the Build's own
 * status is an argument here. Two different names would otherwise sit at
 * `running` on a build that ended minutes ago, and each needs its own answer
 * because the two know different amounts:
 *
 * - A **log-only** name never claimed to be a step and has no verdict of its
 *   own. Once the run is over it is not in progress, so it resolves to `done` —
 *   or to `failed` where one of its own lines carried a reason, which is the
 *   same rule {@link stepStatusOf} applies to a status event. Taking the run's
 *   verdict instead would paint `dispatch` red on a build that failed three
 *   steps later, which is a claim about dispatch that nothing recorded.
 * - A name whose **last status event said `RUNNING`** is a real step the runner
 *   started and never closed out — a killed job, a lost final event. That one
 *   *was* in progress when the run ended, so the run's verdict is honestly its
 *   own: it is where the build stopped.
 */
function checkpointsOf(
  events: readonly AttemptEvent[],
  runStatus: StepStatus,
): ChecklistItem[] {
  interface Checkpoint {
    status: StepStatus;
    /** No status event has ever named this checkpoint. */
    logOnly: boolean;
    /** A line under this name carried a failure reason. */
    errored: boolean;
    from: Date;
    to: Date | null;
    line: string | null;
  }
  const seen = new Map<string, Checkpoint>();
  // `waiting` and `running` are the two non-terminal answers `buildStepStatus`
  // gives; anything else means the runner is done talking about this build.
  const finished = runStatus !== 'running' && runStatus !== 'waiting';

  for (const event of events) {
    const name = event.resource;
    if (!name) continue;
    const isLog = event.eventType === 'log';
    const prior = seen.get(name);

    if (!prior) {
      seen.set(name, {
        status: isLog
          ? 'running'
          : stepStatusOf(event.phase, event.reason !== null),
        logOnly: isLog,
        errored: isLog && event.reason !== null,
        from: event.createdAt,
        to: null,
        line: isLog ? event.line : null,
      });
      continue;
    }

    if (isLog) {
      if (event.line) prior.line = event.line;
      if (event.reason !== null) prior.errored = true;
      continue;
    }
    prior.logOnly = false;
    prior.status = stepStatusOf(event.phase, event.reason !== null);
    prior.to = prior.status === 'running' ? null : event.createdAt;
  }

  return Array.from(seen, ([name, checkpoint]) => ({
    name,
    status: resolvedStatus(checkpoint, runStatus, finished),
    ...detailOf(checkpoint),
  }));
}

/** One checkpoint's status, with a finished run's claim on it applied. */
function resolvedStatus(
  checkpoint: { status: StepStatus; logOnly: boolean; errored: boolean },
  runStatus: StepStatus,
  finished: boolean,
): StepStatus {
  if (!finished || checkpoint.status !== 'running') return checkpoint.status;
  return checkpoint.logOnly
    ? checkpoint.errored
      ? 'failed'
      : 'done'
    : runStatus;
}

function detailOf(checkpoint: {
  from: Date;
  to: Date | null;
  line: string | null;
}): { detail?: string } {
  if (checkpoint.to !== null) {
    const seconds = Math.max(
      0,
      (checkpoint.to.getTime() - checkpoint.from.getTime()) / 1000,
    );
    return { detail: `${seconds.toFixed(1)}s` };
  }
  // Cut rather than wrapped: the detail sits at the end of a one-line row (§18
  // — "per-resource detail is one line, no tree"), and a paragraph there would
  // push the step name it belongs to off the screen.
  if (checkpoint.line !== null) {
    return {
      detail:
        checkpoint.line.length > 64
          ? `${checkpoint.line.slice(0, 63)}…`
          : checkpoint.line,
    };
  }
  return {};
}

/**
 * How long the build has been going, or went.
 *
 * The last event is the end marker because no column records one: `builds` has
 * `createdAt` and a status, and the runner's final line is the closest thing to
 * a finish time that is actually written down. A build still in flight is
 * measured against the clock instead, so the number moves while it runs.
 */
function durationOf(
  context: CommandContext,
  build: Build,
  events: readonly AttemptEvent[],
): string | undefined {
  const running = build.status === 'RUNNING';
  const last = events.at(-1);
  if (!(running || last)) return undefined;

  const end = running ? context.clock.now() : last!.createdAt;
  const seconds = Math.max(
    0,
    Math.round((end.getTime() - build.createdAt.getTime()) / 1000),
  );
  return `${seconds}s`;
}
