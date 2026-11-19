/**
 * Dispatches PENDING Builds, and RUNNING ones whose lease expired, and runs
 * each runner stream to completion, so no HTTP request stays open for a build.
 */
import { and, asc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import {
  type BuildDispatchContext,
  DISPATCH_LEASE_TIMEOUT_MS,
  dispatchBuild,
  recordDispatchClose,
  recordDispatchWait,
} from '../commands/builds/dispatch.ts';
import { buildRouteFor } from '../commands/builds/route.ts';
import { createDeploy } from '../commands/deploys/create.ts';
import { apps, builds, components, targets, vessels } from '../db/schema.ts';
import { recordBuildEvent } from '../domain/attempt-log.ts';
import { artifactTypeFor, takesShape } from '../domain/placement.ts';
import { targetLabel } from '../domain/target.ts';
import {
  reconcilerAttemptDuration,
  reconcilerLoopDuration,
  reconcilerPickupLatency,
  reconcilerQueueDepth,
} from '../telemetry/index.ts';
import { AUTO_DEPLOY_PRINCIPAL, currentStateOf } from './auto-deploy.ts';

// Idle is seconds: it is the wait between pressing Deploy and a runner
// starting, and a scan is one select over the queued rows.
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

export async function runBuildPass(
  context: BuildDispatchContext,
): Promise<number> {
  const now = context.clock?.now() ?? new Date();
  // Left joins: an unplaced Component's Build still needs a refusal recorded.
  const rows = await context.db
    .select({
      buildId: builds.id,
      commit: builds.commit,
      targetId: targets.id,
      appId: components.appId,
      repositoryId: apps.repositoryId,
      componentId: components.id,
      deployOnSuccess: builds.deployOnSuccess,
      waitingOn: builds.dispatchWaitingOn,
      attempts: builds.dispatchAttempts,
      createdAt: builds.createdAt,
      targetShape: builds.targetShape,
      kind: components.kind,
      adapter: targets.adapter,
      vessel: vessels.name,
    })
    .from(builds)
    .innerJoin(components, eq(builds.componentId, components.id))
    .innerJoin(apps, eq(apps.id, components.appId))
    .leftJoin(targets, eq(targets.id, components.placedTargetId))
    .leftJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(
      and(
        or(
          eq(builds.status, 'PENDING'),
          // Claimed by a reconciler that stopped; `dispatchBuild` reclaims it.
          and(
            eq(builds.status, 'RUNNING'),
            isNotNull(builds.leasedAt),
            lt(
              builds.leasedAt,
              new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS),
            ),
          ),
        ),
        // A refused row waits out its backoff, so a Build that cannot succeed
        // costs one attempt per backoff interval, not one per tick.
        or(isNull(builds.nextDispatchAt), lte(builds.nextDispatchAt, now)),
      ),
    )
    .orderBy(asc(builds.id));

  let dispatched = 0;
  for (const row of rows) {
    if (row.targetId === null || row.adapter === null || row.vessel === null) {
      // Stays PENDING and says why; placing the Component unblocks it.
      await recordDispatchWait(
        context,
        {
          attempt: {
            appId: row.appId,
            componentId: row.componentId,
            buildId: row.buildId,
          },
          waitingOn: row.waitingOn,
          attempts: row.attempts,
        },
        'this Component is placed on no Target, so nothing can run this Build',
      );
      continue;
    }
    const placement = {
      capabilities: {
        artifactTypes:
          context.adapters.deploy(row.adapter)?.artifactTypes ?? [],
      },
    };
    if (!takesShape(row.kind, row.targetShape, placement)) {
      // Staged for a placement the Component has since left. Closed at once:
      // no configuration change clears a shape mismatch, only a rebuild.
      const shapeTaken = artifactTypeFor(row.kind, placement);
      await recordDispatchClose(
        context,
        {
          attempt: {
            appId: row.appId,
            componentId: row.componentId,
            buildId: row.buildId,
          },
          waitingOn: row.waitingOn,
          attempts: row.attempts,
        },
        `this Build produces a ${row.targetShape} artifact and the Target this Component is placed on takes another (${targetLabel({ vessel: row.vessel, adapter: row.adapter })} takes ${shapeTaken}), so nothing can run it`,
        'REJECTED',
      );
      continue;
    }
    const selection = await buildRouteFor(row.targetId, context, row.appId);
    if (selection.route === null) {
      // Stays PENDING until a route qualifies. Each candidate's reason is
      // carried, because an App may name a route the Target does not admit.
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
          attempts: row.attempts,
        },
        reasons === ''
          ? 'no build route this installation configures meets the policy of the Target this Build is placed on, so nothing can run it'
          : `no build route can run this Build for the Target it is placed on: ${reasons}`,
      );
      continue;
    }
    const route = selection.route;
    // `dispatchBuild` runs the whole build, so this times the build.
    const startedAt = Date.now();
    const result = await dispatchBuild(
      {
        buildId: row.buildId,
        route,
        placementTargetId: row.targetId,
      },
      context,
    );
    // `refused`: an attempt with no verdict (a wait, a close, a lost claim).
    reconcilerAttemptDuration.record((Date.now() - startedAt) / 1000, {
      kind: 'build',
      outcome: result.ok ? result.value.status : 'refused',
    });
    if (result.ok) {
      dispatched += 1;
      reconcilerPickupLatency.record(
        (Date.now() - row.createdAt.getTime()) / 1000,
        { kind: 'build' },
      );

      // `deployOnSuccess`, not `apps.autoDeploy`, so a Rebuild never ships
      // itself; `createDeploy`, since `deployApp` may pick a later Build.
      // `ran`, so of two overlapping passes only the one that built it deploys.
      if (
        row.deployOnSuccess &&
        result.value.status === 'SUCCEEDED' &&
        result.value.ran
      ) {
        const targetId = row.targetId;
        const stale = await staleness(context, { ...row, targetId });
        const placed =
          stale === null
            ? await createDeploy(
                {
                  componentId: row.componentId,
                  targetId,
                  buildId: row.buildId,
                },
                { ...context, principal: AUTO_DEPLOY_PRINCIPAL },
              )
            : null;
        const refusal =
          stale ?? (placed?.ok === false ? placed.failure.message : null);
        if (refusal !== null) {
          // On this Build's attempt log, where a push sends the developer.
          await recordBuildEvent(
            context.db,
            {
              appId: row.appId,
              componentId: row.componentId,
              buildId: row.buildId,
            },
            {
              type: 'log',
              line: `this Build succeeded, and deploying it was refused: ${refusal}`,
              resource: 'dispatch',
            },
          );
        }
      }
    }
  }
  // The backlog this pass found, dispatched or not.
  reconcilerQueueDepth.record(rows.length, { kind: 'build' });
  return dispatched;
}

