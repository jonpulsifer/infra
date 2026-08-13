/**
 * What Spindrift calls a Component's project on the edge platform.
 *
 * One rule, two adapters, and they have to agree or nothing works: the deploy
 * adapter creates the project and deploys into it, and the store adapter writes
 * the environment variables the deployment's functions read. A store that
 * derived a different name would write config to a project nothing deploys to
 * — and the failure would be a Component that comes up green and reads
 * `undefined`, which is the shape of failure worth spending a module on.
 *
 * It lives in the domain rather than in either adapter because neither one owns
 * it. `workload-name.ts` already holds the general rule — the same name every
 * backend needs, within whatever length that backend imposes — and this is only
 * that rule plus the platform's own limit, named once.
 */
import { type WorkloadNameParts, workloadName } from './workload-name.ts';

/**
 * A project name is capped at 100 characters of `[a-z0-9._-]`.
 *
 * The character class is the platform's; nothing here enforces it, because an
 * App and a Component are already named out of a narrower alphabet than that.
 * The length is what {@link workloadName} needs.
 */
export const VERCEL_PROJECT_NAME_LIMIT = 100;

/** One project per (App, Component), within the length the platform allows. */
export function vercelProjectName(parts: WorkloadNameParts): string {
  return workloadName(parts, VERCEL_PROJECT_NAME_LIMIT);
}
