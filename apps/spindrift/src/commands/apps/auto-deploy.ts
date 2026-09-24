/**
 * `setAppAutoDeploy`: turns deploy-on-push on or off for a repository App. It
 * deploys nothing now; the dispatcher acts on the next adopted commit.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps, repositories } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';

export const setAppAutoDeployInput = z
  .object({
    appId: z.uuid(),
    /** A set instead of a toggle, so two racing callers end in the same state. */
    autoDeploy: z.boolean(),
  })
  .strict();

export type SetAppAutoDeployInput = z.infer<typeof setAppAutoDeployInput>;

export interface SetAppAutoDeployResult {
  readonly appId: string;
  readonly autoDeploy: boolean;
  /** The repository a push must reach, or `null` until one is connected. */
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
    // The dispatcher reads repository passes, so it could never reach this App.
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
