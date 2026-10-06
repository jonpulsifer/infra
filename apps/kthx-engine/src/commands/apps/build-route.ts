/**
 * `setAppBuildRoute`: names the build route an App builds on, or clears it back
 * to rank order. The route narrows selection; each Target's level still applies.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  components,
  componentTargetDesired,
  targets,
  vessels,
} from '../../db/schema.ts';
import { publishableRegistries } from '../../domain/artifact-name.ts';
import { targetLabel } from '../../domain/target.ts';
import { buildRouteFor, refusalForChosenRoute } from '../builds/route.ts';
import { type Command, failed, ok } from '../types.ts';

export const setAppBuildRouteInput = z
  .object({
    appId: z.uuid(),
    /** The route to build on, or null to clear the choice. */
    route: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetAppBuildRouteInput = z.infer<typeof setAppBuildRouteInput>;

export interface SetAppBuildRouteResult {
  readonly appId: string;
  /** Null means rank order. */
  readonly route: string | null;
  /** The Targets the route was checked against. */
  readonly targets: readonly string[];
}

export const setAppBuildRoute: Command<
  SetAppBuildRouteInput,
  SetAppBuildRouteResult
> = async (input, context) => {
  const [app] = await context.db
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  // The route is the App's and the threshold is each Target's, so the route
  // must clear every Target any of the App's Components is placed on.
  const placements = await context.db
    .selectDistinct({
      id: targets.id,
      vessel: vessels.name,
      adapter: targets.adapter,
      // Discovery's current record; a connect-time declaration goes stale.
      discovery: targets.discovery,
    })
    .from(componentTargetDesired)
    .innerJoin(
      components,
      eq(components.id, componentTargetDesired.componentId),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(components.appId, app.id));

  if (input.route !== null) {
    const adapter = context.adapters.build(input.route);
    // Each push is authorized by the route that makes it, so routes can publish
    // to different registries.
    const published =
      adapter === null
        ? []
        : publishableRegistries({
            registries: context.manifest.supplyChain.registry,
            selfAuthorized: adapter.selfAuthorizedRegistries,
            storedHosts: new Set(
              (await context.adapters.registryCredentials?.()?.list())?.map(
                (one) => one.host,
              ) ?? [],
            ),
          });

    for (const target of placements) {
      const selection = await buildRouteFor(target.id, context);
      const refusal = refusalForChosenRoute(
        selection.candidates,
        input.route,
        targetLabel(target),
      );
      if (refusal !== null) return failed('NOT_BUILDABLE', refusal);

      // A route publishing nowhere the Target can pull from gives a green Build
      // whose Deploy fails. A Target declaring none pulls from the first registry.
      const reachable = target.discovery?.reachableRegistries ?? [];
      const pullable =
        reachable.length > 0
          ? reachable
          : context.manifest.supplyChain.registry.slice(0, 1);
      // A reachable entry is a namespace or a bare host that reaches every
      // namespace on it. Published entries are namespaces, so match as a prefix.
      const meets = published.some((registry) =>
        pullable.some(
          (reach) => registry === reach || registry.startsWith(`${reach}/`),
        ),
      );
      if (!meets) {
        return failed(
          'NOT_BUILDABLE',
          `${input.route} publishes to ${published.join(' and ') || 'no registry this installation configures'}, ` +
            `and ${targetLabel(target)} pulls from ${pullable.join(' or ')} — ` +
            `so a build of ${app.name} on that route would produce an artifact ` +
            `${targetLabel(target)} cannot pull. Store a registry credential for one ` +
            `${targetLabel(target)} reaches, or leave ${app.name} on rank order.`,
        );
      }
    }
  }

  await context.db
    .update(apps)
    .set({ buildRoute: input.route, updatedAt: context.clock.now() })
    .where(eq(apps.id, app.id));

  return ok({
    appId: app.id,
    route: input.route,
    targets: placements.map(targetLabel),
  });
};
