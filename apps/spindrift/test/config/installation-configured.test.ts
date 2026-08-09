/**
 * Which application an operator is shown, decided by one predicate.
 *
 * `isUnconfiguredInstallation` is the whole of that decision: false renders the
 * product, true replaces it with a four-question wizard.
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
 * **A false positive replaces a working installation with a wizard**, which is
 * the direction the per-conjunct claims below guard: dropping one conjunct from
 * an `&&` widens what counts as configured, so each genuine choice gets its own
 * claim, answering that choice alone and asserting configured — a conjunct that
 * stops being read is a red build rather than a silent widening.
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
