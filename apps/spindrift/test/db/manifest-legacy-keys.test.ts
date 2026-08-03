/**
 * The stored manifest and the strict schema have to stay in agreement.
 *
 * `manifest.schema.ts` is `.strict()` and `readStoredManifest` parses the
 * **database row** through it, so removing a key from the schema without
 * removing it from documents already written under the old one is a boot
 * failure, not a degraded read: `validateManifest` throws, and every process
 * calls it before it can serve. Dropping `chartContract` was exactly that
 * shape — the ConfigMap and the schema lost the key while the row that
 * actually governs (`stored ?? declaration`) kept it.
 *
 * These tests run the **committed migration file** rather than a copy of its
 * statement, so they fail if the file is edited or deleted, and they assert the
 * property that matters rather than the mechanism: a document written under the
 * old schema is accepted by the new one after migrating.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  validateManifest,
} from '../../src/config/manifest.ts';
import { installation } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const MIGRATION = join(
  import.meta.dir,
  '../../src/db/migrations/0024_drop_chart_contract.sql',
);

/**
 * A manifest as it was authored before `chartContract` was removed. Built from
 * the placeholder so it stays a real document — every other key has to survive
 * the rewrite, and a hand-rolled stub would not notice if they did not.
 */
function legacyDocument(): Record<string, unknown> {
  const document = structuredClone(
    DEFAULT_PLACEHOLDER_MANIFEST,
  ) as unknown as Record<string, unknown>;
  const targets = document.targets as Record<string, unknown>[];
  for (const target of targets) {
    const connection = target.connection as Record<string, unknown> | undefined;
    if (connection) connection.chartContract = '3';
  }
  return document;
}

const database = withIsolatedDatabase();

describe('a manifest written under the previous schema', () => {
  test('is refused by the strict schema while it still carries chartContract', () => {
    // The premise. Without this the next test proves nothing — a migration that
    // strips a key nobody would have rejected is not load-bearing.
    expect(() => validateManifest(legacyDocument(), 'legacy document')).toThrow(
      /chartContract/,
    );
  });

  test('is accepted once the committed migration has stripped the key', async () => {
    const { db, client } = database();
    const document = legacyDocument();
    await db.insert(installation).values({
      manifest: document as unknown as AuthoredManifest,
    });

    await client.unsafe(await Bun.file(MIGRATION).text());

    const [row] = await db
      .select({ manifest: installation.manifest })
      .from(installation);
    expect(() =>
      validateManifest(row?.manifest, 'migrated document'),
    ).not.toThrow();
  });

  test('keeps every Target, in order, because rank is read from that order', async () => {
    // `reconcileManifestTargets` derives a Target's rank from its position in
    // this array, so an aggregate that dropped or reordered an element would
    // silently re-rank the installation.
    const { db, client } = database();
    const document = legacyDocument();
    const before = (document.targets as { name: string }[]).map((t) => t.name);
    await db.insert(installation).values({
      manifest: document as unknown as AuthoredManifest,
    });

    await client.unsafe(await Bun.file(MIGRATION).text());

    const [row] = await db
      .select({ manifest: installation.manifest })
      .from(installation);
    expect(row).toBeDefined();
    const migrated = row?.manifest as unknown as {
      targets: { name: string }[];
    };
    expect(migrated.targets.map((t) => t.name)).toEqual(before);
  });
});
