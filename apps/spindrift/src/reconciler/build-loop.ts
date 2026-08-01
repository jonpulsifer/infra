/**
 * Durable Build convergence.
 *
 * Review writes a PENDING Build and returns immediately so the browser can
 * open the real status surface. This loop owns the long-running runner stream;
 * an HTTP request never has to stay open for the duration of a build.
 */
import { asc, eq } from 'drizzle-orm';
import {
  type BuildDispatchContext,
  dispatchBuild,
  recordDispatchWait,
} from '../commands/builds/dispatch.ts';
import { routeForTarget } from '../commands/builds/route.ts';
import {
  builds,
  components,
  componentTargetDesired,
  targets,
} from '../db/schema.ts';

export const DEFAULT_BUILD_INTERVALS = {
  activeMs: 1_000,
  idleMs: 5_000,
} as const;

export interface BuildLoopOptions {
  readonly signal: AbortSignal;
  readonly intervals?: {
    readonly activeMs: number;
    readonly idleMs: number;
  };
  readonly onPass?: () => void;
}

/** Run every dispatchable PENDING Build once; atomic claiming prevents doubles. */
export async function runBuildPass(
  context: BuildDispatchContext,
): Promise<number> {
  const rows = await context.db
    .select({
      buildId: builds.id,
      targetId: componentTargetDesired.targetId,
      // Carried for the refusal below, which needs an attempt reference and
      // cannot get one from `dispatchBuild` — it never reaches it.
      appId: components.appId,
      componentId: components.id,
      waitingOn: builds.dispatchWaitingOn,
    })
    .from(builds)
    .innerJoin(components, eq(builds.componentId, components.id))
    .innerJoin(
      componentTargetDesired,
      eq(componentTargetDesired.componentId, components.id),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .where(eq(builds.status, 'PENDING'))
    .orderBy(asc(builds.id), asc(targets.rank));

  let dispatched = 0;
  const visited = new Set<number>();
  for (const row of rows) {
    if (visited.has(row.buildId)) continue;
    visited.add(row.buildId);
    const route = await routeForTarget(row.targetId, context);
    if (route === null) {
      // A Target whose policy no configured route satisfies. Configuring a
      // route is an operator act that makes the next tick work, so the Build
      // stays PENDING — and says so once, because a Build PENDING forever with
      // nothing anywhere saying why is the failure worth spending a row on.
      await recordDispatchWait(
        context,
        {
          attempt: {
            appId: row.appId,
            componentId: row.componentId,
            buildId: row.buildId,
          },
          waitingOn: row.waitingOn,
        },
        'no build route this installation configures meets the policy of the Target this Build is placed on, so nothing can run it',
      );
      continue;
    }
    const result = await dispatchBuild(
      {
        buildId: row.buildId,
        route,
        placementTargetId: row.targetId,
      },
      context,
    );
    if (result.ok) dispatched += 1;
  }
  return dispatched;
}

export async function runBuildLoop(
  context: BuildDispatchContext,
  options: BuildLoopOptions,
): Promise<void> {
  const intervals = options.intervals ?? DEFAULT_BUILD_INTERVALS;
  while (!options.signal.aborted) {
    const dispatched = await runBuildPass(context);
    options.onPass?.();
    await abortableSleep(
      dispatched > 0 ? intervals.activeMs : intervals.idleMs,
      options.signal,
    );
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
