/**
 * Adopting the mounted declaration onto the stored row (ticket 78).
 *
 * `getInstallationManifest` and `configureInstallation` already round-trip a
 * whole document — `installation-round-trip.test.ts` proves that pair. What
 * neither of those files proves is that a *declaration* is one of the
 * documents that can ride that pair: before this ticket, `manifestDivergence`
 * (now `declarationDivergence`) named only the paths a mounted declaration
 * disagreed at, and the declaration itself never left the process that read
 * it. An operator who wanted to adopt it had nothing to send.
 *
 * Two claims:
 *
 * 1. **`getInstallationManifest` answers the declaration as a document**, the
 *    same `AuthoredManifest` shape `manifest` is and `configureInstallation`
 *    accepts — not only the list of paths it differs at.
 * 2. **Sending that document straight to `configureInstallation` — with no
 *    assembly of the caller's own — clears the divergence.** This is
 *    criterion 2's mechanism, proven against a hand-built divergence rather
 *    than the live offsite installation: nothing in this repository can
 *    reach that installation, and the ticket says so.
 */
import { describe, expect, test } from 'bun:test';
import {
  configureInstallation,
  getInstallationManifest,
} from '../../src/commands/index.ts';
import type { Clock, CommandContext } from '../../src/commands/types.ts';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import { diffManifestPaths } from '../../src/config/manifest-store.ts';
import { installation } from '../../src/db/schema.ts';
import { withValueAt } from '../../src/web/forms/document.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const fixture = await authoredFixture();
const resolved = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/**
 * A context for the fixture installation, with `declaration` and
 * `declarationDivergence` set the way `serve.ts` sets them — by hand here,
 * because this file's claim is about what a command does with those two
 * fields, not about how `serve.ts` computes them (`installation-surface.test.ts`
 * already drives the real route table for that half).
 */
function context(extra: Partial<CommandContext> = {}): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    manifest: resolved,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => null,
      repository: () => null,
      supplyChain: () => {
        throw new Error('adopting a declaration reached the supply chain');
      },
    } as unknown as CommandContext['adapters'],
    ...extra,
  };
}

async function seed(manifest: AuthoredManifest): Promise<void> {
  await database()
    .db.insert(installation)
    .values({ id: 1, manifest })
    .onConflictDoUpdate({ target: installation.id, set: { manifest } });
}

async function storedManifest(): Promise<AuthoredManifest> {
  const [row] = await database().db.select().from(installation);
  if (row === undefined) throw new Error('no installation row');
  return row.manifest as AuthoredManifest;
}

/** A declaration that diverges from `fixture` at one path. */
function divergentDeclaration(): AuthoredManifest {
  return withValueAt(
    fixture,
    ['build', 'zeroConfigFrontend'],
    'registry.example.test/zero-config:merged',
  ) as AuthoredManifest;
}

describe('reading the mounted declaration', () => {
  test('answers it as a document, not only the paths it differs at', async () => {
    await seed(fixture);
    const declaration = divergentDeclaration();

    const result = await getInstallationManifest(
      {},
      context({
        declaration,
        declarationDivergence: diffManifestPaths(declaration, fixture),
      }),
    );
    if (!result.ok) throw new Error('getInstallationManifest refused');

    // Whole, not a projection: an adopt action forwards this value straight
    // to `configureInstallation`, so a reader that dropped a key here would
    // make an adopt press delete it.
    expect(result.value.declaration).toEqual(declaration);
    expect(result.value.declarationDivergence).toEqual([
      'build.zeroConfigFrontend',
    ]);
  });

  test('a context with no declaration answers null and no paths', async () => {
    await seed(fixture);
    const result = await getInstallationManifest({}, context());
    if (!result.ok) throw new Error('getInstallationManifest refused');
    expect(result.value.declaration).toBeNull();
    expect(result.value.declarationDivergence).toEqual([]);
  });
});

describe('adopting the declaration', () => {
  test('sending what the read answered clears the divergence', async () => {
    await seed(fixture);
    const declaration = divergentDeclaration();

    // What the surface does, in order: read the declaration off
    // `getInstallationManifest`, then send exactly that value to
    // `configureInstallation`. No path from `declarationDivergence` is
    // touched — the whole document travels, per §20's "the whole document or
    // nothing" rule cited in `configure.ts`.
    const read = await getInstallationManifest(
      {},
      context({
        declaration,
        declarationDivergence: diffManifestPaths(declaration, fixture),
      }),
    );
    if (!read.ok) throw new Error('getInstallationManifest refused');
    expect(read.value.declarationDivergence.length).toBeGreaterThan(0);

    const written = await configureInstallation(
      { manifest: read.value.declaration },
      context(),
    );
    expect(written.ok).toBe(true);

    const stored = await storedManifest();
    expect(stored.build.zeroConfigFrontend).toBe(
      'registry.example.test/zero-config:merged',
    );

    // Criterion 2's whole claim, mechanically: re-reading against the row the
    // write just left answers no divergence, because the declaration and the
    // stored manifest now agree at the path that used to separate them.
    const after = await getInstallationManifest(
      {},
      context({
        declaration,
        declarationDivergence: diffManifestPaths(declaration, stored),
      }),
    );
    if (!after.ok) throw new Error('getInstallationManifest refused');
    expect(after.value.declarationDivergence).toEqual([]);
  });
});
