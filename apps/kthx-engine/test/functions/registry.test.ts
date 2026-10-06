// The fixture declares no vessel locations, so each connected case adds what
// connectTarget would write.
import { describe, expect, test } from 'bun:test';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import { functionsFor } from '../../src/functions/index.ts';
import { fixtureManifest } from '../harness/installation.ts';

const cloudflareToken = () => 'cloudflare-token';
const cloudToken = () => 'cloud-token';

describe('functionsFor', () => {
  test('the unconnected fixture answers both deployers null', async () => {
    const manifest = await fixtureManifest();
    const deployers = functionsFor({ manifest, cloudflareToken, cloudToken });

    expect(deployers['cloud-run-functions']).toBeNull();
    expect(deployers['cloudflare-workers']).toBeNull();
  });

  test('a connected home vessel builds the Cloud Run functions deployer', async () => {
    const base = await fixtureManifest();
    const manifest: InstallationManifest = {
      ...base,
      vessels: base.vessels.map((vessel) =>
        vessel.kind === 'gcp-project' &&
        vessel.name === base.installation.homeVessel
          ? { ...vessel, location: { project: 'example-vessel' } }
          : vessel,
      ),
      targets: base.targets.map((target) =>
        target.adapter === 'cloudrun' &&
        target.vessel === base.installation.homeVessel
          ? {
              ...target,
              connection: {
                region: 'example-region',
                serviceAccount:
                  'runtime@example-vessel.iam.gserviceaccount.com',
              },
            }
          : target,
      ),
    };

    const deployers = functionsFor({ manifest, cloudflareToken, cloudToken });
    const cloudRun = deployers['cloud-run-functions'];

    expect(cloudRun).not.toBeNull();
    expect(cloudRun?.target).toBe('cloud-run-functions');
    expect(deployers['cloudflare-workers']).toBeNull();
  });

  test('a declared Cloudflare account vessel builds the Workers deployer', async () => {
    const base = await fixtureManifest();
    const manifest: InstallationManifest = {
      ...base,
      vessels: [
        ...base.vessels,
        {
          name: 'cloudflare',
          kind: 'cloudflare-account',
          location: { account: 'example-account' },
        },
      ],
    };

    const deployers = functionsFor({ manifest, cloudflareToken, cloudToken });

    expect(deployers['cloudflare-workers']).not.toBeNull();
    expect(deployers['cloudflare-workers']?.target).toBe('cloudflare-workers');
  });
});
