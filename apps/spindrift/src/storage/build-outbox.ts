/**
 * The bosun build route's outbox.
 *
 * Every other build route is dialed: core reaches a Job's API, a workflow
 * dispatch, a cloud build submission. Bosun is the opposite shape — a warm-pool
 * microVM daemon on a host this process cannot reach, which **long-polls in**
 * over three shared-secret-authed endpoints (`src/web/bosun-route.ts`) instead
 * of being called. An outbox row is what makes that direction workable: the
 * `bosun.ts` adapter writes an intent with {@link BuildOutbox.enqueue}, a
 * bosun host claims it, and the same row carries the result back.
 *
 * **The claim is the one place this module has to be exactly right.** Two
 * bosun hosts polling the same class must never claim the same row — that is
 * a build run twice for one Build — so `claim` is `SELECT ... FOR UPDATE SKIP
 * LOCKED` inside a transaction, the identical mechanism
 * `src/reconciler/deploy-loop.ts`'s `claimNextDeploy` already proves against
 * real Postgres. § Testing: "the concurrency design is a claim about
 * transactions and a fake store cannot falsify it" — this module has no fake,
 * on purpose; `test/storage/build-outbox.test.ts` runs it against real
 * Postgres or not at all.
 *
 * **A lease, not a session.** A claimed row expires after
 * {@link BUILD_REQUEST_LEASE_MS} unless the claimant heartbeats it, mirroring
 * `builds.leased_at`'s precedent for a dispatch that stops reporting.
 * `reclaimExpired` is the reclamation half; nothing calls it but the claim
 * route, right before it looks for something new to hand out.
 *
 * **A result lands once it is state-consistent to land, not once it is
 * first.** `complete` writes only where the row is not already `DONE` — a
 * result from a claimant whose lease already expired still lands if nothing
 * else claimed the row in between, because a real result beats a rerun. The
 * guard is one `UPDATE ... WHERE state != 'DONE'`, which is what makes two
 * concurrent completions of the same id resolve to exactly one `'done'` and
 * one `'conflict'` rather than both believing they won.
 */
import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { type BuildRequest, buildRequests } from '../db/schema.ts';

/** How long a claim holds before it is eligible for reclamation. */
export const BUILD_REQUEST_LEASE_MS = 5 * 60_000;

/** What a claim hands the poller: enough to run the build, nothing more. */
export interface ClaimedBuildRequest {
  readonly id: string;
  readonly class: string;
  /** The request document exactly as `enqueue` stored it. */
  readonly request: unknown;
}

/** What a finished attempt reports back. */
export interface BuildRequestResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly log: string;
  readonly detail?: string;
}

/**
 * The far side of the outbox table.
 *
 * Shaped like `RegistryCredentialStore`: a factory over `Database` and a
 * clock, closures for verbs, nothing above this seam touches `buildRequests`
 * directly.
 */
export interface BuildOutbox {
  /** Write one intent, `PENDING` until a bosun host claims it. */
  enqueue(input: {
    readonly class: string;
    readonly request: unknown;
  }): Promise<{ readonly id: string }>;
  /**
   * The oldest `PENDING` row whose class is in the list, claimed and leased —
   * one attempt, race-safe under concurrent callers. `null` when nothing is
   * claimable right now; the long-poll loop that retries lives in the route,
   * not here.
   */
  claim(classes: readonly string[]): Promise<ClaimedBuildRequest | null>;
  /** Return every lease-expired `CLAIMED` row to `PENDING`. */
  reclaimExpired(): Promise<void>;
  /** Extend a claim's lease. `false` when the row is not currently claimed. */
  heartbeat(id: string): Promise<boolean>;
  /** Record a result, unless one already landed. */
  complete(
    id: string,
    result: BuildRequestResult,
  ): Promise<'done' | 'conflict' | 'missing'>;
  /** The row as it stands, or `null` when no such request exists. */
  get(id: string): Promise<BuildRequest | null>;
  /**
   * Mark a row `DONE` with no result — the adapter's move when it gives up on
   * a request, so a dead request can never be claimed later. A no-op against
   * a row that already carries a real result: that result beats the give-up.
   */
  cancel(id: string): Promise<void>;
}

/** The outbox an installation with a database has. */
export function buildOutbox(
  db: Database,
  now: () => Date = () => new Date(),
): BuildOutbox {
  return {
    async enqueue({ class: requestClass, request }) {
      const [row] = await db
        .insert(buildRequests)
        .values({ class: requestClass, request })
        .returning({ id: buildRequests.id });
      return { id: row!.id };
    },

    async claim(classes) {
      if (classes.length === 0) return null;
      const claimedAt = now();

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
          .for('update', { skipLocked: true });
        if (row === undefined) return null;

        await tx
          .update(buildRequests)
          .set({
            state: 'CLAIMED',
            leaseExpires: new Date(
              claimedAt.getTime() + BUILD_REQUEST_LEASE_MS,
            ),
            updatedAt: claimedAt,
          })
          .where(eq(buildRequests.id, row.id));

        return row;
      });
    },

    async reclaimExpired() {
      await db
        .update(buildRequests)
        .set({ state: 'PENDING', leaseExpires: null, updatedAt: now() })
        .where(
          and(
            eq(buildRequests.state, 'CLAIMED'),
            lt(buildRequests.leaseExpires, now()),
          ),
        );
    },

    async heartbeat(id) {
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
          and(eq(buildRequests.id, id), eq(buildRequests.state, 'CLAIMED')),
        )
        .returning({ id: buildRequests.id });
      return rows.length > 0;
    },

    async complete(id, result) {
      const completedAt = now();
      const done = await db
        .update(buildRequests)
        .set({
          state: 'DONE',
          result,
          leaseExpires: null,
          updatedAt: completedAt,
        })
        .where(and(eq(buildRequests.id, id), ne(buildRequests.state, 'DONE')))
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

    async cancel(id) {
      await db
        .update(buildRequests)
        .set({
          state: 'DONE',
          result: null,
          leaseExpires: null,
          updatedAt: now(),
        })
        .where(and(eq(buildRequests.id, id), ne(buildRequests.state, 'DONE')));
    },
  };
}
