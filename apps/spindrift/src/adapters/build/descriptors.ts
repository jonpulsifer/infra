import type { BuildRouteDescriptor } from './descriptor.ts';
import { githubActionsDescriptor } from './github-actions.ts';
import { cloudBuildDescriptor } from './cloud-build.ts';
import { inClusterDescriptor } from './in-cluster.ts';

export const BUILD_ROUTE_DESCRIPTORS: readonly BuildRouteDescriptor[] = [
  githubActionsDescriptor,
  cloudBuildDescriptor,
  inClusterDescriptor,
];

export function findBuildRouteDescriptor(
  kind: string,
): BuildRouteDescriptor | undefined {
  return BUILD_ROUTE_DESCRIPTORS.find((d) => d.kind === kind);
}
