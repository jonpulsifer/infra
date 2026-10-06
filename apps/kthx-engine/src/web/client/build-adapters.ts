/**
 * A client-safe copy of each route's logo, name and SLSA level from
 * `src/adapters/build/descriptor.ts`, which imports server modules. Keep the
 * two in sync. An unknown route is a missing key and renders the runner's name
 * alone.
 */
import type { LogoName } from './logos/index.ts';

export interface BuildAdapterInfo {
  readonly logo: LogoName;
  readonly label: string;
  /** What the route's profile guarantees, never a verified Build's level. */
  readonly level: 1 | 2 | 3;
}

export const BUILD_ADAPTER: Record<string, BuildAdapterInfo> = {
  'github-actions': { logo: 'github', label: 'GitHub Actions', level: 2 },
  'cloud-build': { logo: 'google-cloud', label: 'Cloud Build', level: 3 },
  'in-cluster': { logo: 'kubernetes', label: 'in-cluster', level: 1 },
  bosun: { logo: 'nixos', label: 'bosun', level: 2 },
};
