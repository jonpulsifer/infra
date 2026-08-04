/**
 * `setComponentSchedule` — change or remove a `kind: job` Component's cadence
 * after creation (§2).
 *
 * `createComponent` writes `schedule` once, at creation, and nothing else ever
 * wrote it — so the Cloud Run adapter's removal branch (`apply` unscheduling a
 * job whose `desired.schedule` is absent, `src/adapters/deploy/cloudrun/index.ts:287-311`)
 * was correct and unreachable: no command could ever produce a re-deploy whose
 * `desired.schedule` differed from the one set at creation. This is that
 * command, and it is deliberately narrow — the one field `createComponent`
 * could not make editable without becoming an edit command itself.
 *
 * **Same shape as `setComponentReach`, for the same reasons.** This is a
 * deploy, not a settings toggle: `desiredStateFor`
 * (`src/reconciler/deploy-loop.ts:280`) reads `component.schedule` fresh on
 * every attempt, so writing this row changes nothing that is currently
 * running — the Cloud Scheduler job in front of a live Deploy keeps firing on
 * the old cadence until somebody presses Deploy again. `pendingRelease` names
 * where that is still true.
 *
 * **`null` removes it, and is required rather than optional.** `createComponent`
 * defaults an absent `schedule` to "unscheduled" because that is what silence
 * means at creation; an edit has no such fallback; §9's `setComponentReach`
 * comment is the same argument — an omitted field on an edit reads as "leave
 * it alone", so removing a schedule has to be said, not implied by leaving it
 * out.
 *
 * **Unlike `reach`/`auth`, there is no `deploys.schedule` pin to diff
 * against** — no attempt ever needed one, because nothing about a job's
 * cadence has to survive a rollback the way a released reach does. So
 * `pendingRelease` cannot tell "this Target's live release already fires on
 * the new cadence" from "it does not" the way `setComponentReach` can; it
 * conservatively names every Target this Component is placed on. Pressing
 * Deploy on a Target that happened to already match is a no-op release, not a
 * wrong one.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';
import { cronExpression } from './create.ts';

export const setComponentScheduleInput = z
  .object({
    componentId: z.uuid(),
    /** The new cron expression, or `null` to leave the job unscheduled. */
    schedule: cronExpression.nullable(),
  })
  .strict();

export type SetComponentScheduleInput = z.infer<
  typeof setComponentScheduleInput
>;

export interface SetComponentScheduleResult {
  readonly componentId: string;
  readonly schedule: string | null;
  /**
   * The Targets this Component is placed on, by name and sorted — press
   * Deploy on each to put the new cadence (or its removal) in front of what is
   * currently running there. See the module comment for why this cannot be
   * narrowed the way `setComponentReach`'s equivalent is.
   */
  readonly pendingRelease: readonly string[];
}

export const setComponentSchedule: Command<
  SetComponentScheduleInput,
  SetComponentScheduleResult
> = async (input, context) => {
  const [row] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }
  if (row.kind !== 'job') {
    return failed(
      'INVALID_INPUT',
      `'${row.name}' is a ${row.kind}, and only a job Component has a schedule`,
      [{ path: 'componentId', message: 'not a job Component' }],
    );
  }

  const [updated] = await context.db
    .update(components)
    .set({ schedule: input.schedule, updatedAt: context.clock.now() })
    .where(eq(components.id, input.componentId))
    .returning();

  const placed = await context.db.query.componentTargetDesired.findMany({
    where: (desired, { eq }) => eq(desired.componentId, row.id),
    with: { target: { columns: { name: true } } },
  });

  return ok({
    componentId: updated!.id,
    schedule: updated!.schedule,
    // Only a pair a Deploy actually reached — `componentTargetDesired` also
    // holds rows `createDeploy` inserted and then left with `desiredDeployId`
    // null because that first attempt was vetoed (`src/commands/deploys/create.ts:185-211`),
    // and nothing is running at those, so nothing there is pending.
    pendingRelease: placed
      .filter((desired) => desired.desiredDeployId !== null)
      .map(({ target }) => target.name)
      .sort(),
  });
};
