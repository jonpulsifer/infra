/**
 * Schema constraints and the desired-state row lock, checked against a real
 * Postgres. Each test gets its own migrated schema from the harness.
 */
import { describe, expect, test } from 'bun:test';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  configItems,
  PINNED_ENVIRONMENT,
  targets,
} from '../../src/db/schema.ts';
import type { CoreSignature } from '../../src/supply-chain/sign.ts';
import type { BackendProvenanceAssessment } from '../../src/supply-chain/verify.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();

async function seedPlacement() {
  const [app] = await database()
    .db.insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'repo' })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues())
    .returning();
  const [component] = await database()
    .db.insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  return { app: app!, component: component!, target: target! };
}

describe('component_target_desired: the unique key', () => {
  test('exists in the catalog as a UNIQUE constraint on (component_id, target_id)', async () => {
    // Grouped in JS: `array_agg` returns a Postgres array literal (`{a,b}`).
    const isolated = database();
    const rows = await isolated.client<
      { constraintName: string; columnName: string }[]
    >`
      SELECT tc.constraint_name AS "constraintName",
             kcu.column_name AS "columnName"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = ${isolated.schema}
        AND tc.table_name = 'component_target_desired'
        AND tc.constraint_type = 'UNIQUE'
    `;

    const byConstraint = new Map<string, string[]>();
    for (const row of rows) {
      const columns = byConstraint.get(row.constraintName) ?? [];
      columns.push(row.columnName);
      byConstraint.set(row.constraintName, columns);
    }

    const pairConstraint = [...byConstraint.values()].find(
      (columns) => columns.sort().join(',') === 'component_id,target_id',
    );
    expect(pairConstraint).toBeDefined();
  });

  test('rejects a second row for the same (component_id, target_id)', async () => {
    const { component, target } = await seedPlacement();

    await database()
      .db.insert(componentTargetDesired)
      .values({ componentId: component.id, targetId: target.id });

    // Drizzle's query builder is thenable but not a `Promise`, which `.rejects`
    // needs.
    await expect(
      Promise.resolve(
        database()
          .db.insert(componentTargetDesired)
          .values({ componentId: component.id, targetId: target.id }),
      ),
    ).rejects.toThrow();
  });
});

describe('component_target_desired: the locking read', () => {
  test('SELECT ... FOR UPDATE blocks a second concurrent transaction', async () => {
    const { component, target } = await seedPlacement();
    const [desired] = await database()
      .db.insert(componentTargetDesired)
      .values({ componentId: component.id, targetId: target.id })
      .returning();

    // Two connections, so each transaction is its own session.
    const holder = database().connect();
    const contender = database().connect();

    let lockAcquired: () => void;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    let releaseHold: () => void;
    const releaseHoldPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const holderTx = holder.begin(async (tx) => {
      await tx`
        SELECT * FROM component_target_desired WHERE id = ${desired!.id} FOR UPDATE
      `;
      lockAcquired();
      await releaseHoldPromise;
    });

    await lockAcquiredPromise;

    const contenderAttempt = contender.begin(async (tx) => {
      await tx`
        SELECT * FROM component_target_desired WHERE id = ${desired!.id} FOR UPDATE
      `;
      return 'acquired' as const;
    });

    const raceResult = await Promise.race([
      contenderAttempt.then(() => 'acquired' as const),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 1000),
      ),
    ]);

    expect(raceResult).toBe('timeout');

    releaseHold!();
    await holderTx;
    await expect(contenderAttempt).resolves.toBe('acquired');

    await holder.close();
    await contender.close();
  });
});

describe('config_items: the pinned environment', () => {
  test('defaults new rows to the pinned environment', async () => {
    const { component, target } = await seedPlacement();
    const [item] = await database()
      .db.insert(configItems)
      .values({ componentId: component.id, targetId: target.id, key: 'PORT' })
      .returning();
    expect(item!.environment).toBe(PINNED_ENVIRONMENT);
  });

  test('the pin is a database constraint, not just an app default', async () => {
    const { component, target } = await seedPlacement();
    await expect(
      Promise.resolve(
        database().db.insert(configItems).values({
          componentId: component.id,
          targetId: target.id,
          key: 'PORT',
          environment: 'staging',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('builds: assessed supply-chain evidence', () => {
  test('round-trips normalized provenance and the core signature', async () => {
    const { component } = await seedPlacement();
    const artifactDigest = `sha256:${'a'.repeat(64)}`;
    const bundleDigest = `sha256:${'b'.repeat(64)}`;
    const provenance: BackendProvenanceAssessment = {
      artifactDigest,
      bundleDigest,
      backend: 'hosted',
      builderId: 'https://github.com/example/build.yml',
      slsaVersion: '1.2',
      achievedLevel: 2,
      verifiedAt: '2024-06-01T00:00:00.000Z',
      envelope: { predicateType: 'https://slsa.dev/provenance/v1' },
    };
    const signature: CoreSignature = {
      artifactDigest,
      signer: 'gcpkms://example/signer',
      format: 'cosign',
      bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' },
      signedAt: '2024-06-01T00:00:01.000Z',
    };

    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: 'abc123',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest,
        status: 'SUCCEEDED',
        bundleDigest,
        provenance,
        verifiedBuildLevel: 2,
        signature,
        buildkitProvenanceRef: `${artifactDigest}.buildkit`,
        sbomRef: `${artifactDigest}.spdx`,
      })
      .returning();

    expect(build?.provenance).toEqual(provenance);
    expect(build?.verifiedBuildLevel).toBe(2);
    expect(build?.signature).toEqual(signature);
    expect(build?.buildkitProvenanceRef).toBe(`${artifactDigest}.buildkit`);
    expect(build?.sbomRef).toBe(`${artifactDigest}.spdx`);
  });
});
