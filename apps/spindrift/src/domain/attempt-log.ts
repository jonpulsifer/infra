/**
 * The attempt event log (§6, Task 11).
 *
 * "One attempt-scoped event log keyed by (App, Component, attempt), carrying
 * log lines and status events `{phase, resource?, reason?, blame?}`. Build
 * and Deploy both write to it; the UI subscribes once." (§6)
 *
 * `src/db/schema.ts` already carries the `attemptEvents` table this module
 * writes and reads — one row is either a build-attempt event or a
 * deploy-attempt event (a CHECK enforces exactly one of `buildId`/`deployId`),
 * reusing `deployReason`/`blame` so a reason means the same thing on either
 * side (§6: "one shared vocabulary"). This module is the domain code over
 * that table; it adds no column, because the table already carries
 * everything this task needs.
 *
 * **A running app's stdout never reaches this log** (§6: "it is unbounded and
 * would mean the attempt never ends"; §17 is the second pipe that carries
 * it). That is structural here, not a convention: every write goes through
 * {@link recordBuildEvent} or {@link recordDeployEvent}, and both require an
 * attempt reference — a `buildId` or a `deployId` that already exists as a
 * row. A live app has neither; it is placed on a Target, not attempted. There
 * is no third write function and no variant that accepts a bare
 * component/target pair, so there is no call shape a runtime-log tailer could
 * use to reach this table even by mistake.
 *
 * **Ordering.** `attemptEvents.id` is a `bigserial` — one sequence, one
 * table, so every row gets a distinct, strictly increasing value. Reads order
 * on `id`, never on `createdAt`: two events can legitimately share a
 * millisecond (a status event and the log line that explains it, written back
 * to back), and a timestamp column cannot break that tie in insertion order.
 * `id` can. Each write here is one `INSERT ... RETURNING`, never batched
 * inside a longer-lived transaction, so a row's sequence value is assigned
 * and committed together — there is no open transaction holding a low `id`
 * back while a later write with a higher `id` commits first. That is what
 * lets `ORDER BY id` stand in for "the order they happened" for this table.
 */
import { and, asc, count, eq, gt, or, type SQL } from 'drizzle-orm';
import {
  type Blame,
  blameFor,
  type FailureReason,
} from '../adapters/deploy/contract.ts';
import type { Database } from '../db/client.ts';
import { notifyAttemptEvent } from '../db/notify.ts';
import { attemptEvents, builds } from '../db/schema.ts';

/**
 * How many log lines one attempt keeps.
 *
 * §12 keeps every row and every build line is a row, so a verbose `npm` or
 * `buildctl` run is tens of thousands of them on the one Postgres the estate
 * runs on — and `buildViewOf` reads all of an attempt's rows to draw its
 * checklist. Past this many, a log line is not written; exactly one final line
 * says so and points at the runner — by the `runUrl` the Build row carries
 * where the route reported one, so the exported text log needs no screen to
 * follow it. Status events are never dropped: the verdict, and the terminal
 * phase the stream pump ends a page on, land after the ceiling as before.
 */
export const MAX_ATTEMPT_LOG_LINES = 20_000;

/**
 * Log lines written per attempt, as this process has counted them.
 *
 * Seeded from the table the first time an attempt is written to here, then
 * kept in memory so the ceiling costs one count per attempt rather than one
 * per line. Keyed by connection because the test harness pins each test's
 * `Database` to its own schema, where a build id repeats; production has one.
 * A writer resurrected in another process seeds from the rows the first one
 * left, so the ceiling holds across a restart and a marker already on the leg
 * is counted — none is written after it.
 *
 * The count is per process, and the build fence does not keep it honest: the
 * fence (`mine` in `dispatch.ts`) covers the Build row's verdict, not the
 * lines streamed before it. Exactly one marker rests on one reconciler
 * dispatching a Build — `reconciler.replicas: 1` in the chart, which
 * `clusters/offsite/apps/spindrift/helm-release.yaml` keeps — since two
 * dispatchers on one attempt would each count and each write one. A line
 * another process appends under the ceiling, such as a cancel from the web
 * process, is outside this count, so the kept lines can run a line or two
 * past it.
 */
const lineCounts = new WeakMap<Database, Map<string, number>>();
// ponytail: bounded by dropping the oldest attempt; a dropped one re-seeds
// with one count on its next line.
const COUNTED_ATTEMPTS = 512;

async function logLinesWritten(
  db: Database,
  key: string,
  leg: SQL,
): Promise<number> {
  const known = lineCounts.get(db)?.get(key);
  if (known !== undefined) return known;
  const [row] = await db
    .select({ lines: count() })
    .from(attemptEvents)
    .where(and(eq(attemptEvents.eventType, 'log'), leg));
  return row?.lines ?? 0;
}

