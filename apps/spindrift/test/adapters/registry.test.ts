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
import { parseManifest, resolveManifest } from '../../src/config/manifest.ts';
import { FakeGcpDiscovery } from '../harness/fakes/gcp-discovery-api.ts';

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
  const manifest = await resolveManifest(parseManifest(yaml, 'test'), {});
  const registry = createAdapterRegistry({ manifest, env: {} });

  expect(registry.source?.()).toBeNull();
});

test('source adapter returns explicitly passed source stager when provided', async () => {
  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const manifest = await resolveManifest(parseManifest(yaml, 'test'), {});
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

/**
 * Discovery is a fourth consumer of the one federated provider, not a fourth
 * credential.
 *
 * The property worth asserting is not that the lookup answers something — it is
 * *which* token the request carries. `src/storage/cloud.ts` shows the other
 * shape: a second `workloadIdentityToken` constructed per call, which re-runs
 * the STS and impersonation exchange every time and defeats the cache in
 * `deploy/cloud/federation.ts`. A discovery client wired that way would pass
 * every fold assertion in `test/commands/installation-discover.test.ts` and
 * still be the wrong wiring.
 */
test('discovery reaches the cloud with the registry-wide token', async () => {
  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const manifest = await resolveManifest(parseManifest(yaml, 'test'), {});
  const fake = new FakeGcpDiscovery({
    token: 'the-registry-token',
    projects: ['example-home'],
  });

  const registry = createAdapterRegistry({
    manifest,
    env: {},
    cloudToken: () => 'the-registry-token',
    fetch: fake.fetch,
  });

  const discovery = registry.discovery?.() ?? null;
  expect(discovery).not.toBeNull();
  expect(await discovery?.projects()).toEqual({
    kind: 'found',
    candidates: ['example-home'],
    suggested: 'example-home',
  });
  expect(fake.requests.map((request) => request.authorization)).toEqual([
    'Bearer the-registry-token',
  ]);
});

/**
 * The cloud store's access path is the federation, not a stored bearer.
 *
 * `SPINDRIFT_STORE_TOKEN` is a long-lived token an operator issues for
 * 1Password Connect. A Google access token expires in an hour and is minted
 * from the token this pod already projects, so an installation on Secret
 * Manager reading its credential out of the installation Secret would write
 * with a value that is stale before the second write — and the symptom is a
 * `401` on config, a verb nothing else exercises, long after the deploy that
 * introduced it.
 *
 * Asserted as *which* token the request carries, for the reason discovery is
 * above: a store wired to the wrong provider still constructs, and every
 * assertion that does not look at the wire passes.
 */
test('the cloud store writes with the federated token, not a stored one', async () => {
  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const manifest = await resolveManifest(parseManifest(yaml, 'test'), {});
  expect(manifest.secretStore.adapter).toBe('gcp-secret-manager');

  const authorizations: (string | null)[] = [];
  const registry = createAdapterRegistry({
    manifest,
    // Empty: an installation on Secret Manager needs no store token at all, and
    // a store that fell back to one would refuse here rather than federate.
    env: {},
    cloudToken: () => 'the-federated-token',
    fetch: async (request) => {
      authorizations.push(request.headers.get('authorization'));
      return new Response(null, { status: 404 });
    },
  });

  const store = registry.store('gcp-secret-manager');
  expect(store).not.toBeNull();
  await store?.describe({ key: 'shop--web--cluster--TOKEN', version: '1' });

  expect(authorizations).toEqual(['Bearer the-federated-token']);
});
