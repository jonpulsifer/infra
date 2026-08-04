/**
 * Which application an operator is shown, decided by one predicate.
 *
 * `isUnconfiguredInstallation` is the whole of that decision: false renders the
 * product, true replaces it with a four-question wizard. The two directions are
 * not symmetric and neither is what a test owes them.
 *
 * **A false positive replaces a working installation with a wizard**, which is
 * why the first claim below reads the *real* declaration out of
 * `clusters/offsite/apps/spindrift/helm-release.yaml` rather than a fixture. A
 * fixture asserting the right thing while the repository says something else is
 * exactly the false positive this file exists to refuse, and the predicate reads
 * four specific values — two of which this installation legitimately leaves at
 * the stand-in — so "obviously configured" is not obvious enough to assert from
 * memory.
 *
 * **A false negative is a wizard nobody can reach**, which is what shipped: a
 * predicate over the whole document answered true for exactly one document, the
 * placeholder verbatim, and that document's `controlPlane.hostname` is
 * `spindrift.example.com`. The relying party is bound to it at boot, so no
 * browser will run a passkey ceremony against that installation and onboarding
 * renders only behind a session. The third claim is the state that fixes:
 * a declaration that seeds the deployment facts and leaves the genuine choices
 * alone, which can enrol somebody and is still unconfigured.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  isUnconfiguredInstallation,
  validateManifest,
} from '../../src/config/manifest.ts';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const LIVE_RELEASE = 'clusters/offsite/apps/spindrift/helm-release.yaml';

/**
 * What Flux's `postBuild` fills in, standing in for the values themselves.
 *
 * The zones are read from cluster settings and cluster secrets rather than
 * written in the release, and restating either here would put a network fact in
 * a place that is not its source. Neither is a value the predicate reads; what
 * this substitution is for is letting the rest of the document parse.
 */
const SUBSTITUTED = 'substituted.example';

async function liveDeclaration() {
  const text = (
    await Bun.file(join(REPO_ROOT, LIVE_RELEASE)).text()
  ).replaceAll(/\$\{[A-Z_]+\}/g, SUBSTITUTED);
  const release = Bun.YAML.parse(text) as {
    spec?: { values?: { manifest?: unknown } };
  };
  return validateManifest(release.spec?.values?.manifest, LIVE_RELEASE);
}

describe('the live installation renders the product, not the wizard', () => {
  test('the declaration this repository deploys is configured', async () => {
    const manifest = await liveDeclaration();

    expect(isUnconfiguredInstallation(manifest)).toBe(false);
  });

  test('two of its four genuine choices really are the stand-in', async () => {
    // The reason the claim above is worth a test rather than a glance, and the
    // reason the predicate is "all four" rather than "any": this installation
    // speaks as the same GitHub App the placeholder names and delivers through
    // the same one of two store adapters. A predicate that asked whether *any*
    // genuine choice was still a stand-in would answer unconfigured here, and
    // an operator signing in to a working installation would be handed a wizard.
    const manifest = await liveDeclaration();

    expect(manifest.github.clientId).toBe(
      DEFAULT_PLACEHOLDER_MANIFEST.github.clientId,
    );
    expect(manifest.secretStore.adapter).toBe(
      DEFAULT_PLACEHOLDER_MANIFEST.secretStore.adapter,
    );
    // And the two it answers, which are what make it configured.
    expect(manifest.installation).not.toBe(
      DEFAULT_PLACEHOLDER_MANIFEST.installation,
    );
    expect(manifest.supplyChain.registry).not.toEqual(
      DEFAULT_PLACEHOLDER_MANIFEST.supplyChain.registry,
    );
  });
});

describe('an installation nobody has configured says so', () => {
  test('the document an unseeded row is seeded with is unconfigured', () => {
    expect(isUnconfiguredInstallation(DEFAULT_PLACEHOLDER_MANIFEST)).toBe(true);
  });

  test('a declaration that seeds only the deployment facts is unconfigured', () => {
    // The state the wizard is actually reachable in, and the one a whole-document
    // comparison could not express. Everything corrected here is a fact the chart
    // knows — the hostname above all, which is what makes a passkey ceremony
    // possible at all — and every genuine choice is left at its stand-in.
    const seeded = {
      ...DEFAULT_PLACEHOLDER_MANIFEST,
      controlPlane: { hostname: 'spindrift.substituted.example' },
      dns: {
        zones: {
          private: 'substituted.example',
          public: 'substituted.example',
        },
      },
      charts: { app: 'oci://ghcr.io/example/charts/spindrift-app' },
    };

    expect(isUnconfiguredInstallation(validateManifest(seeded, 'a seed'))).toBe(
      true,
    );
  });

  test('answering one genuine choice is enough to leave onboarding', () => {
    // Onboarding's first screen, and the smallest act that ends it: naming the
    // installation. The wizard asks three of the four and this is the one it
    // asks first, so an operator who gets no further than pressing Continue on
    // an edited name has still configured this installation.
    const named = { ...DEFAULT_PLACEHOLDER_MANIFEST, installation: 'offsite' };

    expect(isUnconfiguredInstallation(named)).toBe(false);
  });

  test('a registry spelled as a bare string is the list it always was', () => {
    // `supplyChain.registry` accepts either spelling and parses both to a list,
    // so the stand-in stays the stand-in however it was written. A predicate
    // comparing the raw document would answer differently for two documents that
    // are the same document.
    const bare = validateManifest(
      {
        ...DEFAULT_PLACEHOLDER_MANIFEST,
        supplyChain: {
          ...DEFAULT_PLACEHOLDER_MANIFEST.supplyChain,
          registry: DEFAULT_PLACEHOLDER_MANIFEST.supplyChain.registry[0],
        },
      },
      'a bare registry',
    );

    expect(isUnconfiguredInstallation(bare)).toBe(true);
  });
});
