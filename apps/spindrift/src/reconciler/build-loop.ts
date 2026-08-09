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
  vessels,
} from '../db/schema.ts';
import { artifactTypeFor } from '../domain/placement.ts';
import { targetLabel } from '../domain/target.ts';
import {
  reconcilerAttemptDuration,
  reconcilerLoopDuration,
  reconcilerPickupLatency,
  reconcilerQueueDepth,
} from '../telemetry/index.ts';

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
      // For the pickup-latency metric below — every row here is PENDING by
      // the `where` clause, so this is the age of a Build still waiting to be
      // claimed.
      createdAt: builds.createdAt,
      // For binding the Build to a placement that admits its shape: what this
      // Build produces, what the Component is, and enough of the Target to
      // derive the shape it takes — plus the row's `updatedAt`, which is what
      // says which placement is the one of record.
      targetShape: builds.targetShape,
      kind: components.kind,
      adapter: targets.adapter,
      vessel: vessels.name,
      desiredUpdatedAt: componentTargetDesired.updatedAt,
    })
    .from(builds)
    .innerJoin(components, eq(builds.componentId, components.id))
    .innerJoin(
      componentTargetDesired,
      eq(componentTargetDesired.componentId, components.id),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(builds.status, 'PENDING'))
    .orderBy(asc(builds.id), asc(targets.rank));

  // A moved Component deliberately keeps the old pair's desired row until what
  // still serves there is retired, so a PENDING Build can join two placements —
  // and only one of them takes the shape this Build produces. Each Build is
  // bound to the newest desired row whose Target admits its shape: the same
  // newest-row-is-the-placement-of-record reading `deployApp` uses. Rank is
  // only the tie-break the ordering above already applied.
  const perBuild = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = perBuild.get(row.buildId);
    if (group === undefined) perBuild.set(row.buildId, [row]);
    else group.push(row);
  }
  const shapeTaken = (candidate: (typeof rows)[number]) =>
    artifactTypeFor(candidate.kind, {
      capabilities: {
        artifactTypes:
          context.adapters.deploy(candidate.adapter)?.artifactTypes ?? [],
      },
    });

  let dispatched = 0;
  for (const group of perBuild.values()) {
    let row: (typeof rows)[number] | undefined;
    for (const candidate of group) {
      if (shapeTaken(candidate) !== candidate.targetShape) continue;
      if (
        row === undefined ||
        candidate.desiredUpdatedAt > row.desiredUpdatedAt
      ) {
        row = candidate;
      }
    }
    if (row === undefined) {
      // No placement takes what this Build produces. Binding it anywhere would
      // evaluate route and policy against a Target the artifact can never land
      // on, so the Build stays PENDING and says so: placing the Component
      // somewhere that admits the shape is an operator act that makes the next
      // tick work.
      const pending = group[0]!;
      const refused = group
        .map(
          (candidate) =>
            `${targetLabel(candidate)} takes ${shapeTaken(candidate)}`,
        )
        .join('; ');
      await recordDispatchWait(
        context,
        {
          attempt: {
            appId: pending.appId,
            componentId: pending.componentId,
            buildId: pending.buildId,
          },
          waitingOn: pending.waitingOn,
        },
        `this Build produces a ${pending.targetShape} artifact and no Target this Component is placed on takes one (${refused}), so nothing can run it`,
      );
      continue;
    }
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
    // `dispatchBuild` runs the whole attempt — including the adapter's build
    // stream — to completion before returning, so timing this call is timing
    // the build itself, not the loop's own bookkeeping around it.
    const startedAt = Date.now();
    const result = await dispatchBuild(
      {
        buildId: row.buildId,
        route,
        placementTargetId: row.targetId,
      },
      context,
    );
    reconcilerAttemptDuration.record((Date.now() - startedAt) / 1000, {
      kind: 'build',
      outcome: result.ok ? 'ok' : 'refused',
    });
    if (result.ok) {
      dispatched += 1;
      reconcilerPickupLatency.record(
        (Date.now() - row.createdAt.getTime()) / 1000,
        { kind: 'build' },
      );
    }
  }
  // `perBuild` holds every distinct Build this pass looked at, all of them
  // PENDING by the `where` clause — the backlog this pass found, whether or
  // not it managed to dispatch all of it.
  reconcilerQueueDepth.record(perBuild.size, { kind: 'build' });
  return dispatched;
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
