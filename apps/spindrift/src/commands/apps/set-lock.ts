/**
 * `setAppLock` — hold every new Deploy of an App, or let them through again
 * (§6).
 *
 * The lock is what the App has been missing between a rollback and the next
 * push. `rollbackDeploy` places an older Build and stops; the next adopted
 * commit — a Renovate merge at 03:00 — goes back through `dispatchAutoDeploys`
 * with nothing in between where the operator says the cause is fixed. So a
 * rollback sets this, and this is how it is cleared. It also covers "nothing
 * changes here over the weekend" without turning `autoDeploy` off and
 * forgetting to turn it back on.
 *
 * **A hold, not a deploy.** Like `setAppAutoDeploy`, this changes nothing about
 * what is running; it changes what `checkDeployable` answers next time, which
 * is the one gate every intent passes — a press, a push, a config change. A
 * rollback is the one act that goes through regardless, because a rollback is
 * the operator asking for exactly the thing the lock exists to protect.
 *
 * Columns, not a noun (§1). `reason: null` unlocks; anything else locks with
 * that sentence, overwriting a lock already there — the operator who rewrites
 * the reason has read the old one.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.ts';
import { apps } from '../../db/schema.ts';
import { type Command, failed, ok, type Principal } from '../types.ts';

export const setAppLockInput = z
  .object({
    appId: z.uuid(),
    /** The sentence a refused deploy will carry, or `null` to unlock. */
    reason: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetAppLockInput = z.infer<typeof setAppLockInput>;

export interface SetAppLockResult {
  readonly appId: string;
  /** What the App is now held with, or `null` for nothing. */
  readonly reason: string | null;
}

/**
 * Write the lock. Shared with `rollbackDeploy`, which is the other writer,
 * so the two cannot disagree about which columns a lock is.
 */
export async function lockApp(
  db: Database,
  appId: string,
  reason: string,
  by: Principal,
  now: Date,
): Promise<void> {
  await db
    .update(apps)
    .set({ lockReason: reason, lockedAt: now, lockedBy: by.id, updatedAt: now })
    .where(eq(apps.id, appId));
}

export const setAppLock: Command<SetAppLockInput, SetAppLockResult> = async (
  input,
  context,
) => {
  const [app] = await context.db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  const now = context.clock.now();
  if (input.reason === null) {
    await context.db
      .update(apps)
      .set({ lockReason: null, lockedAt: null, lockedBy: null, updatedAt: now })
      .where(eq(apps.id, app.id));
  } else {
    await lockApp(context.db, app.id, input.reason, context.principal, now);
  }

  return ok({ appId: app.id, reason: input.reason });
};
