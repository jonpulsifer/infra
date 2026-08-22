/**
 * `configureInstallation` (§20, ticket 32).
 *
 * The act this command exists for is the one nothing could do before it: change
 * a value in the installation manifest without destroying the database. So the
 * assertions here are about the row and the Target table, not the return value —
 * a command that reported a manifest it never stored would pass a test of its
 * own output.
 *
 * The refusals matter as much as the writes. A manifest is valid or it is not,
 * and an installation that accepted a half-valid one could reach the point
 * where it places a workload with a key missing.
 */
import { describe, expect, test } from 'bun:test';
import { configureInstallation } from '../../src/commands/installation/configure.ts';
import type { Clock, CommandContext } from '../../src/commands/types.ts';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import { installation } from '../../src/db/schema.ts';
import { targetLabel } from '../../src/domain/target.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
// The document an operator writes; `resolved` is what a context carries.
const manifest = await authoredFixture();
const resolved = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    manifest: resolved,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => {
        throw new Error('configuring an installation reached the store');
      },
      repository: () => null,
      supplyChain: () => {
        throw new Error('configuring an installation reached the supply chain');
      },
    } as unknown as CommandContext['adapters'],
  };
}

async function storedManifest(): Promise<AuthoredManifest | undefined> {
  const [row] = await database().db.select().from(installation);
  return row?.manifest;
}

describe('configuring an installation', () => {
  test('writes a value nothing else could change', async () => {
    await seed();
    const retuned = {
      ...manifest,
      build: {
        ...manifest.build,
        zeroConfigFrontend: 'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
      },
    } satisfies AuthoredManifest;

    const result = await configureInstallation(
      { manifest: retuned },
      context(),
    );

    expect(result.ok).toBe(true);
    expect((await storedManifest())?.build.zeroConfigFrontend).toBe(
      'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
    );
  });

  test('reconciles the Targets the written manifest declares', async () => {
    await seed();
    // The act that can create a Target without anyone naming one. A write that
    // skipped reconciliation would leave it declared and absent.
    const rows = await database().db.query.targets.findMany({
      with: { vessel: true },
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map((row) =>
        targetLabel({ vessel: row.vessel.name, adapter: row.adapter }),
      ),
    ).toEqual(manifest.targets.map((target) => targetLabel(target)));

    const result = await configureInstallation({ manifest }, context());
    expect(result.ok).toBe(true);
    expect((result.ok ? result.value.targets : []).slice()).toEqual(
      manifest.targets.map((target) => targetLabel(target)),
    );
  });

  test('refuses an invalid manifest and names every offending key at once', async () => {
    await seed();
    const invalid = {
      ...manifest,
      installation: '',
      dns: { zones: [{ name: '', reaches: ['private', 'public'] }] },
    };

    const result = await configureInstallation(
      { manifest: invalid },
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain('installation');
      expect(result.failure.message).toContain('zones.0.name');
    }
  });

  test('refuses header authentication this deployment cannot enforce', async () => {
    await seed();
    // The process cannot see a NetworkPolicy from inside its own pod, so
    // `auth.gateway` is refused at boot without the deployment's attestation.
    // Taking it here would store a document that wedges the web process at its
    // next restart — hours later, with nothing connecting the two.
    const result = await configureInstallation(
      {
        manifest: {
          ...manifest,
          auth: {
            gateway: {
              adapterKey: 'front-door',
              issuer: 'https://issuer.example.test',
              subjectHeader: 'x-auth-request-subject',
            },
          },
        },
      },
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_DEPLOYABLE');
      expect(result.failure.message).toContain(
        'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY',
      );
    }
    expect((await storedManifest())?.auth.gateway).toBeNull();
  });

  test('takes it on a deployment that attests the boundary', async () => {
    await seed();
    const gateway = {
      adapterKey: 'front-door',
      issuer: 'https://issuer.example.test',
      subjectHeader: 'x-auth-request-subject',
    };

    const result = await configureInstallation(
      { manifest: { ...manifest, auth: { gateway } } },
      {
        ...context(),
        manifest: { ...resolved, boundary: { trustedGateway: true } },
      },
    );

    expect(result.ok).toBe(true);
    expect((await storedManifest())?.auth.gateway).toEqual(gateway);
  });

  test('refuses a store whose adapter has no address to assume', async () => {
    await seed();
    // `onepassword` Connect is self-hosted, so there is no default endpoint.
    // The store constructor already throws on this pair — but it throws on the
    // *next* command, after the write has landed, so the schema is where the
    // operator has to meet it.
    const result = await configureInstallation(
      { manifest: { ...manifest, secretStore: { adapter: 'onepassword' } } },
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain('secretStore.endpoint');
    }
  });

  test('restores a document handed over as text', async () => {
    await seed();
    // The other half of the export: a file this installation wrote, read back
    // through the same parser every other document goes through. YAML, and
    // therefore the JSON the download emits.
    const restored = {
      ...manifest,
      installation: { ...manifest.installation, name: 'restored' },
    };

    const result = await configureInstallation(
      { manifest: JSON.stringify(restored) },
      context(),
    );

    expect(result.ok).toBe(true);
    expect((await storedManifest())?.installation.name).toBe('restored');
  });

  test('refuses text that is not a document at all', async () => {
    await seed();
    const before = await storedManifest();

    const result = await configureInstallation(
      { manifest: '\tthis: [is not\n  yaml' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('INVALID_INPUT');
    expect(await storedManifest()).toEqual(before);
  });

  test('leaves the stored manifest alone when it refuses', async () => {
    await seed();
    const before = await storedManifest();

    await configureInstallation(
      { manifest: { ...manifest, installation: '' } },
      context(),
    );

    expect(await storedManifest()).toEqual(before);
  });
});

async function seed(): Promise<void> {
  await loadStoredManifest(database().db, {
    SPINDRIFT_MANIFEST: JSON.stringify(manifest),
  });
}
