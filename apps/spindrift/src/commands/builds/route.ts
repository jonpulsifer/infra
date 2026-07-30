import { eq } from 'drizzle-orm';
import { buildRouteProfiles } from '../../adapters/registry.ts';
import { targets } from '../../db/schema.ts';
import {
  DEFAULT_MINIMUM_BUILD_LEVEL,
  selectBuildRoute,
} from '../../domain/build-route.ts';
import type { BuildDispatchContext } from './dispatch.ts';

/** Select the highest-ranked configured route that clears one Target's policy. */
export async function routeForTarget(
  targetId: string,
  context: BuildDispatchContext,
): Promise<string | null> {
  const [target] = await context.db
    .select({ minimumLevel: targets.minBuildLevel })
    .from(targets)
    .where(eq(targets.id, targetId))
    .limit(1);
  if (!target) return null;
  const selected = selectBuildRoute(buildRouteProfiles(context.manifest), {
    minimumLevel:
      (target.minimumLevel as 1 | 2 | 3 | null) ?? DEFAULT_MINIMUM_BUILD_LEVEL,
  });
  return selected.route !== null &&
    context.adapters.build(selected.route) !== null
    ? selected.route
    : null;
}
