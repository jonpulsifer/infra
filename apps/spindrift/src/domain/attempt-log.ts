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
import { and, asc, eq, gt, or } from 'drizzle-orm';
import {
  type Blame,
  blameFor,
  type FailureReason,
} from '../adapters/deploy/contract.ts';
import type { Database } from '../db/client.ts';
import { notifyAttemptEvent } from '../db/notify.ts';
import { attemptEvents } from '../db/schema.ts';

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
  const { event } = args;
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
