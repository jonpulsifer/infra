/**
 * `setAppBuildRoute` — an App names the route it builds on (§4, §16).
 *
 * §16 settles selection as "each Target has a minimum build level defaulting to
 * L2 plus an ordered list of build routes: **the level is a threshold, then
 * admin rank wins**", and rank is an operator's arrangement. What that leaves
 * unsaid is who breaks the tie when the App has a reason of its own — a build
 * that needs an isolated worker, a build that must not queue behind a hosted
 * runner — and the answer is not "the operator re-ranks the installation for
 * one App".
 *
 * **It narrows, it never overrides.** The chosen route enters selection as the
 * admitted set (`buildRouteFor`), so the Target's threshold is applied to it
 * exactly as it is applied to every other candidate. An App cannot name its way
 * past a policy; it can only pick among the routes that already cleared one.
 *
 * **The check is made here as well as at dispatch, and that is the point.** A
 * route this installation does not have, or one no placement Target will take,
 * is refused where the developer is standing — with the sentence
 * `buildRouteCandidates` composed. Left to dispatch it would instead be a Build
 * that sits PENDING saying so to a log, which is the failure §3 keeps asking us
 * not to ship.
 *
 * **And the registry, which is the half a level threshold does not cover.** A
 * route builds an artifact somewhere, and a Target that cannot pull from that
 * somewhere gets a green Build it will never run. Every Target this App is
 * placed on must reach at least one of the registries the installation pushes
 * to, or naming the route is naming a dead end.
 *
 * Clearing the choice is the same command with a null route, which puts the App
 * back to no opinion and rank order — not to some other route.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  components,
  componentTargetDesired,
  targets,
} from '../../db/schema.ts';
import { buildRouteFor, refusalForChosenRoute } from '../builds/route.ts';
import { type Command, failed, ok } from '../types.ts';

export const setAppBuildRouteInput = z
  .object({
    appId: z.uuid(),
    /**
     * The route to build on, or null to go back to no opinion.
     *
     * Nullable rather than optional: "leave it as it is" and "clear it" are
     * different acts and an absent key cannot mean both.
     */
    route: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetAppBuildRouteInput = z.infer<typeof setAppBuildRouteInput>;

export interface SetAppBuildRouteResult {
  readonly appId: string;
  /** What the App now builds on, or null for rank order. */
  readonly route: string | null;
  /** The Targets checked against, so the answer says what it was checked on. */
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

  // Every Target any of this App's Components is placed on. The choice is the
  // App's and the threshold is each Target's, so a route has to clear all of
  // them — an App whose website is on Cloud Run and whose worker is in the
  // cluster is one App with two policies over it.
  const placements = await context.db
    .selectDistinct({
      id: targets.id,
      name: targets.name,
      // §3's derived half, as the standing loop last reported it — not the
      // connection's declaration, because what a Target can pull from is a fact
      // discovery refreshes and a connect-time snapshot rots.
      discovery: targets.discovery,
    })
    .from(componentTargetDesired)
    .innerJoin(
      components,
      eq(components.id, componentTargetDesired.componentId),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .where(eq(components.appId, app.id));

  if (input.route !== null) {
    for (const target of placements) {
      const selection = await buildRouteFor(target.id, context);
      const refusal = refusalForChosenRoute(
        selection.candidates,
        input.route,
        target.name,
      );
      if (refusal !== null) return failed('NOT_BUILDABLE', refusal);

      // The registry half. Where a Target narrows what it can pull from and
      // none of this installation's registries are in that set, no route builds
      // anything it could run — so the sentence names the Target rather than
      // letting a green Build discover it at the pull.
      const reachable = target.discovery?.reachableRegistries ?? [];
      if (
        reachable.length > 0 &&
        !context.manifest.supplyChain.registry.some((registry) =>
          reachable.includes(registry),
        )
      ) {
        return failed(
          'NOT_BUILDABLE',
          `${target.name} pulls only from ${reachable.join(' or ')}, and this ` +
            `installation pushes to ${context.manifest.supplyChain.registry.join(' or ')} — ` +
            `no route can build ${app.name} an artifact it could run`,
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
    targets: placements.map((target) => target.name),
  });
};
