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
  AUTO_DEPLOY_PRINCIPAL,
  type AutoDeployAttempt,
} from '../../reconciler/auto-deploy.ts';
import {
  type Command,
  type CommandContext,
  failed,
  ok,
  type Principal,
} from '../types.ts';
import { deployApp } from './deploy.ts';

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
   * The push an unlock resumed, with `deployApp`'s answer, refusal included.
   * `null` when there was nothing to resume.
   */
  readonly resumed: AutoDeployAttempt | null;
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
 * Dispatches the push the lock held back, or answers `null` when there was none.
 * Compares the adopted commit with the primary Component's newest Build.
 */
async function resumeHeldPush(
  appId: string,
  context: CommandContext,
): Promise<AutoDeployAttempt | null> {
  const app = await context.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.id, appId),
    with: {
      repository: true,
      components: {
        orderBy: (comps, { asc }) => [asc(comps.createdAt)],
        limit: 1,
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
  if (app === undefined || !app.autoDeploy || adopted === null) return null;
  const built = app.components[0]?.builds[0]?.commit.split('#')[0] ?? null;
  // Already built: after a rollback, redeploying it would undo the rollback.
  if (built === adopted) return null;

  const result = await deployApp(
    { name: app.id, commit: adopted },
    { ...context, principal: AUTO_DEPLOY_PRINCIPAL },
  );
  return { appId: app.id, commit: adopted, result };
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
    return ok({ appId: app.id, reason: input.reason, resumed: null });
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