async function runUrlOf(db: Database, buildId: number): Promise<string | null> {
  const [row] = await db
    .select({ runUrl: builds.runUrl })
    .from(builds)
    .where(eq(builds.id, buildId));
  return row?.runUrl ?? null;
}

function rememberLines(db: Database, key: string, lines: number): void {
  let counts = lineCounts.get(db);
  if (counts === undefined) {
    counts = new Map();
    lineCounts.set(db, counts);
  }
  counts.delete(key);
  counts.set(key, lines);
  if (counts.size > COUNTED_ATTEMPTS) {
    const oldest = counts.keys().next().value;
    if (oldest !== undefined) counts.delete(oldest);
  }
}

/** The cursor a resumed read starts after — an `attemptEvents.id` value. */
export type AttemptLogCursor = number;

/**
 * What a caller writes. Deliberately narrower than either adapter's own event
 * union — `DeployEvent` carries a `DeployPhase`, `BuildEvent` carries a
 * `step`/`state` pair — because the table's `phase` column is free text on
 * purpose (schema.ts: "Build and Deploy phases differ"). Both adapters'
 * events reduce to this shape at the write call site.
 *
 * `blame` is never a field here: §6 says an adapter "reports a reason and
 * never a blame... blame is derived... so two adapters cannot disagree about
 * who a failure indicts." This type makes that the only option, not merely
 * the documented one.
 */
export type AttemptLogEvent =
  | {
      readonly type: 'log';
      readonly line: string;
      /** Which resource produced the line, where the backend says (§6). */
      readonly resource?: string;
    }
  | {
      readonly type: 'status';
      /** Free text: a Build step name or a `DeployPhase` value. */
      readonly phase: string;
      readonly resource?: string;
      /** Present only on a failure; `blame` is derived from this, not taken. */
      readonly reason?: FailureReason;
    };

/** Identifies the App/Component a write belongs to (denormalized on the row). */
interface AttemptScope {
  readonly appId: string;
  readonly componentId: string;
}

/** A build attempt to write to: the Build row must already exist. */
export interface BuildAttemptRef extends AttemptScope {
  readonly buildId: number;
}

/** A deploy attempt to write to: the Deploy row must already exist. */
export interface DeployAttemptRef extends AttemptScope {
  readonly deployId: number;
}

/**
 * Identifies one attempt's *read* stream: the Build that fed it and, once a
 * Deploy exists for it, the Deploy too. §6's acceptance shape — "a build
 * failure and a deploy failure land on one ordered stream for the same
 * attempt" — is exactly this union: a Deploy is an intent over a Build
 * (schema.ts, `deploys.buildId`), and the attempt a developer watches spans
 * both. `deployId` is omitted while only the build leg has happened yet.
 */
export interface AttemptStreamRef {
  readonly componentId: string;
  readonly buildId: number;
  readonly deployId?: number;
}

/** One row of the merged stream, as the UI would render it. */
export type AttemptLogEntry = {
  readonly cursor: AttemptLogCursor;
  readonly at: Date;
  readonly attemptKind: 'build' | 'deploy';
} & (
  | {
      readonly type: 'log';
      readonly line: string;
      readonly resource: string | null;
    }
  | {
      readonly type: 'status';
      readonly phase: string;
      readonly resource: string | null;
      readonly reason: FailureReason | null;
      readonly blame: Blame | null;
    }
);

/** Options for {@link readAttemptStream}. */
export interface ReadAttemptStreamOptions {
  /** Resume after this cursor rather than reading from the start (§17). */
  readonly after?: AttemptLogCursor;
  /** Caps how many rows come back in one read. */
  readonly limit?: number;
}

/** What {@link readAttemptStream} returns. */
export interface AttemptStreamPage {
  readonly entries: readonly AttemptLogEntry[];
  /**
   * Where the next read should resume from. Unchanged from `after` when this
   * page is empty, so a caller can always pass `cursor` straight back in
   * without special-casing "nothing new yet".
   */
  readonly cursor: AttemptLogCursor | null;
}

const DEFAULT_LIMIT = 500;

/** Append one event to a build attempt's leg of the log. */
export async function recordBuildEvent(
  db: Database,
  ref: BuildAttemptRef,
  event: AttemptLogEvent,
): Promise<void> {
  await insertEvent(db, {
    appId: ref.appId,
    componentId: ref.componentId,
    attemptKind: 'build',
    buildId: ref.buildId,
    deployId: null,
    event,
  });
}

