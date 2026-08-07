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
 * renders only behind a session. The seeded-declaration claim below is the state
 * that fixes — a document with a real hostname whose genuine choices are still
 * stand-ins can enrol somebody and is still unconfigured — and it is one
 * document, not a class: nothing in the schema is optional, so that document has
 * to restate every stand-in by hand. See `isUnconfiguredInstallation`.
 *
 * **Each conjunct gets its own claim**, because dropping one from an `&&` is the
 * false-positive direction and the four-value assertion below cannot see it: it
 * reads the values, never the predicate. One claim per genuine choice, each
 * answering that choice alone and asserting configured, is what makes a conjunct
 * that stops being read a red build rather than a silent widening.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
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

/**
 * **The declaration, which is not the document that governs**, and the name says
 * so on purpose. `loadStoredManifest` resolves `stored ?? declaration ??
 * placeholder`, this installation has been seeded for months, and the release's
 * own header says a declaration seeds and the row governs. So no test in this
 * file can assert what the live *installation* renders; what it can assert is
 * that the document this repository declares is not one that would hand an
 * operator a wizard.
 *
 * The offsite web pod's boot warning reports the row and the declaration
 * disagreeing at `charts.app`, at both Targets'
 * `delivery.sourceRef.name`/`.namespace` and
 * `chartValues.platform.externalAuth.name`/`.port`, and — since the fleet moved
 * onto one store of record — at the whole `secretStore` block and both Targets'
 * `chartValues.platform.secretStore.name`. The row still says `onepassword`,
 * which is what `configureInstallation` carries across.
 *
 * That divergence is what this file cannot see and does not claim to. The
 * predicate below reads the declaration, and the assertion is about which of
 * its four genuine choices are answered — not about which document is live.
 */
describe('the declaration this repository deploys is configured', () => {
  test('it is not a document that would replace the product with a wizard', async () => {
    const manifest = await liveDeclaration();

    expect(isUnconfiguredInstallation(manifest)).toBe(false);
  });

  test('one of its four genuine choices really is the stand-in', async () => {
    // The reason the claim above is worth a test rather than a glance, and the
    // reason the predicate is "all four" rather than "any": this installation
    // speaks as the same GitHub App the placeholder names. A predicate that
    // asked whether *any* genuine choice was still a stand-in would answer
    // unconfigured here, and an operator signing in to a working installation
    // would be handed a wizard.
    const manifest = await liveDeclaration();

    expect(manifest.github.clientId).toBe(
      DEFAULT_PLACEHOLDER_MANIFEST.github.clientId,
    );
    // And the three it answers, which are what make it configured.
    expect(manifest.secretStore.adapter).not.toBe(
      DEFAULT_PLACEHOLDER_MANIFEST.secretStore.adapter,
    );
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
    // The one state the wizard is reachable in today, and the one a
    // whole-document comparison could not express. Everything corrected here is
    // a fact the chart knows — the hostname above all, which is what makes a
    // passkey ceremony possible at all — and every genuine choice is left at its
    // stand-in. "Left" is generous: the schema has no optional keys, so this
    // document restates all four stand-ins by hand, which is why the case is
    // reachable rather than ordinary.
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

  // One row per conjunct, and four rows rather than one assertion because
  // dropping a single `&&` is invisible to everything else in this file: the
  // claim above reads the four values but never routes them through the
  // predicate, so it cannot watch the predicate stop reading one. Each row
  // answers exactly one genuine choice and asserts configured — the smallest act
  // that ends onboarding, which for the first row is an operator pressing
  // Continue on an edited name and nothing else.
  const answeringOne: readonly (readonly [string, AuthoredManifest])[] = [
    [
      'installation.name',
      {
        ...DEFAULT_PLACEHOLDER_MANIFEST,
        installation: {
          ...DEFAULT_PLACEHOLDER_MANIFEST.installation,
          name: 'offsite',
        },
      },
    ],
    [
      'github.clientId',
      {
        ...DEFAULT_PLACEHOLDER_MANIFEST,
        github: {
          ...DEFAULT_PLACEHOLDER_MANIFEST.github,
          clientId: 'Iv1.0000000000000000',
        },
      },
    ],
    [
      'supplyChain.registry',
      {
        ...DEFAULT_PLACEHOLDER_MANIFEST,
        supplyChain: {
          ...DEFAULT_PLACEHOLDER_MANIFEST.supplyChain,
          registry: ['ghcr.io/jonpulsifer'],
        },
      },
    ],
    [
      'secretStore.adapter',
      {
        ...DEFAULT_PLACEHOLDER_MANIFEST,
        secretStore: {
          ...DEFAULT_PLACEHOLDER_MANIFEST.secretStore,
          adapter: 'gcp-secret-manager',
        },
      },
    ],
  ];

  test.each(answeringOne)(
    'answering %s and nothing else is enough to leave onboarding',
    (_choice, manifest) => {
      expect(isUnconfiguredInstallation(manifest)).toBe(false);
    },
  );

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
