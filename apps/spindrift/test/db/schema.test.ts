/**
 * The schema acceptance test (Task 5). Two things are load-bearing here and
 * must be proven against a real Postgres, not merely trusted from the DDL:
 *
 * 1. The desired-state row (`component_target_desired`, §6/§12) actually
 *    carries a UNIQUE constraint on `(component_id, target_id)` — checked
 *    against the catalog, and then by trying to violate it.
 * 2. `SELECT ... FOR UPDATE` on that row genuinely blocks a second
 *    transaction. This is proven with two independent connections and a
 *    timeout race — a test that would pass even if the lock did nothing is
 *    not a test of the lock.
 *
 * Each test runs in its own migrated Postgres schema, handed out by the
 * harness (`test/harness/db.ts`), so this file can run beside any other
 * without either seeing the other's rows.
 */
import { describe, expect, test } from 'bun:test';
import {
  apps,
  components,
  componentTargetDesired,
  configItems,
  PINNED_ENVIRONMENT,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

/** Insert the App -> Component -> Target chain a desired-state row needs. */
async function seedPlacement() {
  const [app] = await database()
    .db.insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'repo' })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values({
      name: `target-${crypto.randomUUID()}`,
      adapter: 'kubernetes',
      rank: 0,
    })
    .returning();
  const [component] = await database()
    .db.insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  return { app: app!, component: component!, target: target! };
}

describe('component_target_desired: the unique key', () => {
  test('exists in the catalog as a UNIQUE constraint on (component_id, target_id)', async () => {
    // One row per (constraint, column) — grouped in JS rather than with
    // `array_agg`, whose Postgres array-literal result (`{a,b}`) is not a JS
    // array and would make the shape assertion below lie.
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

    // Drizzle's query builder is thenable but not a real `Promise`
    // instance; `expect(...).rejects` needs the latter.
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

    // Two independent connections, not two checkouts sharing a pool's
    // notion of "the same" transaction — each one is its own real session.
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

    // The assertion that matters: the second transaction did NOT get the
    // row inside the timeout window, because the first still holds it.
    expect(raceResult).toBe('timeout');

    releaseHold!();
    await holderTx;
    // Now that the lock is released, the contender's own attempt resolves.
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
