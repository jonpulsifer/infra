/**
 * The Function deployers a manifest supports: Workers on the first Cloudflare
 * account vessel, Cloud Run functions on the home vessel. Either is `null`
 * until the manifest connects that surface.
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
  // Every declared zone, in order: `WorkersFunctions` asks the account which
  // one it carries.
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

  // `null` until the home vessel declares a cloud project location.
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
