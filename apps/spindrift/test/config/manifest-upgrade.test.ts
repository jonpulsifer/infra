/**
 * A stored manifest written under an older schema is upgraded, never discarded.
 *
 * **This is the test that makes the next manifest schema change safe, not just
 * this one.** The stored row governs — `loadStoredManifest` resolves
 * `stored ?? declaration ?? placeholder` — and a row this build cannot parse is
 * a row this build treats as unseeded, so it re-seeds from the mounted
 * declaration and silently discards everything an operator configured through
 * the UI. Nothing used to fail when a schema change made that reachable. The
 * failure mode is quiet, it lands on a real installation, and the only signal
 * is a `console.warn` in a pod log nobody is reading during a rollout.
 *
 * So the corpus in `test/fixtures/stored-manifests/` holds one frozen snapshot
 * per shape a stored document has ever had, and every one of them has to boot.
 * Two rules keep it honest:
 *
 * 1. **A file in that directory is never edited.** It is a document that really
 *    was written to a real installation; editing it forward proves only that a
 *    document written today parses today.
 * 2. **The newest file must need no upgrade at all.** That is the forcing
 *    function: a schema change that stops accepting it fails here, and the
 *    only way to go green is to add the next snapshot and teach
 *    `manifest-upgrade.ts` the step between them.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuthoredManifest,
  InstallationManifest,
} from '../../src/config/manifest.schema.ts';
import {
  MANIFEST_INLINE_VAR,
  validateManifest,
} from '../../src/config/manifest.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import { upgradeManifestDocument } from '../../src/config/manifest-upgrade.ts';
import { installation } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const CORPUS = join(import.meta.dir, '../fixtures/stored-manifests');
const SNAPSHOTS = readdirSync(CORPUS)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

/** The declaration a re-seed would fall back to — a different installation. */
const DECLARATION = await Bun.file(
  join(import.meta.dir, '../fixtures/installation.example.yaml'),
).text();

/**
 * One snapshot, parsed fresh.
 *
 * Per call rather than once: these are handed to a write path, and a shared
 * parse would let one test's mutation reach the next.
 */
function snapshot(name: string): Record<string, unknown> {
  return Bun.YAML.parse(readFileSync(join(CORPUS, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

const database = withIsolatedDatabase();

describe('every stored manifest this project has ever written', () => {
  test.each(SNAPSHOTS)('%s boots without re-seeding', async (name) => {
    const document = snapshot(name);
    await database()
      .db.insert(installation)
      .values({ manifest: document as unknown as AuthoredManifest });

    // `bun:test`'s `spyOn` does not intercept `console.warn`, so this captures
    // it the plain way — the same shape `manifest-store.test.ts` uses.
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    let loaded: InstallationManifest;
    try {
      loaded = await loadStoredManifest(database().db, {
        // A declaration is mounted on purpose. Without one the re-seed path
        // throws instead of firing, and this test would pass on a build that
        // discards the row — which is the exact failure it exists to catch.
        [MANIFEST_INLINE_VAR]: DECLARATION,
      });
    } finally {
      console.warn = original;
    }

    // The document that was stored is the document that was loaded. If a schema
    // change made this row unreadable, `installation` would read `example` —
    // the declaration's — and everything the operator configured would be gone.
    expect(loaded.installation).toBe(document.installation as string);
    expect(warnings.filter((message) => message.includes('re-seeded'))).toEqual(
      [],
    );

    // Rewritten in place, and fully: what is on the row afterwards is a current
    // document, so the upgrade runs once rather than on every boot forever.
    const [row] = await database()
      .db.select({ manifest: installation.manifest })
      .from(installation);
    expect(() => validateManifest(row?.manifest, name)).not.toThrow();
    expect(upgradeManifestDocument(row?.manifest)).toEqual(
      row?.manifest as unknown,
    );
  });

  test('the newest snapshot is the shape this build writes, needing no upgrade', () => {
    const newest = SNAPSHOTS.at(-1);
    if (newest === undefined) throw new Error('the corpus is empty');
    const document = snapshot(newest);

    // Read the failure, not just the assertion: if this fails, the manifest
    // schema stopped accepting the document shape currently in production.
    // Copy `${newest}` to the next number, edit the copy to the new shape, and
    // add the step to `manifest-upgrade.ts`. Editing `${newest}` in place makes
    // this green and leaves every real installation on the old shape one boot
    // away from being silently re-seeded.
    expect(upgradeManifestDocument(document)).toEqual(document);
    expect(() => validateManifest(document, newest)).not.toThrow();
  });

  test('the oldest snapshot is genuinely refused without the upgrade', () => {
    // The premise. Without it the corpus proves nothing — a document nothing
    // would have rejected is not evidence that an upgrade is load-bearing.
    const oldest = SNAPSHOTS.at(0);
    if (oldest === undefined) throw new Error('the corpus is empty');
    expect(upgradeManifestDocument(snapshot(oldest))).not.toEqual(
      snapshot(oldest),
    );
  });
});

describe('the vessels a pre-declaration document is upgraded into', () => {
  const document = snapshot('01-suffix-paired-vessels.yaml');

  test('are the ones the seeding path used to derive on every boot', () => {
    // The same names, the same locations, and the same union of what two
    // surfaces of one boundary each claimed — so an installation upgraded here
    // keeps the vessel rows it already has rather than growing a second set.
    const upgraded = upgradeManifestDocument(document) as {
      vessels: unknown[];
    };
    expect(upgraded.vessels).toEqual([
      {
        name: 'cluster',
        kind: 'cluster',
        location: { apiServer: 'https://cluster.example.test' },
        servedHosts: ['apps.example.test'],
        reachableRegistries: ['registry.example.test'],
      },
      {
        name: 'cloud',
        kind: 'gcp-project',
        location: { project: 'example-vessel' },
        // The union, not a winner: the two surfaces stated different hosts and
        // taking one would be the bug the vessel exists to prevent.
        servedHosts: ['hosting.example.test', 'run.example.test'],
        reachableRegistries: ['mirror.example.test'],
      },
    ]);
  });

  test('leave the Targets in order, carrying only their own surface', () => {
    // Rank is read from this array's order, so a rewrite that reordered it
    // would silently re-rank the installation. `01` predates the
    // `dropTargetNames` step too, so the chained upgrade also takes the
    // constructed `name` off every entry — asserted below as its own claim
    // rather than folded into this array, since that is the newer step's
    // whole job.
    const upgraded = upgradeManifestDocument(document) as {
      targets: { vessel: string; adapter: string; connection?: object }[];
    };
    expect(
      upgraded.targets.map((target) => [target.vessel, target.adapter]),
    ).toEqual([
      ['cluster', 'kubernetes'],
      ['cloud', 'cloudrun'],
      ['cloud', 'static'],
    ]);
    for (const target of upgraded.targets) {
      expect(target).not.toHaveProperty('name');
      expect(Object.keys(target.connection ?? {})).not.toContain('apiServer');
      expect(Object.keys(target.connection ?? {})).not.toContain('project');
      expect(Object.keys(target.connection ?? {})).not.toContain('servedHosts');
      expect(Object.keys(target.connection ?? {})).not.toContain(
        'reachableRegistries',
      );
    }
  });

  test('is a no-op on a document that already declares them', () => {
    // `02` now upgrades too — `dropTargetNames` still takes its constructed
    // `name` off every entry. `03` is the shape with neither gap, so this is
    // where "already current" moved.
    const current = snapshot('03-target-is-vessel-and-surface.yaml');
    expect(upgradeManifestDocument(current)).toEqual(current);
  });
});
