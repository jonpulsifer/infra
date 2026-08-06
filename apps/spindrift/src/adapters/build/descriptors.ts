import { cloudBuildDescriptor } from './cloud-build.ts';
import type { BuildRouteDescriptor } from './descriptor.ts';
import { githubActionsDescriptor } from './github-actions.ts';
import { inClusterDescriptor } from './in-cluster.ts';

export { cloudBuildDescriptor, githubActionsDescriptor, inClusterDescriptor };

export const BUILD_ROUTE_DESCRIPTORS = [
  githubActionsDescriptor,
  cloudBuildDescriptor,
  inClusterDescriptor,
] as const;

export function findBuildRouteDescriptor(
  kind: string,
): BuildRouteDescriptor | undefined {
  return BUILD_ROUTE_DESCRIPTORS.find((d) => d.kind === kind);
}
