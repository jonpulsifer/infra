import { eq } from 'drizzle-orm';
import { buildRouteProfiles } from '../../adapters/registry.ts';
import { apps, targets } from '../../db/schema.ts';
import {
  type BuildRouteCandidate,
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
  selectBuildRoute,
} from '../../domain/build-route.ts';
import type { BuildDispatchContext } from './dispatch.ts';

/**
 * Select the route one Target will take a build from, narrowed by the App's own
 * choice where it has made one.
 *
 * §16's sentence is unchanged and the order of its clauses is why this composes
 * rather than conflicts: **the level is a threshold, then admin rank wins.**
 * The App's choice enters as `demand.routes` — the admitted set — which
 * `buildRouteCandidates` applies *alongside* the threshold and never instead of
 * it. So an App that names a route below its Target's minimum gets `null` and
 * the refusal sentence, exactly as if an operator had ranked that route first.
 *
 * `appId` is optional because the creation flow asks this question before an
 * App row exists: a draft is being reviewed, and what it wants to know is
 * whether *anything* could build for the Target it picked.
 */
export async function routeForTarget(
  targetId: string,
  context: BuildDispatchContext,
  appId?: string,
): Promise<string | null> {
  return (await buildRouteFor(targetId, context, appId)).route;
}

/**
 * The same selection, with every route considered and the sentence behind each.
 *
 * §3's shape rather than a boolean, and it is what makes an App's choice
 * legible: "this Target does not admit this route" is what a developer sees
 * when they picked one, and it is the difference between a Build that is
 * PENDING for a reason and one that is PENDING.
 */
export async function buildRouteFor(
  targetId: string,
  context: BuildDispatchContext,
  appId?: string,
): Promise<{
  readonly route: string | null;
  readonly candidates: readonly BuildRouteCandidate[];
}> {
  const [target] = await context.db
    .select({ minimumLevel: targets.minBuildLevel })
    .from(targets)
    .where(eq(targets.id, targetId))
    .limit(1);
  if (!target) return { route: null, candidates: [] };

  const chosen =
    appId === undefined ? null : await appBuildRoute(context, appId);

  return selectBuildRoute(
    buildRouteProfiles(context.manifest),
    {
      minimumLevel:
        (target.minimumLevel as 1 | 2 | 3 | null) ??
        DEFAULT_MINIMUM_BUILD_LEVEL,
      // Null narrows nothing, which is the no-opinion case and every App until
      // one says otherwise.
      ...(chosen === null ? {} : { routes: [chosen] }),
    },
    (routeName) => context.adapters.build(routeName) !== null,
  );
}

/** The route this App asked for, or null where it has no opinion. */
async function appBuildRoute(
  context: Pick<BuildDispatchContext, 'db'>,
  appId: string,
): Promise<string | null> {
  const [app] = await context.db
    .select({ buildRoute: apps.buildRoute })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return app?.buildRoute ?? null;
}

/**
 * Whether one Target would take a build from one named route, and why not.
 *
 * The edit-time half of the same question `buildRouteFor` answers at dispatch,
 * so that choosing a route an installation cannot honour is refused where the
 * developer is standing rather than discovered by a Build that never runs.
 * Returns the sentence to say, or `null` when the route is fine.
 */
export function refusalForChosenRoute(
  candidates: readonly BuildRouteCandidate[],
  route: string,
  targetName: string,
): string | null {
  const candidate = candidates.find((one) => one.route === route);
  if (candidate === undefined) {
    return `this installation has no build route named "${route}"`;
  }
  return candidate.eligible
    ? null
    : `${targetName} will not take a build from ${route}: ${candidate.reason}`;
}
