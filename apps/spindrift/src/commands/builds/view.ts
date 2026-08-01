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

  const steps: ChecklistItem[] = events
    .filter((event) => event.resource)
    .map((event) => ({
      name: event.resource!,
      status: event.reason ? ('failed' as const) : ('done' as const),
      detail: event.line ?? undefined,
    }));

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
      log: log.length > 0 ? log : null,
      runner: build.runner ?? 'hosted runner',
      runUrl: build.runUrl ?? null,
    },
    events,
  };
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
