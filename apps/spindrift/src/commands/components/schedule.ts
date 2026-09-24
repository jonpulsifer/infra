/**
 * Sets or removes a job Component's cron schedule. `null` removes it and is
 * required, so a removal is stated, never implied. A running release keeps its
 * schedule until the next Deploy.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';
import { cronExpression } from './create.ts';

export const setComponentScheduleInput = z
  .object({
    componentId: z.uuid(),
    /** `null` leaves the job unscheduled. */
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
   * Every Target a Deploy has reached, sorted, whether or not its live release
   * already has this schedule.
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
    with: {
      target: {
        columns: { adapter: true },
        with: { vessel: { columns: { name: true } } },
      },
    },
  });

  return ok({
    componentId: updated!.id,
    schedule: updated!.schedule,
    // A null `desiredDeployId` is a pair whose first attempt was vetoed, so
    // nothing runs there.
    pendingRelease: placed
      .filter((desired) => desired.desiredDeployId !== null)
      .map(({ target }) => targetRowLabel(target))
      .sort(),
  });
};
