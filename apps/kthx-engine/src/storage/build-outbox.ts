/**
 * The bosun build route's outbox. The adapter enqueues a row, a bosun host
 * long-polls in to claim it under a lease and a claimant token, and posts the
 * result back on the same row. Tested against real Postgres only.
 */
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lt,
  min,
  ne,
  or,
} from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { type BuildRequest, buildRequests } from '../db/schema.ts';

/** How long a claim holds without a heartbeat before it can be reclaimed. */
export const BUILD_REQUEST_LEASE_MS = 5 * 60_000;

export interface OutboxClassStats {
  readonly pending: number;
  readonly claimed: number;
  /** `null` when nothing is waiting. */
  readonly oldestPendingAt: Date | null;
}

export interface ClaimedBuildRequest {
  readonly id: string;
  readonly class: string;
  readonly request: unknown;
  /** Fencing token that `heartbeat` and `complete` must send back. */
  readonly claimant: string;
}

export interface BuildRequestResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly log: string;
  readonly detail?: string;
}

export interface BuildOutbox {
  /**
   * `id` must be a UUID. The bosun route passes its dispatch id, so a cancel
   * can find the row from the Build.
   */
  enqueue(input: {
    readonly id?: string;
    readonly class: string;
    readonly request: unknown;
  }): Promise<{ readonly id: string }>;
  /** `null` when nothing is claimable. The route owns the retry loop. */
  claim(classes: readonly string[]): Promise<ClaimedBuildRequest | null>;
  reclaimExpired(): Promise<void>;
  /** `false` when the row is not claimed, or another claimant holds it. */
  heartbeat(id: string, claimant?: string): Promise<boolean>;
  /** `conflict`: a result was recorded first or another claimant holds it. */
  complete(
    id: string,
    result: BuildRequestResult,
    claimant?: string,
  ): Promise<'done' | 'conflict' | 'missing'>;
  get(id: string): Promise<BuildRequest | null>;
  /** Every class asked for gets an entry, zeroed when it has no rows. */
  stats(classes: readonly string[]): Promise<Record<string, OutboxClassStats>>;
  /**
   * Marks the row `DONE` with no result so it is never claimed. A row already
   * `DONE` is left as it is.
   */
  cancel(id: string): Promise<void>;
}

/**
 * `''` and `undefined` both mean no claimant: Go sends `''` after a claim that
 * carried none, and reading it as a mismatch would refuse that host outright.
 */
function unfenced(claimant: string | undefined): claimant is undefined | '' {
  return claimant === undefined || claimant === '';
}

function heldBy(claimant: string | undefined) {
  return unfenced(claimant) ? [] : [eq(buildRequests.claimant, claimant)];
}

/**
 * Weaker than {@link heldBy}: a result whose lease expired is still written if
 * no other host has claimed the row since, because a real result beats a rerun.
 */
function heldByOrNobody(claimant: string | undefined) {
  return unfenced(claimant)
    ? []
    : [
        or(
          isNull(buildRequests.claimant),
          eq(buildRequests.claimant, claimant),
        ),
      ];
}

export function buildOutbox(
  db: Database,
  now: () => Date = () => new Date(),
): BuildOutbox {
  return {
    async enqueue({ id, class: requestClass, request }) {
      const [row] = await db
        .insert(buildRequests)
        .values({
          ...(id === undefined ? {} : { id }),
          class: requestClass,
          request,
        })
        .returning({ id: buildRequests.id });
      return { id: row!.id };
    },

    async claim(classes) {
      if (classes.length === 0) return null;
      const claimedAt = now();
      const claimant = crypto.randomUUID();

      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: buildRequests.id,
            class: buildRequests.class,
            request: buildRequests.request,
          })
          .from(buildRequests)
          .where(
            and(
              eq(buildRequests.state, 'PENDING'),
              inArray(buildRequests.class, [...classes]),
            ),
          )
          .orderBy(asc(buildRequests.createdAt))
          .limit(1)
          // Two hosts polling one class must never claim the same row.
          .for('update', { skipLocked: true });
        if (row === undefined) return null;

        await tx
          .update(buildRequests)
          .set({
            state: 'CLAIMED',
            claimant,
            leaseExpires: new Date(
              claimedAt.getTime() + BUILD_REQUEST_LEASE_MS,
            ),
            updatedAt: claimedAt,
          })
          .where(eq(buildRequests.id, row.id));

        return { ...row, claimant };
      });
    },

    async reclaimExpired() {
      await db
        .update(buildRequests)
        // Clear the claimant, or the old holder's heartbeat passes the fence.
        .set({
          state: 'PENDING',
          claimant: null,
          leaseExpires: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(buildRequests.state, 'CLAIMED'),
            lt(buildRequests.leaseExpires, now()),
          ),
        );
    },

    async heartbeat(id, claimant) {
      const heartbeatAt = now();
      const rows = await db
        .update(buildRequests)
        .set({
          leaseExpires: new Date(
            heartbeatAt.getTime() + BUILD_REQUEST_LEASE_MS,
          ),
          updatedAt: heartbeatAt,
        })
        .where(
          and(
            eq(buildRequests.id, id),
            eq(buildRequests.state, 'CLAIMED'),
            ...heldBy(claimant),
          ),
        )
        .returning({ id: buildRequests.id });
      return rows.length > 0;
    },

    async complete(id, result, claimant) {
      const completedAt = now();
      const done = await db
        .update(buildRequests)
        .set({
          state: 'DONE',
          result,
          leaseExpires: null,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(buildRequests.id, id),
            // Two racing completions: one gets `done`, the other `conflict`.
            ne(buildRequests.state, 'DONE'),
            ...heldByOrNobody(claimant),
          ),
        )
        .returning({ id: buildRequests.id });
      if (done.length > 0) return 'done';

      const [existing] = await db
        .select({ id: buildRequests.id })
        .from(buildRequests)
        .where(eq(buildRequests.id, id));
      return existing === undefined ? 'missing' : 'conflict';
    },

    async get(id) {
      const [row] = await db
        .select()
        .from(buildRequests)
        .where(eq(buildRequests.id, id));
      return row ?? null;
    },

    async stats(classes) {
      const empty: OutboxClassStats = {
        pending: 0,
        claimed: 0,
        oldestPendingAt: null,
      };
      const byClass: Record<string, OutboxClassStats> = Object.fromEntries(
        classes.map((requestClass) => [requestClass, empty]),
      );
      if (classes.length === 0) return byClass;

      const rows = await db
        .select({
          class: buildRequests.class,
          state: buildRequests.state,
          count: count(),
          oldestPendingAt: min(buildRequests.createdAt),
        })
        .from(buildRequests)
        .where(
          and(
            inArray(buildRequests.class, [...classes]),
            ne(buildRequests.state, 'DONE'),
          ),
        )
        .groupBy(buildRequests.class, buildRequests.state);

      for (const row of rows) {
        const current = byClass[row.class] ?? empty;
        byClass[row.class] =
          row.state === 'PENDING'
            ? {
                ...current,
                pending: row.count,
                oldestPendingAt: row.oldestPendingAt,
              }
            : { ...current, claimed: row.count };
      }
      return byClass;
    },

    async cancel(id) {
      await db
        .update(buildRequests)
        .set({
          state: 'DONE',
          result: null,
          claimant: null,
          leaseExpires: null,
          updatedAt: now(),
        })
        .where(and(eq(buildRequests.id, id), ne(buildRequests.state, 'DONE')));
    },
  };
}
