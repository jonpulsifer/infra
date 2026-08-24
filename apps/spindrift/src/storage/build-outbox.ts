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
 *
 * **A lease says when; the claimant says whose** (ticket 129). "Nothing else
 * claimed the row in between" is the whole of that argument, and keying on the
 * request id alone could not check it: a host whose lease expired could extend,
 * or land a result on, a request another host was already running. `claim`
 * mints a claimant, hands it back in the response, and `heartbeat` and
 * `complete` require it — the same fencing token `builds.dispatch_id` is one
 * seam further in.
 *
 * `complete` is deliberately the weaker of the two: it accepts a result from a
 * claimant the row no longer names *if it names nobody*, because that is the
 * "nothing else claimed it in between" case above. What it refuses is a result
 * for a request some other host is running right now.
 *
 * **A caller that sends no claimant is still served.** Bosun ships as a NixOS
 * module on each host's own auto-upgrade while Spindrift ships as a pinned
 * image digest, so the Go half can reach production first and its claims come
 * back carrying nothing. An absent claimant — undefined, or the empty string a
 * missing JSON field decodes to — reads as "did not ask to be fenced" and gets
 * exactly today's predicate, never as a mismatch that would 404 every heartbeat
 * on a host mid-build.
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

/** How long a claim holds before it is eligible for reclamation. */
export const BUILD_REQUEST_LEASE_MS = 5 * 60_000;

/** What one class's queue looks like right now — the pool-health read. */
export interface OutboxClassStats {
  readonly pending: number;
  readonly claimed: number;
  /** The oldest still-`PENDING` row's `createdAt`, or `null` with none waiting. */
  readonly oldestPendingAt: Date | null;
}

/** What a claim hands the poller: enough to run the build, nothing more. */
export interface ClaimedBuildRequest {
  readonly id: string;
  readonly class: string;
  /** The request document exactly as `enqueue` stored it. */
  readonly request: unknown;
  /** This claim's fencing token, to be handed back on every later call. */
  readonly claimant: string;
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
  /**
   * Write one intent, `PENDING` until a bosun host claims it.
   *
   * `id` lets the caller name the row — the bosun route passes its dispatch
   * id, so a cancel from another process can address the row through the
   * Build alone. The column is a UUID, which every dispatch id is.
   */
  enqueue(input: {
    readonly id?: string;
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
  /**
   * Extend a claim's lease. `false` when the row is not currently claimed, or
   * when `claimant` names a claim the row no longer carries.
   */
  heartbeat(id: string, claimant?: string): Promise<boolean>;
  /** Record a result, unless one already landed or the claim moved on. */
  complete(
    id: string,
    result: BuildRequestResult,
    claimant?: string,
  ): Promise<'done' | 'conflict' | 'missing'>;
  /** The row as it stands, or `null` when no such request exists. */
  get(id: string): Promise<BuildRequest | null>;
  /**
   * Pending/claimed depth and the oldest still-waiting row, per class.
   *
   * The whole of what distinguishes "declared but nothing is polling" from
   * "serving" from inside Spindrift — every class not present in `classes`
   * answers zeroed rather than omitted, so a caller mapping one route per
   * class never has to guess at a missing key.
   */
  stats(classes: readonly string[]): Promise<Record<string, OutboxClassStats>>;
  /**
   * Mark a row `DONE` with no result — the adapter's move when it gives up on
   * a request, so a dead request can never be claimed later. A no-op against
   * a row that already carries a real result: that result beats the give-up.
   */
  cancel(id: string): Promise<void>;
}

/**
 * Whether a caller named a claim at all.
 *
 * Empty string and `undefined` both mean *absent*: a claim response that
 * carried no claimant decodes to `''` on the Go side, and reading that as a
 * mismatch would refuse every call from a bosun host that reached production
 * before this did.
 */
function unfenced(claimant: string | undefined): claimant is undefined | '' {
  return claimant === undefined || claimant === '';
}

/**
 * "Still mine", as a conjunct or as nothing at all.
 *
 * Spread into a predicate rather than branched around one, so the fenced and
 * the unfenced call are the same statement with one term more.
 */
function heldBy(claimant: string | undefined) {
  return unfenced(claimant) ? [] : [eq(buildRequests.claimant, claimant)];
}

/**
 * "Mine, or nobody's" — what a *result* has to satisfy.
 *
 * Weaker than {@link heldBy} on purpose, and the module header says why: a
 * result from a claimant whose lease expired still lands as long as nothing
 * else claimed the row in between, because a real result beats a rerun.
 * `reclaimExpired` clears the claimant with the lease, so a null one is
 * precisely "in between" — while a claimant that is somebody else's is the
 * case this fence exists to refuse.
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

/** The outbox an installation with a database has. */
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
        // The claimant goes with the lease it named: a row back in the queue is
        // held by nobody, and leaving the previous holder on it would let that
        // host's next heartbeat pass the fence.
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
