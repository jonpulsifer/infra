/**
 * The attempt event log: log lines and status events for one Build or Deploy
 * attempt. Every write names an existing attempt row, so a running app's stdout
 * cannot reach it.
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
 * Every line is a row, so past this many one final line points at the runner
 * and the rest are dropped. Status events are always written.
 */
export const MAX_ATTEMPT_LOG_LINES = 20_000;

/**
 * Exact only while one reconciler dispatches, since each process counts alone.
 * Keyed by Database because each test schema reuses build ids.
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

/** An `attemptEvents.id`; a resumed read starts after it. */
export type AttemptLogCursor = number;

/** Carries no `blame`: it is derived from `reason`, so adapters cannot disagree on it. */
export type AttemptLogEvent =
  | {
      readonly type: 'log';
      readonly line: string;
      readonly resource?: string;
    }
  | {
      readonly type: 'status';
      /** Free text: a Build step name or a `DeployPhase` value. */
      readonly phase: string;
      readonly resource?: string;
      /** Set only on a failure. */
      readonly reason?: FailureReason;
    };

interface AttemptScope {
  readonly appId: string;
  readonly componentId: string;
}

/** The Build row must already exist. */
export interface BuildAttemptRef extends AttemptScope {
  readonly buildId: number;
}

/** The Deploy row must already exist. */
export interface DeployAttemptRef extends AttemptScope {
  readonly deployId: number;
}

/** One attempt's read stream: its Build, and its Deploy once one exists. */
export interface AttemptStreamRef {
  readonly componentId: string;
  readonly buildId: number;
  readonly deployId?: number;
}

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

export interface ReadAttemptStreamOptions {
  readonly after?: AttemptLogCursor;
  readonly limit?: number;
}

export interface AttemptStreamPage {
  readonly entries: readonly AttemptLogEntry[];
  /** Equals `after` on an empty page, so a caller can always pass it back. */
  readonly cursor: AttemptLogCursor | null;
}

const DEFAULT_LIMIT = 500;

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
    // Past the ceiling the marker is written; only status events follow it.
    if (lines > MAX_ATTEMPT_LOG_LINES) return;
    if (lines === MAX_ATTEMPT_LOG_LINES) {
      const runUrl =
        args.buildId === null ? null : await runUrlOf(db, args.buildId);
      event = {
        type: 'log',
        line: `output truncated after ${MAX_ATTEMPT_LOG_LINES} lines; the runner keeps the rest${runUrl === null ? '' : ` at ${runUrl}`}`,
      };
    }
  }
  const reason = event.type === 'status' ? (event.reason ?? null) : null;
  // One insert per event, never inside a longer transaction, so id order is
  // commit order for readers.
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

  // Fire-and-forget: a lost notification only delays the next poll.
  notifyAttemptEvent(args.componentId);
}

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
    // Never createdAt: two events can share a millisecond.
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
