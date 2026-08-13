/**
 * The mark, the name, and the guaranteed SLSA level for each build route's
 * platform (§4, §16).
 *
 * `src/adapters/build/descriptor.ts` states the same three facts per adapter
 * already, but that module imports `GitHubApp` and DB-backed adapter
 * constructors and cannot ship to a browser (`test/web/client-bundle.test.ts`
 * enforces the boundary). This is its client-safe shadow — four rows, small
 * enough that keeping it in sync by eye costs less than a build step that
 * generated one from the other.
 *
 * Keyed by a `string` rather than the closed adapter enum, so a route this
 * installation configures and this table has not grown a case for is a
 * missing key rather than a crash — the runner's name is still rendered,
 * only unaccompanied (`deploy-detail.tsx`'s `Builder()`).
 */
import type { LogoName } from './logos/index.ts';

export interface BuildAdapterInfo {
  readonly logo: LogoName;
  readonly label: string;
  /** What this route's *profile* guarantees, never a verified Build's level. */
  readonly level: 1 | 2 | 3;
}

export const BUILD_ADAPTER: Record<string, BuildAdapterInfo> = {
  'github-actions': { logo: 'github', label: 'GitHub Actions', level: 2 },
  'cloud-build': { logo: 'google-cloud', label: 'Cloud Build', level: 3 },
  'in-cluster': { logo: 'kubernetes', label: 'in-cluster', level: 1 },
  bosun: { logo: 'nixos', label: 'bosun', level: 2 },
};
