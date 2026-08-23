/**
 * The settings surface's read/write pair round-trips (§20, ticket 32).
 *
 * `getInstallationManifest` and `configureInstallation` are halves of one act:
 * an editing surface reads the document it is about to replace, and
 * `configureInstallation` takes the whole document rather than a patch. So what
 * the read answers must be something the write accepts — and, before that,
 * something the *form* accepts, because the form validates client-side against
 * the same strict schema and refuses without ever dispatching.
 *
 * That is the bug this file pins. A reader is handed the resolved manifest —
 * the authored document plus the deployment facts joined around it — and the
 * schema is `.strict()`, so answering it unprojected made the form refuse its
 * own round trip with `cloud: Unrecognized key: "federation"` on a field it
 * never rendered. Live, the operator saw "This manifest is not valid, so
 * nothing was written" and the only way to correct a value was to edit Postgres
 * by hand, which is the exact act ticket 32 exists to abolish.
 *
 * The assertions go through `manifestIssues` rather than the schema directly:
 * that is the function the screen actually calls, so a fix that satisfied the
 * schema but not the form would still fail here.
 */
import { describe, expect, test } from 'bun:test';
import { configureInstallation } from '../../src/commands/installation/configure.ts';
import { getInstallationManifest } from '../../src/commands/installation/get.ts';
import type { Clock, CommandContext } from '../../src/commands/types.ts';
import { installationManifestSchema } from '../../src/config/manifest.schema.ts';
import { installation } from '../../src/db/schema.ts';
import { manifestIssues } from '../../src/web/forms/manifest.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const _declaration = await authoredFixture();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    manifest,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => {
        throw new Error('reading the manifest reached the store');
      },
      repository: () => null,
      supplyChain: () => {
        throw new Error('reading the manifest reached the supply chain');
      },
    } as unknown as CommandContext['adapters'],
  };
}

async function seed(): Promise<void> {
  const { cloud: _derived, ...authored } = manifest;
  await database()
    .db.insert(installation)
    .values({ id: 1, manifest: authored })
    .onConflictDoNothing();
}

describe('the installation settings round trip', () => {
  test('the context manifest carries the derived key this guards against', () => {
    // If federation ever stops being joined onto a reader's manifest, this test
    // would pass vacuously and guard nothing. Assert the precondition.
    expect(manifest.cloud.federation).not.toBeUndefined();
  });

  test('what the read answers is what the form accepts', async () => {
    await seed();

    const result = await getInstallationManifest({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issues = manifestIssues(result.value.manifest);
    expect([...issues.entries()]).toEqual([]);
    expect(
      installationManifestSchema.safeParse(result.value.manifest).success,
    ).toBe(true);
  });

  test('a refusal of the document itself is named, not blank', () => {
    // Strict mode refuses an unrecognized *top-level* key with an empty path,
    // and both surfaces put these keys into a sentence — "was not written,
    // because ${paths} are not valid". An empty key is a sentence with a hole
    // in it, and this is the same word `validateManifest` already prints for
    // the same issue.
    const issues = manifestIssues({ ...manifest, unexpected: true });

    expect([...issues.keys()]).toContain('(root)');
  });

  test('the answered document carries no derived key', async () => {
    await seed();

    const result = await getInstallationManifest({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.manifest).not.toHaveProperty('cloud');
  });

  test('says what the answering process runs, beside the document', async () => {
    await seed();

    const result = await getInstallationManifest({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.version).toBe(manifest.controlPlane.version);
  });

  test('a value edited on what the read answers writes back', async () => {
    await seed();

    const read = await getInstallationManifest({}, context());
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // Exactly what the screen does: take the answered document, change one
    // field, submit the whole thing.
    const edited = {
      ...read.value.manifest,
      build: {
        ...read.value.manifest.build,
        zeroConfigFrontend: 'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
      },
    };

    const written = await configureInstallation(
      { manifest: edited },
      context(),
    );
    expect(written.ok).toBe(true);

    const [row] = await database().db.select().from(installation);
    expect(row?.manifest.build.zeroConfigFrontend).toBe(
      'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
    );
  });
});
