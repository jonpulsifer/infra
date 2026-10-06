/**
 * `cancelBuild`: fails a waiting Build, or one whose lease expired, with no
 * reason set. A running Build is only asked to stop; it stays `RUNNING` until
 * its route reports.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { builds } from '../../db/schema.ts';
import { recordBuildEvent } from '../../domain/attempt-log.ts';
import { type Command, type CommandResult, failed, ok } from '../types.ts';
import { DISPATCH_LEASE_TIMEOUT_MS } from './dispatch.ts';

export const cancelBuildInput = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

export type CancelBuildInput = z.infer<typeof cancelBuildInput>;

export interface CancelBuildResult {
  readonly buildId: number;
  /** `RUNNING`: the route was told to stop and has not reported yet. */
  readonly status: 'FAILED' | 'RUNNING';
}

export const cancelBuild: Command<CancelBuildInput, CancelBuildResult> = async (
  input,
  context,
) => {
  const build = await context.db.query.builds.findFirst({
    where: (rows, { eq: eqOp }) => eqOp(rows.id, input.id),
    // The attempt reference needs the App id.
    with: { component: true },
  });

  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build ${input.id}`);
  }

  if (build.status === 'SUCCEEDED' || build.status === 'FAILED') {
    return alreadyEnded(build.id, build.status);
  }

  const attempt = {
    appId: build.component.appId,
    componentId: build.componentId,
    buildId: build.id,
  };
  const route =
    build.runner === null ? null : context.adapters.build(build.runner);
  const handle =
    build.dispatchId === null
      ? null
      : { dispatchId: build.dispatchId, runUrl: build.runUrl ?? null };

  const now = context.clock.now();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);
  const cancelled = await context.db
    .update(builds)
    .set({
      status: 'FAILED',
      dispatchWaitingOn: null,
      nextDispatchAt: null,
      // Fences out an expired claim that revives: its terminal write matches
      // on `dispatch_id` and now finds no row.
      dispatchId: null,
      leasedAt: null,
    })
    // Guarded in the WHERE, so a concurrent claim after the read is never
    // overwritten.
    .where(
      and(
        eq(builds.id, build.id),
        or(
          eq(builds.status, 'PENDING'),
          and(
            eq(builds.status, 'RUNNING'),
            or(isNull(builds.leasedAt), lt(builds.leasedAt, leaseCutoff)),
          ),
        ),
      ),
    )
    .returning({ id: builds.id });

  if (cancelled.length > 0) {
    // A `RUNNING` row's far side can outlive its replica, so it is told to
    // stop, best effort, after the fenced write.
    if (route !== null && handle !== null) {
      await route.cancel(handle).catch(() => {});
    }
    await recordBuildEvent(context.db, attempt, {
      type: 'log',
      line: `cancelled by ${context.principal.displayName}`,
      resource: 'dispatch',
    });
    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
    });
    return ok({ buildId: build.id, status: 'FAILED' as const });
  }

  // A live lease: the attempt settles its own row. Writing `FAILED` here would
  // race its fenced write, so only the far side is stopped.
  if (route === null || handle === null) {
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} is running on ${build.runner ?? 'a route'} this ` +
        'installation no longer configures, so nothing here can reach it — ' +
        'wait for it to finish, or for its lease to expire',
    );
  }
  try {
    await route.cancel(handle);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} is running on ${build.runner}, which could not stop it: ${detail}`,
    );
  }

  // Re-read: a build that finished before the cancel keeps the route's
  // verdict, which a cancel line would contradict.
  const [current] = await context.db
    .select({ status: builds.status })
    .from(builds)
    .where(eq(builds.id, build.id));
  if (current?.status === 'SUCCEEDED' || current?.status === 'FAILED') {
    return alreadyEnded(build.id, current.status);
  }

  // Logged as requested: the route reports what stopped, and a far side not
  // created yet runs to its own verdict.
  await recordBuildEvent(context.db, attempt, {
    type: 'log',
    line: `cancel requested by ${context.principal.displayName}; ${build.runner} reports the verdict`,
    resource: 'dispatch',
  });

  return ok({ buildId: build.id, status: 'RUNNING' as const });
};

function alreadyEnded(
  buildId: number,
  status: 'SUCCEEDED' | 'FAILED',
): CommandResult<CancelBuildResult> {
  return failed(
    'NOT_BUILDABLE',
    `Build ${buildId} has already ${
      status === 'SUCCEEDED' ? 'succeeded' : 'failed'
    }, so there is nothing to cancel`,
  );
}
