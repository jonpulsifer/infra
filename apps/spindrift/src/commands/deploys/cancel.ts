/**
 * `cancelDeploy` — stop an intent that has not landed (§6).
 *
 * A wrong press used to wait behind the in-flight attempt for up to the
 * adapter's whole convergence budget before the correcting intent was even
 * claimed. This is the operator's way out, and it is two different acts under
 * one name, because §6 puts the two halves of a Deploy in two places:
 *
 * - **A `PENDING` intent is a row and nothing else.** Nothing is streaming into
 *   it, so this command fails it here, under the same `FOR UPDATE` on the
 *   Component@Target desired row that `placeIntent` and `claimNextDeploy` take
 *   — a claim cannot land between the read and the write. The intent moved the
 *   desired pointer when it was written, so cancelling it moves the pointer
 *   back to the release before it: `deployApp` reads that pointer to decide a
 *   Build is "already desired", and a cancelled intent left in it would refuse
 *   the very redeploy the operator presses next. A rollback intent also set
 *   the App's lock on the way in (`rollbackDeploy`), with a sentence saying
 *   the rollback happened; cancelled unclaimed, it did not, so the lock goes
 *   back with the pointer.
 *
 * - **An `APPLYING` or `WAITING` attempt is a generator in one reconciler
 *   process**, and only that process can end it. This command stamps the
 *   request and who made it; the attempt reads it at its next event, returns
 *   the stream so the adapter's own `finally` runs, and settles `FAILED` with
 *   "cancelled by …" (`deploy-loop.ts`). The row is still in flight when this
 *   returns, and the screen says a cancel is pending rather than done.
 *
 * `LIVE` and `FAILED` refuse. Cancelling a live release is a rollback with the
 * wrong word on it, and `rollbackDeploy` is one press away. Checked again
 * under the lock: `settle` writes its verdict fenced on the attempt, not under
 * this lock, so an attempt can land between the first read and the second.
 *
 * No `reason`, for the reason `cancelBuild` gives none: §6's set indicts a
 * developer or the platform, and a cancellation indicts neither.
 */
import { and, desc, eq, gte, isNotNull, isNull, lt, not } from 'drizzle-orm';
import { z } from 'zod';
import type { DeployPhase } from '../../adapters/deploy/contract.ts';
import { apps, componentTargetDesired, deploys } from '../../db/schema.ts';
import { recordDeployEvent } from '../../domain/attempt-log.ts';
import { type Command, type CommandResult, failed, ok } from '../types.ts';

export const cancelDeployInput = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

export type CancelDeployInput = z.infer<typeof cancelDeployInput>;

export interface CancelDeployResult {
  readonly deployId: number;
  /**
   * What the row says now. `FAILED` for an intent this command ended itself;
   * the in-flight phase for one the attempt has been asked to end.
   */
  readonly phase: 'FAILED' | 'APPLYING' | 'WAITING';
}

/** The refusal for a Deploy that has already reached a verdict. */
function settled(
  id: number,
  phase: 'LIVE' | 'FAILED',
): CommandResult<CancelDeployResult> {
  return failed(
    'NOT_DEPLOYABLE',
    phase === 'LIVE'
      ? `Deploy ${id} is live: cancelling it would be a rollback, so roll back instead`
      : `Deploy ${id} has already failed, so there is nothing to cancel`,
  );
}

type Outcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'requested'; readonly phase: 'APPLYING' | 'WAITING' }
  | { readonly kind: 'settled'; readonly phase: 'LIVE' | 'FAILED' };

export const cancelDeploy: Command<
  CancelDeployInput,
  CancelDeployResult
