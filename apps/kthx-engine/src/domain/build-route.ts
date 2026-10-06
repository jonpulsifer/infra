/**
 * Which route builds for which Target. A route below the Target's minimum build
 * level is refused, then admin rank picks among the rest.
 */
import type { BuildLevel } from '../adapters/build/contract.ts';

/** A Target that states nothing refuses the L1 in-cluster route, which builds where Apps run. */
export const DEFAULT_MINIMUM_BUILD_LEVEL: BuildLevel = 2;

/** Rank is the route's position in the list. */
export interface BuildRouteProfile {
  readonly name: string;
  /** What the route's profile guarantees, not the level a given Build achieved. */
  readonly level: BuildLevel;
}

export interface BuildRouteDemand {
  /** Absent means {@link DEFAULT_MINIMUM_BUILD_LEVEL}. */
  readonly minimumLevel?: BuildLevel | null;
  /** Absent admits every route. A name no configured route has is ignored. */
  readonly routes?: readonly string[] | null;
}

/** A list as well as a type, because the extraction scanner allowlists it. */
export const BUILD_ROUTE_REFUSALS = ['below-minimum', 'not-admitted'] as const;

export type BuildRouteRefusal =
  | {
      readonly kind: (typeof BUILD_ROUTE_REFUSALS)[0];
      readonly required: BuildLevel;
    }
  | { readonly kind: (typeof BUILD_ROUTE_REFUSALS)[1] };

export interface BuildRouteCandidate {
  readonly route: string;
  readonly level: BuildLevel;
  readonly eligible: boolean;
  /** Shown to the developer; empty exactly when `eligible`. */
  readonly reason: string;
  readonly refusal?: BuildRouteRefusal;
}

function sentence(refusal: BuildRouteRefusal, level: BuildLevel): string {
  return refusal.kind === 'below-minimum'
    ? `this route guarantees SLSA Build Level ${level} and this Target requires at least L${refusal.required}`
    : 'this Target does not admit this route';
}

/** In input order and never re-sorted, because the input order is the admin rank. */
export function buildRouteCandidates(
  routes: readonly BuildRouteProfile[],
  demand: BuildRouteDemand = {},
): BuildRouteCandidate[] {
  const required = demand.minimumLevel ?? DEFAULT_MINIMUM_BUILD_LEVEL;
  const admitted = demand.routes == null ? null : new Set(demand.routes);

  return routes.map((route) => {
    const refusal: BuildRouteRefusal | null =
      admitted !== null && !admitted.has(route.name)
        ? { kind: 'not-admitted' }
        : route.level < required
          ? { kind: 'below-minimum', required }
          : null;

    return refusal === null
      ? { route: route.name, level: route.level, eligible: true, reason: '' }
      : {
          route: route.name,
          level: route.level,
          eligible: false,
          reason: sentence(refusal, route.level),
          refusal,
        };
  });
}

export interface BuildRouteSelection {
  /** `null` when no eligible route is available. */
  readonly route: string | null;
  readonly candidates: readonly BuildRouteCandidate[];
}

/**
 * The first eligible, available route by rank. No route is a valid state, so it
 * returns null with reasons and lets creation stop before a Build row exists.
 */
export function selectBuildRoute(
  routes: readonly BuildRouteProfile[],
  demand: BuildRouteDemand = {},
  isAvailable: (routeName: string) => boolean = () => true,
): BuildRouteSelection {
  const candidates = buildRouteCandidates(routes, demand);
  return {
    route:
      candidates.find(
        (candidate) => candidate.eligible && isAvailable(candidate.route),
      )?.route ?? null,
    candidates,
  };
}
