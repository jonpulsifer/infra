/**
 * `readStoredManifest` validates the stored row against the `.strict()` schema,
 * so a key dropped from the schema must be migrated out of stored documents or
 * every process fails at boot.
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

/** The placeholder manifest plus the `chartContract` key the schema dropped. */
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
    // Without this refusal the next test proves nothing.
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
    // `reconcileManifestTargets` ranks Targets by their order in this array.
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
