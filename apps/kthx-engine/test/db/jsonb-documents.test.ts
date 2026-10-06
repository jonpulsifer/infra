/**
 * `jsonb` columns hold documents. A double-encoded value still round-trips
 * through Drizzle, so every assertion here reads the stored shape in SQL.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { creationDrafts, targets, users } from '../../src/db/schema.ts';
import { initialCreationDraft } from '../../src/domain/creation-draft.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const MIGRATION = join(
  import.meta.dir,
  '../../src/db/migrations/0016_jsonb_documents.sql',
);

/** Names a repository: a fresh draft has none for the nested read to find. */
const draftValues = () => {
  const draft = initialCreationDraft({
    targetId: crypto.randomUUID(),
    vessel: 'bluenose',
  });
  return {
    ...draft,
    source: { ...draft.source, repo: 'jonpulsifer/infra' },
  } as typeof draft;
};

async function seedOperator() {
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return user!;
}

/**
 * Migration 0016's statements, minus updates to columns a later migration
 * dropped. Any other undefined column still fails the test.
 */
async function migrationStatements() {
  const sql = await readFile(MIGRATION, 'utf8');
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  const present = await Promise.all(
    statements.map(async (statement) => {
      const target = /UPDATE\s+"(\w+)"\s+SET\s+"(\w+)"/.exec(statement);
      if (target === null) return true;
      const [found] = await database().client`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${target[1]!}
          AND column_name = ${target[2]!}`;
      return found !== undefined;
    }),
  );
  return statements.filter((_, index) => present[index]);
}

describe('jsonb columns store documents', () => {
  test('an object written through Drizzle is readable field by field in SQL', async () => {
    const user = await seedOperator();
    const draft = draftValues();
    const [row] = await database()
      .db.insert(creationDrafts)
      .values({ id: crypto.randomUUID(), userId: user.id, draft })
      .returning();

    const [stored] = await database().client`
      SELECT jsonb_typeof(draft) AS shape,
             draft->>'appName' AS app_name,
             draft->'source'->>'repo' AS repo
      FROM creation_drafts WHERE id = ${row!.id}`;

    expect(stored.shape).toBe('object');
    expect(stored.app_name).toBe(draft.appName);
    expect(stored.repo).toBe('jonpulsifer/infra');
  });

  test('an array column is a jsonb array, not a scalar and not a Postgres array', async () => {
    const [row] = await database()
      .db.insert(targets)
      .values(targetValues({ prerequisites: [{ name: 'VESSEL', met: true }] }))
      .returning();

    const [stored] = await database().client`
      SELECT jsonb_typeof(connection) AS connection_shape,
             jsonb_typeof(prerequisites) AS prerequisites_shape,
             jsonb_array_length(prerequisites) AS prerequisites_length,
             prerequisites->0->>'name' AS first_prerequisite
      FROM targets WHERE id = ${row!.id}`;

    expect(stored.connection_shape).toBe('object');
    expect(stored.prerequisites_shape).toBe('array');
    expect(stored.prerequisites_length).toBe(1);
    expect(stored.first_prerequisite).toBe('VESSEL');
  });

  test('an absent document is SQL NULL rather than a JSON null', async () => {
    const [row] = await database()
      .db.insert(targets)
      .values(targetValues())
      .returning();

    const [stored] = await database().client`
      SELECT discovery IS NULL AS sql_null, jsonb_typeof(discovery) AS shape
      FROM targets WHERE id = ${row!.id}`;

    // A JSON null would silently break every `IS NULL` predicate on the column.
    expect(stored.sql_null).toBe(true);
    expect(stored.shape).toBeNull();
    expect(row!.discovery).toBeNull();
  });
});

describe('migration 0016 unwraps what the old encoder wrote', () => {
  test('a double-encoded row becomes a document and still reads the same', async () => {
    const user = await seedOperator();
    const draft = draftValues();
    const id = crypto.randomUUID();

    // Drizzle's stock encoder stringified the document and Bun encoded that
    // string as JSON again.
    await database().client`
      INSERT INTO creation_drafts (id, user_id, draft)
      VALUES (${id}, ${user.id}, ${JSON.stringify(draft)})`;

    const [before] = await database().client`
      SELECT jsonb_typeof(draft) AS shape, draft->>'appName' AS app_name
      FROM creation_drafts WHERE id = ${id}`;
    expect(before.shape).toBe('string');
    expect(before.app_name).toBeNull();

    for (const statement of await migrationStatements()) {
      await database().client.unsafe(statement);
    }

    const [after] = await database().client`
      SELECT jsonb_typeof(draft) AS shape, draft->>'appName' AS app_name
      FROM creation_drafts WHERE id = ${id}`;
    expect(after.shape).toBe('object');
    expect(after.app_name).toBe(draft.appName);

    const [read] = await database()
      .db.select()
      .from(creationDrafts)
      .where(eq(creationDrafts.id, id));
    expect(read!.draft).toEqual(draft);
  });

  test('it is idempotent, and leaves an already-correct row alone', async () => {
    const user = await seedOperator();
    const draft = draftValues();
    const [row] = await database()
      .db.insert(creationDrafts)
      .values({ id: crypto.randomUUID(), userId: user.id, draft })
      .returning();

    for (const pass of [1, 2]) {
      for (const statement of await migrationStatements()) {
        await database().client.unsafe(statement);
      }
      const [stored] = await database().client`
        SELECT jsonb_typeof(draft) AS shape, draft->>'appName' AS app_name
        FROM creation_drafts WHERE id = ${row!.id}`;
      expect(`pass ${pass}: ${stored.shape}`).toBe(`pass ${pass}: object`);
      expect(stored.app_name).toBe(draft.appName);
    }
  });
});
