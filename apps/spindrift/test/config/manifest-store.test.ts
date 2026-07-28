import { describe, expect, test } from 'bun:test';
import type { InstallationManifest } from '../../src/config/manifest.schema.ts';
import {
  MANIFEST_INLINE_VAR,
  ManifestError,
} from '../../src/config/manifest.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import { createDb } from '../../src/db/client.ts';
import { installation } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const FIXTURE = new URL(
  '../fixtures/installation.example.yaml',
  import.meta.url,
);
const fixtureText = await Bun.file(FIXTURE).text();
const fixtureManifest = Bun.YAML.parse(fixtureText) as InstallationManifest;

describe('the stored installation manifest', () => {
  test('bootstraps once, then boots from the database alone', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(first.installation).toBe('example');

    const later = await loadStoredManifest(database().db, {});
    expect(later).toEqual(first);
  });

  test('the database wins over changed bootstrap configuration', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const changed = fixtureText.replace(
      'installation: example',
      'installation: replacement',
    );

    const later = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });
    expect(later).toEqual(first);
    expect(later.installation).toBe('example');
  });

  test('simultaneous processes converge on the one winning bootstrap', async () => {
    const contender = createDb(database().connect());
    const replacement = fixtureText.replace(
      'installation: example',
      'installation: replacement',
    );

    const [first, second] = await Promise.all([
      loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: fixtureText,
      }),
      loadStoredManifest(contender, {
        [MANIFEST_INLINE_VAR]: replacement,
      }),
    ]);
    expect(second).toEqual(first);
    expect(['example', 'replacement']).toContain(first.installation);
  });

  test('the database enforces that there is only one installation', async () => {
    await database()
      .db.insert(installation)
      .values({ manifest: fixtureManifest });

    await expect(
      Promise.resolve(
        database()
          .db.insert(installation)
          .values({ id: 2, manifest: fixtureManifest }),
      ),
    ).rejects.toThrow();
  });

  test('fails closed when the stored document is malformed', async () => {
    const malformed = JSON.stringify({ installation: 'broken' });
    await database().client`
      INSERT INTO installation (manifest)
      VALUES (${malformed}::jsonb)
    `;

    await expect(loadStoredManifest(database().db, {})).rejects.toThrow(
      /database installation manifest/,
    );
  });

  test('fails loudly when the database is empty and no bootstrap exists', async () => {
    await expect(loadStoredManifest(database().db, {})).rejects.toThrow(
      ManifestError,
    );
  });
});
