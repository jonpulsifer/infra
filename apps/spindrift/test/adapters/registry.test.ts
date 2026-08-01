/**
 * Production adapter wiring that is not an adapter behavior of its own.
 *
 * The installer deliberately projects a token outside Kubernetes' default
 * service-account path. The registry must follow that declared path while still
 * reading the rotating file at request time.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createAdapterRegistry,
  IDENTITY_TOKEN_PATH_VAR,
  installationServiceAccountToken,
} from '../../src/adapters/registry.ts';
import { parseManifest } from '../../src/config/manifest.ts';

test('the installation token provider follows the projected path', async () => {
  const path = join('/tmp', `spindrift-identity-token-${crypto.randomUUID()}`);
  await Bun.write(path, 'first-token\n');

  try {
    const token = installationServiceAccountToken({
      [IDENTITY_TOKEN_PATH_VAR]: path,
    });
    expect(await token()).toBe('first-token');

    await Bun.write(path, 'rotated-token\n');
    expect(await token()).toBe('rotated-token');
  } finally {
    await Bun.file(path).delete();
  }
});

test('source adapter returns null when no GitHub App or custom stager is configured', async () => {
  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const manifest = parseManifest(yaml, 'test');
  const registry = createAdapterRegistry({ manifest, env: {} });

  expect(registry.source?.()).toBeNull();
});

test('source adapter returns explicitly passed source stager when provided', async () => {
  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const manifest = parseManifest(yaml, 'test');
  const customStager = {
    async stageRepository() {
      return {
        digest: 'sha256:custom',
        location: 'custom://location',
        retention: 'ephemeral' as const,
      };
    },
  };

  const registry = createAdapterRegistry({
    manifest,
    env: {},
    source: customStager,
  });

  expect(registry.source?.()).toBe(customStager);
});
