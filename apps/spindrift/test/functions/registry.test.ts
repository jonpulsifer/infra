/**
 * `functionsFor` — which of an installation's declared vessels a Function
 * deploys to.
 *
 * The fixture installation (`test/fixtures/installation.example.yaml`) seeds
 * identity and rank only — "no `location` on either" is the fixture's own
 * note — so the bare fixture answers both deployers `null`: neither the home
 * vessel nor any Cloudflare account vessel has been connected yet. The
 * positive paths augment it with the `location`/`connection` facts a real
 * `connectTarget` call would have written, the same way
 * `test/commands/installation-configure.test.ts` overrides the fixture rather
 * than hand-building a manifest from nothing.
 */
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
    // No Cloudflare account vessel in this manifest — the other deployer
    // stays null on its own missing prerequisite.
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
