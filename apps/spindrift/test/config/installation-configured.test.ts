/**
 * Which application an operator is shown, decided by one predicate.
 *
 * `isUnconfiguredInstallation` is the whole of that decision: false renders the
 * product, true replaces it with a three-question wizard. The two directions are
 * not symmetric and neither is what a test owes them.
 *
 * **A false positive replaces a working installation with a wizard.** There is
 * no declaration in this repository to read any more — configuration is the
 * row's — so what is asserted is the predicate's shape rather than one
 * installation's document: each genuine choice, answered alone, is enough to
 * make an installation configured.
 *
 * **A false negative is a wizard nobody can reach.** That used to be the whole
 * of the placeholder's problem: the relying party came out of the document, so
 * an unconfigured installation was served at `spindrift.example.com` and no
 * browser would run a passkey ceremony against it. The relying party is a
 * deployment fact now, so every installation is served at its own origin and
 * this predicate's `true` is reachable by construction.
 *
 * **Each conjunct gets its own claim**, because dropping one from an `&&` is the
 * false-positive direction and the three-value assertion below cannot see it: it
 * reads the values, never the predicate. One claim per genuine choice, each
 * answering that choice alone and asserting configured, is what makes a conjunct
 * that stops being read a red build rather than a silent widening.
 */
import { describe, expect, test } from 'bun:test';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  isUnconfiguredInstallation,
  validateManifest,
} from '../../src/config/manifest.ts';

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
    // document restates all three stand-ins by hand, which is why the case is
    // reachable rather than ordinary.
    const seeded = {
      ...DEFAULT_PLACEHOLDER_MANIFEST,
      controlPlane: { hostname: 'spindrift.substituted.example' },
      dns: {
        zones: [
          { name: 'substituted.example', reaches: ['private', 'public'] },
        ],
      },
      charts: { app: 'oci://ghcr.io/example/charts/spindrift-app' },
    };

    expect(isUnconfiguredInstallation(validateManifest(seeded, 'a seed'))).toBe(
      true,
    );
  });

  // One row per conjunct, and three rows rather than one assertion because
  // dropping a single `&&` is invisible to everything else in this file: the
  // claim above reads the three values but never routes them through the
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
