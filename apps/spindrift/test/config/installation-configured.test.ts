/**
 * `isUnconfiguredInstallation` chooses between the product and the onboarding
 * wizard. Answering any one genuine choice must count as configured.
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
    // Only facts the chart knows differ from the placeholder, and every genuine
    // choice keeps its stand-in.
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

  // One row per conjunct, so dropping any `&&` from the predicate fails a row.
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
    // `supplyChain.registry` parses a bare string to a list, so both spellings
    // are the stand-in.
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
