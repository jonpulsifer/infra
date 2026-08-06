/**
 * `setAppAutoDeploy` — an App opts in to deploying on push (§15).
 *
 * `apps.autoDeploy` shipped with the webhook and the dispatcher
 * (`src/reconciler/auto-deploy.ts`) and with nothing that could ever write it:
 * the column defaults `false`, `createApp` does not take it, and no command
 * set it. So the feature was complete and permanently off. This is the switch.
 *
 * **A toggle, not a deploy.** Unlike `setComponentReach` and
 * `setComponentSchedule` — which change what a *release* should look like and
 * therefore name a `pendingRelease` — this changes nothing about what is
 * running. It changes what happens the **next** time a commit is adopted, and
 * nothing about the current release is stale for having been deployed while it
 * was off. So there is no pending anything to report, and turning it on does
 * not deploy: §15's dispatcher fires on an adopted commit, and the opt-in is
 * not itself a commit.
 *
 * **An archive App is refused.** `dispatchAutoDeploys` reads the scopes of
 * repository reconciliation passes, so an App with no repository is not
 * something the dispatcher can ever reach — the switch would sit `true` and
 * never fire. §3's rule about refusing where the developer is standing applies
 * exactly: a toggle that silently does nothing forever is worse than one that
 * says why.
 *
 * **A repo App whose repository is not connected yet is allowed.** That one is
 * temporary — §15 makes connecting a repository something an operator turns on
 * afterwards — so the switch becomes live the moment the connection lands,
 * which is a different thing from never. The result names the repository, or
 * its absence, so the answer says what will actually trigger it.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps, repositories } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';

export const setAppAutoDeployInput = z
  .object({
    appId: z.uuid(),
    /**
     * Required rather than a toggle-what-is-there, for the same reason
     * `setComponentSchedule.schedule` is: a caller that sent the wrong state
     * should write the wrong state, not flip whatever it found. Two clients
     * racing a toggle both succeed and the App ends up wherever the last one
     * looked; two clients racing a set both succeed and agree.
     */
    autoDeploy: z.boolean(),
  })
  .strict();

export type SetAppAutoDeployInput = z.infer<typeof setAppAutoDeployInput>;

export interface SetAppAutoDeployResult {
  readonly appId: string;
  readonly autoDeploy: boolean;
  /**
   * The repository a push would have to land on, or `null` when this App names
   * one that nobody has connected yet.
   *
   * Present so that "on" is never reported without saying what it is on *for*.
   */
  readonly repository: string | null;
}

export const setAppAutoDeploy: Command<
  SetAppAutoDeployInput,
  SetAppAutoDeployResult
> = async (input, context) => {
  const [app] = await context.db
    .select({
      id: apps.id,
      name: apps.name,
      sourceKind: apps.sourceKind,
      repositoryId: apps.repositoryId,
    })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  if (app.sourceKind !== 'repo') {
    // Same code and shape as `setComponentSchedule`'s "only a job Component
    // has a schedule": the input is well formed and names a real App, and what
    // is wrong is which App it names.
    return failed(
      'INVALID_INPUT',
      `'${app.name}' is deployed from an uploaded archive, so no push can ever ` +
        'reach it — auto-deploy would have nothing to fire on. Recreate it from ' +
        'a repository if you want deploys on push.',
      [{ path: 'appId', message: 'not a repository App' }],
    );
  }

  const repository =
    app.repositoryId === null
      ? null
      : ((
          await context.db
            .select({ name: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.id, app.repositoryId))
            .limit(1)
        )[0]?.name ?? null);

  await context.db
    .update(apps)
    .set({ autoDeploy: input.autoDeploy, updatedAt: context.clock.now() })
    .where(eq(apps.id, app.id));

  return ok({ appId: app.id, autoDeploy: input.autoDeploy, repository });
};