/** Append one event to a deploy attempt's leg of the log. */
export async function recordDeployEvent(
  db: Database,
  ref: DeployAttemptRef,
  event: AttemptLogEvent,
): Promise<void> {
  await insertEvent(db, {
    appId: ref.appId,
    componentId: ref.componentId,
    attemptKind: 'deploy',
    buildId: null,
    deployId: ref.deployId,
    event,
  });
}

async function insertEvent(
  db: Database,
  args: {
    appId: string;
    componentId: string;
    attemptKind: 'build' | 'deploy';
    buildId: number | null;
    deployId: number | null;
    event: AttemptLogEvent;
  },
): Promise<void> {
  let { event } = args;
  let lines: number | null = null;
  let key = '';
  if (event.type === 'log') {
    const attemptId = (
      args.attemptKind === 'build' ? args.buildId : args.deployId
    ) as number;
    key = `${args.attemptKind}:${attemptId}`;
    lines = await logLinesWritten(
      db,
      key,
      args.attemptKind === 'build'
        ? eq(attemptEvents.buildId, attemptId)
        : eq(attemptEvents.deployId, attemptId),
    );
    // Over the ceiling: the marker is already the last line, and nothing after
    // it is written. Only a status event reaches the table from here on.
    if (lines > MAX_ATTEMPT_LOG_LINES) return;
    if (lines === MAX_ATTEMPT_LOG_LINES) {
      // Read off the row here rather than carried on every write: the URL is
      // needed once per attempt, and only a build leg can have one.
      const runUrl =
        args.buildId === null ? null : await runUrlOf(db, args.buildId);
      event = {
        type: 'log',
        line: `output truncated after ${MAX_ATTEMPT_LOG_LINES} lines; the runner keeps the rest${runUrl === null ? '' : ` at ${runUrl}`}`,
      };
    }
  }
  // §6: blame is derived here, from the shared BLAME table — never accepted
  // as a caller-supplied field (see AttemptLogEvent's doc comment).
  const reason = event.type === 'status' ? (event.reason ?? null) : null;
  await db.insert(attemptEvents).values({
    appId: args.appId,
    componentId: args.componentId,
    attemptKind: args.attemptKind,
    buildId: args.buildId,
    deployId: args.deployId,
    eventType: event.type,
    line: event.type === 'log' ? event.line : null,
    phase: event.type === 'status' ? event.phase : null,
    resource: event.resource ?? null,
    reason: reason ?? null,
    blame: reason ? blameFor(reason) : null,
  });
  // Counted after the row is in: a failed insert is not a line written.
  if (lines !== null) rememberLines(db, key, lines + 1);

  // Wake any WebSocket pump loops watching this component (Transport shape).
  // Fire-and-forget: a lost notification only delays the next poll.
  notifyAttemptEvent(args.componentId);
}

/**
 * Read one attempt's merged stream, ordered from the beginning or resumed
 * after a prior cursor (§17: "a resume cursor and bounded buffering" is what
 * the browser stream needs from whatever it reads).
 */
export async function readAttemptStream(
  db: Database,
  ref: AttemptStreamRef,
  options: ReadAttemptStreamOptions = {},
): Promise<AttemptStreamPage> {
  const legs = [
    and(
      eq(attemptEvents.attemptKind, 'build'),
      eq(attemptEvents.buildId, ref.buildId),
    ),
    ref.deployId === undefined
      ? undefined
      : and(
          eq(attemptEvents.attemptKind, 'deploy'),
          eq(attemptEvents.deployId, ref.deployId),
        ),
  ];

  const rows = await db
    .select()
    .from(attemptEvents)
    .where(
      and(
        eq(attemptEvents.componentId, ref.componentId),
        or(...legs),
        options.after === undefined
          ? undefined
          : gt(attemptEvents.id, options.after),
      ),
    )
    .orderBy(asc(attemptEvents.id))
    .limit(options.limit ?? DEFAULT_LIMIT);

  const entries: AttemptLogEntry[] = rows.map((row) => {
    const base = {
      cursor: row.id,
      at: row.createdAt,
      attemptKind: row.attemptKind,
    };
    if (row.eventType === 'log') {
      return {
        ...base,
        type: 'log' as const,
        line: row.line ?? '',
        resource: row.resource,
      };
    }
    return {
      ...base,
      type: 'status' as const,
      phase: row.phase ?? '',
      resource: row.resource,
      reason: row.reason,
      blame: row.blame,
    };
  });

  const cursor =
    entries.length > 0
      ? entries[entries.length - 1]!.cursor
      : (options.after ?? null);

  return { entries, cursor };
}
