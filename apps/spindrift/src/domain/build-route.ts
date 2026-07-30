/**
 * Which route builds for which Target (§16).
 *
 * §16 settles the rule in one sentence — "each Target has a minimum build level
 * defaulting to L2 plus an ordered list of build routes: **the level is a
 * threshold, then admin rank wins**" — and the order of those two clauses is the
 * whole design. A threshold is not a preference: a route below the Target's
 * minimum is not a worse choice than one above it, it is not a choice at all.
 * Rank only ever breaks a tie among routes that already cleared the bar.
 *
 * The consequence §4 states outright is the one worth checking a test against:
 * **`in-cluster` is L1, so an L2+ Target refuses it**, which is also why "a
 * Target cannot be both offline-capable and require L2 or above".
 *
 * The answer's shape is §3's, not a boolean: every route this Target could not
 * use comes back listed with the sentence behind it, because "nothing can build
 * for this Target" is an answer a developer can act on and a silent empty
 * result is not.
 */
import type { BuildLevel } from '../adapters/build/contract.ts';

/**
 * §16's default. A Target that states nothing requires an isolated builder,
 * which is the safe direction to be wrong in: the route it excludes is the one
 * running on hardware the App is also deployed to.
 */
export const DEFAULT_MINIMUM_BUILD_LEVEL: BuildLevel = 2;

/** What selection knows about one configured route. Rank is its position. */
export interface BuildRouteProfile {
  readonly name: string;
  /**
   * The level this route's *profile* guarantees (§16). Not the level a
   * concrete Build achieved — that belongs to the verified Build, and Task 26
   * is what checks the two agree before signing.
   */
  readonly level: BuildLevel;
}

/** What selection knows about the Target being built for. */
export interface BuildRouteDemand {
  /** §16's threshold. Absent means {@link DEFAULT_MINIMUM_BUILD_LEVEL}. */
  readonly minimumLevel?: BuildLevel | null;
  /**
   * The routes this Target admits, if it narrows them. Absent means every
   * configured route, still in the installation's rank order.
   *
   * A name here that no route has is not an error: an installation may retire a
   * route without editing every Target, and the honest reading of a Target
   * naming a route that is gone is that the route is unavailable — which is
   * exactly what {@link buildRouteCandidates} reports.
   */
  readonly routes?: readonly string[] | null;
}

/**
 * The two ways a route can fail to be usable.
 *
 * Exported as a list as well as a type because it is vocabulary — the name of
 * something this software knows, identical in every installation — and the
 * extraction scanner reads the list rather than being told the strings twice.
 */
export const BUILD_ROUTE_REFUSALS = ['below-minimum', 'not-admitted'] as const;

/** Why one route is not usable for one Target. */
export type BuildRouteRefusal =
  | {
      readonly kind: (typeof BUILD_ROUTE_REFUSALS)[0];
      readonly required: BuildLevel;
    }
  | { readonly kind: (typeof BUILD_ROUTE_REFUSALS)[1] };

/** One route, and whether this Target can build on it. */
export interface BuildRouteCandidate {
  readonly route: string;
  readonly level: BuildLevel;
  readonly eligible: boolean;
  /** The sentence a developer reads. Empty exactly when `eligible`. */
  readonly reason: string;
  readonly refusal?: BuildRouteRefusal;
}

function sentence(refusal: BuildRouteRefusal, level: BuildLevel): string {
  return refusal.kind === 'below-minimum'
    ? `this route guarantees SLSA Build Level ${level} and this Target requires at least L${refusal.required}`
    : 'this Target does not admit this route';
}

/**
 * Every configured route, in rank order, annotated with whether this Target can
 * build on it.
 *
 * Order is the input's order and is never re-sorted: the array of routes *is*
 * the admin rank (§16), so sorting here would replace an operator's arrangement
 * with this function's opinion of one.
 */
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

/** What selection came back with, in the grammar §3 uses everywhere else. */
export interface BuildRouteSelection {
  /** The route to run, or `null` when nothing cleared the threshold. */
  readonly route: string | null;
  /** Every route considered, eligible or not, in rank order. */
  readonly candidates: readonly BuildRouteCandidate[];
}

/**
 * The route a build for this Target runs on: the first eligible and available one by rank.
 *
 * `null` with reasons rather than a throw, because "no route can build for this
 * Target" is a state an installation can genuinely be in — an L2 Target and only
 * the in-cluster route configured — and the creation flow has to be able to stop
 * on it before a Build row exists (§18's unmet prerequisite).
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
