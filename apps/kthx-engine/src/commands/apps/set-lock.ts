/**
 * `setAppLock`: holds every new Deploy of an App, or releases the hold. A lock
 * refuses every intent except a rollback. Unlocking dispatches the adopted
 * commit a push skipped while locked.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.ts';
import { apps } from '../../db/schema.ts';
import {
  type AutoDeployAttempt,
  deployComponentAt,
} from '../../reconciler/auto-deploy.ts';
import {
  type Command,
  type CommandContext,
  failed,
  ok,
  type Principal,
} from '../types.ts';

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
  /** The hold's reason, or `null` when unlocked. */
  readonly reason: string | null;
  /**
   * The push an unlock resumed, one attempt per Component, with `deployApp`'s
   * answer, refusal included. Empty when there was nothing to resume.
   */
  readonly resumed: readonly AutoDeployAttempt[];
}

/** Also used by `rollbackDeploy`, inside the transaction writing its intent. */
export async function lockApp(
  db: Pick<Database, 'update'>,
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

/**
 * Dispatches the push the lock held back to each placed Component whose newest
 * Build is not of the adopted commit, as a push would have.
 */
async function resumeHeldPush(
  appId: string,
  context: CommandContext,
): Promise<readonly AutoDeployAttempt[]> {
  const app = await context.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.id, appId),
    with: {
      repository: true,
      components: {
        orderBy: (comps, { asc }) => [asc(comps.createdAt), asc(comps.id)],
        with: {
          builds: {
            orderBy: (builds, { desc }) => [
              desc(builds.createdAt),
              desc(builds.id),
            ],
            limit: 1,
          },
        },
      },
    },
  });
  const adopted = app?.repository?.authoritativeCommit ?? null;
  if (app === undefined || !app.autoDeploy || adopted === null) return [];

  const attempts: AutoDeployAttempt[] = [];
  for (const { id, name, placedTargetId, builds } of app.components) {
    if (placedTargetId === null) continue;
    // Already built: after a rollback, redeploying it would undo the rollback.
    if (builds[0]?.commit.split('#')[0] === adopted) continue;
    // Never throws: the App is already unlocked, so a fault on one Component
    // must not leave the rest unresumed.
    attempts.push(
      await deployComponentAt(
        context,
        app.id,
        { id, name, placedTargetId },
        adopted,
      ),
    );
  }
  return attempts;
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
  if (input.reason !== null) {
    await lockApp(context.db, app.id, input.reason, context.principal, now);
    return ok({ appId: app.id, reason: input.reason, resumed: [] });
  }

  await context.db
    .update(apps)
    .set({ lockReason: null, lockedAt: null, lockedBy: null, updatedAt: now })
    .where(eq(apps.id, app.id));
  return ok({
    appId: app.id,
    reason: null,
    resumed: await resumeHeldPush(app.id, context),
  });
};
