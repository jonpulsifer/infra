/**
 * Whether the gateway serves the routes a release rendered. A ready release
 * says Helm applied them, not that any gateway accepted them: a route with
 * `ResolvedRefs=False` answers 503 behind a green HelmRelease.
 */
import type { KubernetesObject } from './api.ts';

export const HTTP_ROUTE = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'HTTPRoute',
  plural: 'httproutes',
} as const;

/** Both must hold on every parent, or some request is not served. */
const REQUIRED = ['Accepted', 'ResolvedRefs'] as const;

interface ParentRef {
  name?: string;
  namespace?: string;
}

interface RouteCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  observedGeneration?: number;
}

interface RouteParentStatus {
  parentRef?: ParentRef;
  conditions?: RouteCondition[];
}

/** `null` when every route is served by every gateway it names. */
export function unroutable(routes: readonly KubernetesObject[]): string | null {
  if (routes.length === 0) {
    return 'the release rendered no HTTPRoute for this Component yet';
  }
  for (const route of routes) {
    const stall = routeStall(route);
    if (stall !== null) return stall;
  }
  return null;
}

function routeStall(route: KubernetesObject): string | null {
  const namespace = route.metadata.namespace ?? '';
  const label = `HTTPRoute ${namespace}/${route.metadata.name}`;
  const generation = route.metadata.generation as number | undefined;
  const refs =
    (route.spec as { parentRefs?: ParentRef[] } | undefined)?.parentRefs ?? [];
  const parents =
    (route.status as { parents?: RouteParentStatus[] } | undefined)?.parents ??
    [];

  for (const ref of refs) {
    const gateway = `${ref.namespace ?? namespace}/${ref.name}`;
    const parent = parents.find(
      (entry) =>
        entry.parentRef?.name === ref.name &&
        (entry.parentRef?.namespace ?? namespace) ===
          (ref.namespace ?? namespace),
    );
    if (parent === undefined) {
      return `${label} has no answer yet from gateway ${gateway}`;
    }
    for (const type of REQUIRED) {
      const condition = parent.conditions?.find((entry) => entry.type === type);
      if (
        condition === undefined ||
        (generation !== undefined &&
          condition.observedGeneration !== undefined &&
          condition.observedGeneration < generation)
      ) {
        return `${label} is waiting for gateway ${gateway} to judge generation ${generation ?? '?'}`;
      }
      if (condition.status !== 'True') {
        const why = [condition.reason, condition.message]
          .filter((part) => part !== undefined && part !== '')
          .join(': ');
        return `${label} is not served by gateway ${gateway}: ${type} is ${condition.status ?? 'unset'}${why === '' ? '' : ` (${why})`}`;
      }
    }
  }
  return null;
}
