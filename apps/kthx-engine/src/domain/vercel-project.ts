/**
 * A Component's project name on the edge platform. The deploy and store
 * adapters must derive the same name, or config is written to a project nothing
 * deploys to.
 */
import { type WorkloadNameParts, workloadName } from './workload-name.ts';

/**
 * The platform caps a project name at 100 characters of `[a-z0-9._-]`. App and
 * Component names use a narrower alphabet, so only the length is enforced.
 */
export const VERCEL_PROJECT_NAME_LIMIT = 100;

export function vercelProjectName(parts: WorkloadNameParts): string {
  return workloadName(parts, VERCEL_PROJECT_NAME_LIMIT);
}
