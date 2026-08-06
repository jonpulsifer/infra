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
import { configureInstallation } from '../../src/commands/index.ts';
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
      dns: { zones: { ...manifest.dns.zones, private: '' } },
    };

    const result = await configureInstallation(
      { manifest: invalid },
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain('installation');
      expect(result.failure.message).toContain('zones.private');
    }
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
