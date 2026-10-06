/**
 * Sets how an existing Component is reached. `reach` and `auth` are one
 * decision, so one act sets both. A running release keeps its answer until the
 * next Deploy.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import {
  AUTH_NEEDS_A_ROUTE,
  type Auth,
  authHasARoute,
  type Reach,
} from '../../domain/desired-state.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const setComponentReachInput = z
  .object({
    componentId: z.uuid(),
    /**
     * Both required, neither defaulted: an omitted `auth` would silently
     * re-assert `proxy`.
     */
    reach: z.enum(['none', 'private', 'public']),
    auth: z.enum(['none', 'proxy']),
  })
  .strict()
  .refine(authHasARoute, { error: AUTH_NEEDS_A_ROUTE, path: ['auth'] });

export type SetComponentReachInput = z.infer<typeof setComponentReachInput>;

export interface SetComponentReachResult {
  readonly componentId: string;
  readonly reach: Reach;
  readonly auth: Auth;
  /**
   * Targets whose live release pins a different `reach` or `auth`, as
   * `<vessel>/<adapter>`, sorted. Each picks the change up on its next Deploy.
   */
  readonly pendingRelease: readonly string[];
}

export const setComponentReach: Command<
  SetComponentReachInput,
  SetComponentReachResult
> = async (input, context) => {
  // Written and read back in one statement, so the row cannot change in between.
  const [row] = await context.db
    .update(components)
    .set({
      reach: input.reach,
      auth: input.auth,
      updatedAt: context.clock.now(),
    })
    .where(eq(components.id, input.componentId))
    .returning();
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  const placed = await context.db.query.componentTargetDesired.findMany({
    where: (desired, { eq }) => eq(desired.componentId, row.id),
    with: {
      target: {
        columns: { adapter: true },
        with: { vessel: { columns: { name: true } } },
      },
      desiredDeploy: { columns: { desired: true } },
    },
  });

  return ok({
    componentId: row.id,
    reach: row.reach,
    auth: row.auth,
    pendingRelease: placed
      .filter(
        ({ desiredDeploy }) =>
          desiredDeploy !== null &&
          (desiredDeploy.desired.reach !== input.reach ||
            desiredDeploy.desired.auth !== input.auth),
      )
      .map(({ target }) => targetRowLabel(target))
      .sort(),
  });
};
