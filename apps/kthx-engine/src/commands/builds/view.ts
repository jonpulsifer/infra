/**
 * The source and build halves of an attempt, projected once so the deploy and
 * build screens agree. Every attempt has a source; a supplied artifact has no build.
 */
import type { App, AttemptEvent, Build } from '../../db/schema.ts';
import type { CommandContext } from '../types.ts';
import type {
  BuildView,
  ChecklistItem,
  LogFidelity,
  LogLine,
  SourceView,
  StepStatus,
} from '../views.ts';

export function buildStepStatus(status: Build['status']): StepStatus {
  if (status === 'SUCCEEDED') return 'done';
  if (status === 'FAILED') return 'failed';
  if (status === 'PENDING') return 'waiting';
  return 'running';
}

/**
 * Supplied output has the bundle digest as its artifact digest and no runner. A
 * source archive gets a runner and an artifact digest of its own.
 */
export function isSuppliedArtifact(build: Build): boolean {
  return (
    build.runner === null &&
    build.artifactDigest !== null &&
    build.artifactDigest === build.bundleDigest
  );
}

/** Read off the App's source kind, because the App carries the origin. */
export function sourceViewOf(app: App, build: Build): SourceView {
  const subpath = build.bundleSubpath ?? app.sourceRepoSubpath ?? '.';

  if (app.sourceKind === 'repo') {
    return {
      kind: 'repo',
      repo: app.sourceRepoUrl ?? 'unknown repository',
      // The Build, not the App, says which commit this release delivers.
      commit: build.commit,
      commitMessage: build.commitMessage,
      commitAuthor: build.commitAuthor,
      commitAuthoredAt: build.commitAuthoredAt?.toISOString() ?? null,
      subpath,
    };
  }

  return {
    kind: 'archive',
    // An upload's commit column holds the bundle digest too; `bundleDigest` is
    // the one that means it.
    digest: build.bundleDigest ?? build.commit,
    location: build.bundleLocation,
    subpath,
    extracted: isSuppliedArtifact(build),
  };
}

/** `view` is `null` for a supplied artifact, where no builder ran. */
export async function buildViewOf(
  context: CommandContext,
  build: Build,
): Promise<{ view: BuildView | null; events: readonly AttemptEvent[] }> {
  if (isSuppliedArtifact(build)) {
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
      // A Build with no step events still shows one step, not an empty checklist.
      steps: steps.length > 0 ? steps : [{ name: 'build artifact', status }],
      // Null when no line has arrived, so the screen says so instead of showing
      // an empty pane.
      log: log.length > 0 ? log.slice(-LOG_TAIL) : null,
      logTotal: log.length,
      runner: build.runner ?? 'hosted runner',
      // Resolved against the manifest's route table, which the browser does not have.
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
 * Lines of the runner's transcript the drawer carries. A failure is at the end;
 * the whole log is on `runUrl`, and `logTotal` counts it.
 */
const LOG_TAIL = 60;

function stepStatusOf(phase: string | null, failed: boolean): StepStatus {
  if (failed || phase === 'FAILED') return 'failed';
  if (phase === 'SUCCEEDED') return 'done';
  if (phase === 'RUNNING') return 'running';
  return 'waiting';
}

/**
 * Folds events by name; the latest status event wins. Once the run ends, a
 * log-only name is done unless its own lines failed, and a step left RUNNING
 * takes the run's verdict.
 */
function checkpointsOf(
  events: readonly AttemptEvent[],
  runStatus: StepStatus,
): ChecklistItem[] {
  interface Checkpoint {
    status: StepStatus;
    logOnly: boolean;
    /** A line under this name carried a failure reason. */
    errored: boolean;
    from: Date;
    to: Date | null;
    line: string | null;
  }
  const seen = new Map<string, Checkpoint>();
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
  // Cut, not wrapped: the detail ends a one-line row.
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
 * No column records a finish time, so the last event stands in. A running build
 * is measured against the clock.
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