> = async (input, context) => {
  const deploy = await context.db.query.deploys.findFirst({
    where: (rows, { eq: eqOp }) => eqOp(rows.id, input.id),
    with: { component: true },
  });

  if (deploy === undefined) {
    return failed('NOT_FOUND', `there is no Deploy ${input.id}`);
  }
  if (deploy.phase === 'LIVE' || deploy.phase === 'FAILED') {
    return settled(deploy.id, deploy.phase);
  }

  const now = context.clock.now();
  const by = context.principal.displayName;

  const outcome = await context.db.transaction(async (tx): Promise<Outcome> => {
    // The lock the claim takes. Held, a reconciler claiming this pair
    // waits here, so the phase read next is the phase written against.
    const [desired] = await tx
      .select()
      .from(componentTargetDesired)
      .where(
        and(
          eq(componentTargetDesired.componentId, deploy.componentId),
          eq(componentTargetDesired.targetId, deploy.targetId),
        ),
      )
      .for('update');

    const [current] = await tx
      .select({ phase: deploys.phase })
      .from(deploys)
      .where(eq(deploys.id, deploy.id));
    const phase: DeployPhase = current?.phase ?? deploy.phase;

    if (phase === 'LIVE' || phase === 'FAILED') {
      return { kind: 'settled', phase };
    }
    if (phase !== 'PENDING') {
      await tx
        .update(deploys)
        .set({ cancelRequestedAt: now, cancelRequestedBy: by })
        .where(eq(deploys.id, deploy.id));
      return { kind: 'requested', phase };
    }

    await tx
      .update(deploys)
      .set({
        phase: 'FAILED',
        detail: `cancelled by ${by}`,
        cancelRequestedAt: now,
        cancelRequestedBy: by,
        updatedAt: now,
      })
      .where(eq(deploys.id, deploy.id));

    // The pointer moves back only if this intent is what it names; an
    // older intent still queued behind a newer one never held it. What it
    // goes back to is the newest earlier Deploy that ever held it — every
    // row except the ones this same branch failed before they were
    // claimed, which is what `attempt_id IS NULL` beside the request says.
    if (desired?.desiredDeployId === deploy.id) {
      const [previous] = await tx
        .select({ id: deploys.id, buildId: deploys.buildId })
        .from(deploys)
        .where(
          and(
            eq(deploys.componentId, deploy.componentId),
            eq(deploys.targetId, deploy.targetId),
            lt(deploys.id, deploy.id),
            not(
              and(
                isNotNull(deploys.cancelRequestedAt),
                isNull(deploys.attemptId),
              )!,
            ),
          ),
        )
        .orderBy(desc(deploys.id))
        .limit(1);
      await tx
        .update(componentTargetDesired)
        .set({
          desiredBuildId: previous?.buildId ?? null,
          desiredDeployId: previous?.id ?? null,
          updatedAt: now,
        })
        .where(eq(componentTargetDesired.id, desired.id));

      // A rollback is an intent naming a Build older than the one it
      // displaced — `rollbackDeploy`'s own admission rule — and it locked the
      // App the moment it was written. The release that was serving is what
      // the pointer just went back to, so a lock written no earlier than this
      // intent describes a rollback that never landed, and goes with it.
      // What this cannot reach: `rollbackDeploy` writes the lock after
      // `placeIntent`'s transaction commits, so a cancel that lands between
      // the two writes clears nothing and the lock arrives afterwards; and an
      // operator's own hold set later than the rollback is indistinguishable
      // from it here and is cleared with it.
      if (previous !== undefined && deploy.buildId < previous.buildId) {
        await tx
          .update(apps)
          .set({
            lockReason: null,
            lockedAt: null,
            lockedBy: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(apps.id, deploy.component.appId),
              gte(apps.lockedAt, deploy.createdAt),
            ),
          );
      }
    }
    return { kind: 'cancelled' };
  });

  if (outcome.kind === 'settled') return settled(deploy.id, outcome.phase);

  const attempt = {
    appId: deploy.component.appId,
    componentId: deploy.componentId,
    deployId: deploy.id,
  };
  if (outcome.kind === 'cancelled') {
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line: `cancelled by ${by}`,
    });
    await recordDeployEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
    });
    return ok({ deployId: deploy.id, phase: 'FAILED' as const });
  }

  await recordDeployEvent(context.db, attempt, {
    type: 'log',
    line: `cancel requested by ${by}; the attempt ends at its next event`,
  });
  return ok({ deployId: deploy.id, phase: outcome.phase });
};
