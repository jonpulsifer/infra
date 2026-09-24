/**
 * `cancelDeploy` fails a PENDING intent under the desired row's lock and moves
 * the pointer back, or asks an in-flight attempt to stop at its next event.
 * LIVE and FAILED refuse: cancelling a live release would be a rollback.
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
   * FAILED when this ended the intent; the in-flight phase when the attempt was
   * asked to end.
   */
  readonly phase: 'FAILED' | 'APPLYING' | 'WAITING';
}

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
    // The lock a claim takes, so no claim lands between this read and the
    // write.
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

    // Read again: settle writes its verdict fenced on the attempt, not under
    // this lock.
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

    // Back to the newest earlier Deploy not cancelled before a claim; left
    // here, deployApp would refuse the next redeploy as already desired.
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

      // An older Build than the one behind it means a rollback, which locked
      // the App. Locks no older than the intent go, an operator's included.
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
