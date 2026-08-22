/**
 * Which of an installation's already-declared vessels a Function deploys to.
 *
 * A Function reaches no vessel-picker of its own (`contract.ts`'s ponytail
 * note) — it deploys to whichever surface the manifest already names for that
 * purpose: the first Cloudflare account vessel for Workers, the home vessel's
 * Cloud Run surface for Cloud Run functions. The Cloudflare vessel supplies the
 * account **and** the API root every surface on it reaches, so a mirror in
 * front of the platform is stated once on the boundary. Either answers `null` where the
 * manifest has not connected that surface yet, which `saveFunction` reports as
 * `NOT_DEPLOYABLE` rather than constructing a deployer that cannot be reached.
 */
import type { Fetcher, TokenProvider } from '../adapters/deploy/cloud/http.ts';
import {
  homeVesselOf,
  homeVesselProjectOf,
  sharedServicesOf,
  type VesselSeed,
} from '../config/manifest.schema.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import { CloudRunFunctions } from './cloud-functions.ts';
import type { FunctionDeployers } from './contract.ts';
import { WorkersFunctions } from './workers.ts';

/** Everything {@link functionsFor} needs to build whichever deployers apply. */
export interface FunctionsForInput {
  readonly manifest: InstallationManifest;
  readonly cloudflareToken: TokenProvider;
  readonly cloudToken: TokenProvider;
  readonly fetch?: Fetcher;
}

export function functionsFor(input: FunctionsForInput): FunctionDeployers {
  const { manifest, cloudflareToken, cloudToken, fetch } = input;

  const cloudflareVessel = manifest.vessels.find(
    (vessel): vessel is Extract<VesselSeed, { kind: 'cloudflare-account' }> =>
      vessel.kind === 'cloudflare-account' && vessel.location !== undefined,
  );
  // Every declared zone, in order, rather than the head: which of them this
  // account carries is the account's answer, and `WorkersFunctions` asks it.
  const zoneNames = manifest.dns.zones.map((zone) => zone.name);
  const workers =
    cloudflareVessel === undefined ||
    cloudflareVessel.location === undefined ||
    zoneNames.length === 0
      ? null
      : new WorkersFunctions({
          token: cloudflareToken,
          accountId: cloudflareVessel.location.account,
          zoneNames,
          ...(cloudflareVessel.location.endpoint === undefined
            ? {}
            : { endpoint: cloudflareVessel.location.endpoint }),
          ...(fetch ? { fetch } : {}),
        });

  // `homeVesselProjectOf` is `null` unless the home vessel is `gcp-project`
  // *and* has declared its `location` — the same "not yet connected" gap
  // `cloudflareVessel.location` checks above.
  const project = homeVesselProjectOf(manifest);
  const home = homeVesselOf(manifest);
  const cloudrunTarget = manifest.targets.find(
    (target) =>
      target.vessel === manifest.installation.homeVessel &&
      target.adapter === 'cloudrun',
  );
  const region =
    (cloudrunTarget?.adapter === 'cloudrun'
      ? cloudrunTarget.connection?.region
      : undefined) ??
    (home.kind === 'gcp-project' ? home.location?.network?.region : undefined);
  const cloudRun =
    project === null || region === undefined
      ? null
      : new CloudRunFunctions({
          token: cloudToken,
          project,
          region,
          sourceBucket: sharedServicesOf(manifest).sourceBucket,
          ...(cloudrunTarget?.adapter === 'cloudrun' &&
          cloudrunTarget.connection?.serviceAccount !== undefined
            ? {
                runtimeServiceAccount: cloudrunTarget.connection.serviceAccount,
              }
            : {}),
          ...(fetch ? { fetch } : {}),
        });

  return {
    'cloudflare-workers': workers,
    'cloud-run-functions': cloudRun,
  };
}
