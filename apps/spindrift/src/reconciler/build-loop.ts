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
import { buildRouteFor } from '../commands/builds/route.ts';
import {
  builds,
  components,
  componentTargetDesired,
  targets,
} from '../db/schema.ts';

/**
 * How often to look for a Build to dispatch.
 *
 * Both ends are the wait between pressing Deploy and a runner starting, and the
 * scan itself is one indexed `select` over `PENDING` rows — so idle is seconds,
 * not the tens of seconds a cheaper-looking number would cost every developer.
 */
export const DEFAULT_BUILD_INTERVALS = {
  activeMs: 500,
  idleMs: 1_500,
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
    const selection = await buildRouteFor(row.targetId, context, row.appId);
    if (selection.route === null) {
      // A Target whose policy no available route satisfies. Configuring a
      // route is an operator act that makes the next tick work, so the Build
      // stays PENDING — and says so once, because a Build PENDING forever with
      // nothing anywhere saying why is the failure worth spending a row on.
      //
      // Every candidate's own sentence is carried, because since an App may
      // name its route the general sentence is no longer the whole truth: "this
      // Target does not admit this route" is a thing the developer did and can
      // undo, and it reads nothing like an installation that configured none.
      const reasons = selection.candidates
        .filter((candidate) => !candidate.eligible)
        .map((candidate) => `${candidate.route} (${candidate.reason})`)
        .join('; ');
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
        reasons === ''
          ? 'no build route this installation configures meets the policy of the Target this Build is placed on, so nothing can run it'
          : `no build route can run this Build for the Target it is placed on: ${reasons}`,
      );
      continue;
    }
    const route = selection.route;
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
