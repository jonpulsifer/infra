/**
 * `setComponentReach` — change how an existing Component is reached (§9).
 *
 * `reach` and `auth` were settable exactly once, in `createComponent`, so
 * "make this App reachable" was a re-creation: delete the Component, lose its
 * Deploy history and its config pins, and say a different answer the second
 * time. This is the other half of that pair, and it is the whole of it — the
 * two fields are one decision (§9's grid), so one act sets both.
 *
 * **This is a deploy, not a settings toggle.** §9 keeps exposure out of the
 * mutable-in-place category, and that is a fact about rendering rather than a
 * preference: the App chart renders the HTTPRoute, the DNS annotations and the
 * ExternalAuth filter from values written at deploy time
 * (`src/adapters/deploy/kubernetes/values.ts`), and the canonical hostname is
 * minted into the zone chosen *per reach* (`zoneForReach`). Nothing that is
 * already running changes because this row changed. So the act writes the
 * Component and stops, and {@link SetComponentReachResult.pendingRelease}
 * names where the released answer is now the older one.
 *
 * Deliberately unlike `setConfig`, which ends by writing an intent: §10 says a
 * config change "produces a new Deploy" because a changed reference nothing
 * re-applies is a workload still running the old value, and §9 says the
 * opposite — a tightening that took effect the instant somebody saved a form
 * would drop a live release's route out from under it with no attempt to read.
 * Pressing Deploy is the same shape as every other change to what is running.
 *
 * The grid rule is the schema's, shared with `createComponent` through
 * {@link authHasARoute}: `reach: none` with `auth: proxy` is unsayable on both
 * paths, or it is enforced on neither.
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
import { type Command, failed, ok } from '../types.ts';

export const setComponentReachInput = z
  .object({
    componentId: z.uuid(),
    /**
     * Both required, and neither defaulted.
     *
     * `createComponent` defaults them because §9 states which state a caller
     * gets by saying nothing at creation. An edit has no such state to fall
     * back to: a form that omitted `auth` would silently re-assert `proxy` over
     * a Component an operator had deliberately left open, and the omission
     * would read as "leave it alone".
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
   * The Targets whose current release still places the previous answer, by
   * name and sorted.
   *
   * Empty means there is nothing to press Deploy for — either this Component
   * has never been placed, or what is desired already asks for what was just
   * saved. A non-empty list is the sentence a screen owes the operator, and it
   * is read off the Deploy's own pinned `reach`/`auth` rather than off the
   * Component, because those two columns exist precisely so that "what is
   * running" and "what is now asked for" can be different values.
   */
  readonly pendingRelease: readonly string[];
}

export const setComponentReach: Command<
  SetComponentReachInput,
  SetComponentReachResult
> = async (input, context) => {
  // Written and read back in one statement: the alternative is a select, a
  // decision, and an update, which is three chances for the row to be a
  // different row by the time the last one runs.
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
      target: { columns: { name: true } },
      desiredDeploy: { columns: { reach: true, auth: true } },
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
          (desiredDeploy.reach !== input.reach ||
            desiredDeploy.auth !== input.auth),
      )
      .map(({ target }) => target.name)
      .sort(),
  });
};
