/**
 * `cancelBuild` — end a Build that is waiting for something that is not coming.
 *
 * The dispatch loop's `waits` arm is deliberately unbounded: a Build refused
 * over a missing route or an unconfigured federation is one an operator can
 * make dispatchable, and failing it would only make them press Deploy again
 * (see {@link refuseDispatch}). What that arm has no answer for is a wait
 * nobody intends to satisfy — a placement that moved on, a route that is never
 * going to be configured — and until this command existed the only ways out of
 * one were deleting the App or leaving the row queued forever. Build 44 sat
 * PENDING for nine days that way.
 *
 * So this is the operator's end of the same decision the loop makes: the
 * sentence on the row says what it is waiting for, and this says that is no
 * longer worth waiting for. `FAILED` and not a status of its own, because
 * every reader — the ledger, the tone, the workspace's next act — already
 * knows what a terminal Build is, and a cancelled one is terminal in exactly
 * the same way. No `reason`: §6's set indicts a developer or the platform, and
 * a cancellation indicts neither. What it carries instead is who did it, on
 * the attempt log where the wait's own sentences are.
 *
 * **A running attempt is not cancellable, and that is not this command's
 * choice.** §4 makes the route's own terminal write what ends an attempt, so
 * nothing here can stop a generator mid-stream — the same fact `deployApp`
 * refuses a rebuild over. What *is* cancellable is a row whose lease has
 * expired: nothing is streaming into it and nothing is coming back for it,
 * which is the same condition that makes it reclaimable. The `WHERE` is the
 * check, not a branch above it, for `deployApp`'s reason: a claim landing
 * between the read and the write would pass an in-memory guard.
 *
 * Cancelling strands nothing. `deployApp` treats a `FAILED` newest Build as a
 * reason to stage a fresh one, so the act after a cancel is Deploy, and the
 * Build it starts derives its shape from the placement of record rather than
 * from the row that was cancelled.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { builds } from '../../db/schema.ts';
import { recordBuildEvent } from '../../domain/attempt-log.ts';
import { type Command, failed, ok } from '../types.ts';
import { DISPATCH_LEASE_TIMEOUT_MS } from './dispatch.ts';

export const cancelBuildInput = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

export type CancelBuildInput = z.infer<typeof cancelBuildInput>;

export interface CancelBuildResult {
  readonly buildId: number;
  /** What the row says now, for a caller that renders the ledger's word. */
  readonly status: 'FAILED';
}

export const cancelBuild: Command<CancelBuildInput, CancelBuildResult> = async (
  input,
  context,
) => {
  const build = await context.db.query.builds.findFirst({
    where: (rows, { eq: eqOp }) => eqOp(rows.id, input.id),
    // The App this Build belongs to is one join away, and an attempt reference
    // is not writable without it.
    with: { component: true },
  });

  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build ${input.id}`);
  }

  if (build.status === 'SUCCEEDED' || build.status === 'FAILED') {
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} has already ${
        build.status === 'SUCCEEDED' ? 'succeeded' : 'failed'
      }, so there is nothing to cancel`,
    );
  }

  const now = context.clock.now();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);
  const cancelled = await context.db
    .update(builds)
    .set({
      status: 'FAILED',
      // The wait is over, so what it was waiting on stops being true — the
      // same clearing `refuseDispatch` makes when it closes a Build out.
      dispatchWaitingOn: null,
      nextDispatchAt: null,
      // Fences out an expired claim that comes back to life: its terminal
      // write is `WHERE dispatch_id = ...` and now matches no row, so it lands
      // on `lostClaim` rather than overwriting this verdict.
      dispatchId: null,
      leasedAt: null,
    })
    .where(
      and(
        eq(builds.id, build.id),
        or(
          eq(builds.status, 'PENDING'),
          and(
            eq(builds.status, 'RUNNING'),
            or(isNull(builds.leasedAt), lt(builds.leasedAt, leaseCutoff)),
          ),
        ),
      ),
    )
    .returning({ id: builds.id });

  if (cancelled.length === 0) {
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} is running: the route that is running it writes the ` +
        'verdict, so there is nothing here that can stop it — wait for it to ' +
        'finish, or for its lease to expire',
    );
  }

  const attempt = {
    appId: build.component.appId,
    componentId: build.componentId,
    buildId: build.id,
  };
  await recordBuildEvent(context.db, attempt, {
    type: 'log',
    line: `cancelled by ${context.principal.displayName}`,
    resource: 'dispatch',
  });
  await recordBuildEvent(context.db, attempt, {
    type: 'status',
    phase: 'FAILED',
  });

  return ok({ buildId: build.id, status: 'FAILED' as const });
};
