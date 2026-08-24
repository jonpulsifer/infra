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
 * **Locking is a hold, not a deploy.** Like `setAppAutoDeploy`, it changes
 * nothing about what is running; it changes what `checkDeployable` answers
 * next time, which is the one gate every intent passes — a press, a push, a
 * config change. A rollback is the one act that goes through regardless,
 * because a rollback is the operator asking for exactly the thing the lock
 * exists to protect.
 *
 * **Unlocking resumes the push the lock held back.** A push to a locked App
 * is skipped before anything is built (`dispatchAutoDeploys`), and the loop
 * never re-offers that commit: every later pass calls it `unchanged`. So for
 * an `autoDeploy` App whose adopted commit is not what its newest Build was
 * made from, unlocking dispatches `deployApp` for that commit under
 * `AUTO_DEPLOY_PRINCIPAL` — the same act the push would have taken — and
 * says what came of it in `resumed`. Not for a commit that is already built:
 * after a rollback, main is still at the commit that was rolled away from,
 * and redeploying it on unlock would undo the rollback the lock protected.
 *
 * Columns, not a noun (§1). `reason: null` unlocks; anything else locks with
 * that sentence, overwriting a lock already there — the operator who rewrites
 * the reason has read the old one.
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
  /** What the App is now held with, or `null` for nothing. */
  readonly reason: string | null;
  /**
   * The push an unlock resumed, with `deployApp`'s own answer — a refusal
   * included, so the screen can say why nothing is coming. `null` when there
   * was nothing to resume: a lock being set, a manual App, or an adopted
   * commit the newest Build already names.
   */
  readonly resumed: AutoDeployAttempt | null;
}

/**
 * Write the lock. Shared with `rollbackDeploy`, which is the other writer,
 * so the two cannot disagree about which columns a lock is — and which takes
 * a transaction, because its hold belongs with its intent.
 */
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
 * The act the lock held back, taken now — or `null` when there was none.
 *
 * The comparison is the dispatcher's: the adopted commit against the primary
 * Component's newest Build, rerun suffix stripped (`deployApp`), because the
 * primary Component is what a push deploys and the newest Build is what it
 * would have written.
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