/**
 * Why a finished Build must not be deployed where the pass read it was going,
 * or `null`. A build can outlast a move or a newer push.
 */
async function staleness(
  context: BuildDispatchContext,
  row: {
    readonly commit: string;
    readonly appId: string;
    readonly repositoryId: string | null;
    readonly componentId: string;
    readonly targetId: string;
  },
): Promise<string | null> {
  const [component] = await context.db
    .select({ placedTargetId: components.placedTargetId })
    .from(components)
    .where(eq(components.id, row.componentId));
  if (component?.placedTargetId !== row.targetId) {
    return 'this Component was moved off the Target it was built for while it built';
  }
  if (row.repositoryId === null) return null;
  const state = await currentStateOf(context.db, row.repositoryId, row.appId);
  const built = row.commit.split('#')[0];
  if (state?.commit && state.commit !== built) {
    return `its repository has adopted ${state.commit} since, so deploying ${built} would roll it back`;
  }
  return null;
}

export async function runBuildLoop(
  context: BuildDispatchContext,
  options: BuildLoopOptions,
): Promise<void> {
  const intervals = options.intervals ?? DEFAULT_BUILD_INTERVALS;
  while (!options.signal.aborted) {
    const passStartedAt = Date.now();
    const dispatched = await runBuildPass(context);
    reconcilerLoopDuration.record((Date.now() - passStartedAt) / 1000, {
      loop: 'build',
    });
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
