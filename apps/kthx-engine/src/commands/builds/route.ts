import { eq } from 'drizzle-orm';
import { buildRouteProfiles } from '../../adapters/registry.ts';
import { apps, targets } from '../../db/schema.ts';
import {
  type BuildRouteCandidate,
  DEFAULT_MINIMUM_BUILD_LEVEL,
  selectBuildRoute,
} from '../../domain/build-route.ts';
import type { BuildDispatchContext } from './dispatch.ts';

/**
 * The level is a threshold, then admin rank wins; an App's chosen route only
 * narrows the admitted set. `appId` is optional: creation asks before an App exists.
 */
export async function routeForTarget(
  targetId: string,
  context: BuildDispatchContext,
  appId?: string,
): Promise<string | null> {
  return (await buildRouteFor(targetId, context, appId)).route;
}

/** The same selection, with every candidate and the reason behind each. */
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
      // Null narrows nothing: the App has no opinion.
      ...(chosen === null ? {} : { routes: [chosen] }),
    },
    (routeName) => context.adapters.build(routeName) !== null,
  );
}

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
 * Refuses a route the Target will not take when it is chosen, instead of at
 * dispatch. `null` when the route is fine.
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
