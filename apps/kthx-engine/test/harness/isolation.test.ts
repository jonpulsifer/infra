import { afterAll, describe, expect, test } from 'bun:test';
import { apps } from '../../src/db/schema.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './db.ts';

const opened: IsolatedDatabase[] = [];

async function isolated(): Promise<IsolatedDatabase> {
  const database = await createIsolatedDatabase();
  opened.push(database);
  return database;
}

afterAll(async () => {
  for (const database of opened) await database.close();
});

describe('two isolated databases', () => {
  test('do not see each other’s rows', async () => {
    const [left, right] = await Promise.all([isolated(), isolated()]);

    expect(left.schema).not.toBe(right.schema);

    // Interleaved, so one shared schema truncated between tests would fail.
    await left.db.insert(apps).values({ name: 'left', sourceKind: 'archive' });
    await right.db
      .insert(apps)
      .values({ name: 'right', sourceKind: 'archive' });
    await left.db
      .insert(apps)
      .values({ name: 'left-two', sourceKind: 'archive' });

    const leftRows = await left.db.select({ name: apps.name }).from(apps);
    const rightRows = await right.db.select({ name: apps.name }).from(apps);

    expect(leftRows.map((row) => row.name).sort()).toEqual([
      'left',
      'left-two',
    ]);
    expect(rightRows.map((row) => row.name)).toEqual(['right']);
  });

  test('each carries its own migrated tables, not the ones next door', async () => {
    const database = await isolated();
    const [row] = await database.client`
      SELECT count(*)::int AS tables
      FROM information_schema.tables
      WHERE table_schema = ${database.schema}
    `;
    expect(row.tables).toBeGreaterThan(5);
  });

  test('a dropped schema takes its rows with it', async () => {
    const database = await createIsolatedDatabase();
    await database.db
      .insert(apps)
      .values({ name: 'gone', sourceKind: 'archive' });
    const schema = database.schema;
    await database.close();

    const [row] = await opened[0]!.client`
      SELECT count(*)::int AS present
      FROM information_schema.schemata
      WHERE schema_name = ${schema}
    `;
    expect(row.present).toBe(0);
  });
});
