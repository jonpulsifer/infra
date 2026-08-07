/**
 * `openPrerequisiteRemediation` — an unmet row, opened as a pull request.
 *
 * The precedent is `connectRepository`'s configuration pull request, and the
 * rules that matter here are the ones it carries: **nothing is authoritative**.
 * So the assertions are mostly negative, and deliberately so — what a pull
 * request opens is easy to check and what it *did not* write is where this act
 * could quietly become a mutation:
 *
 * - the checklist row is still unmet afterwards, in the database,
 * - one file is touched and its previous contents survive,
 * - a row with no generated change opens nothing at all, and says why,
 * - a boundary with no declared root opens nothing, because there is nowhere
 *   for it to go and inventing one is the whole thing this declines to do.
 *
 * The far side is the fake of the repository host's HTTP API, so the real
 * client's Git-data sequencing runs and the tree that comes out is a tree a
 * test can read.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  listTargets,
  openPrerequisiteRemediation,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { targets, vessels } from '../../src/db/schema.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const NOW = new Date('2026-08-07T09:00:00.000Z');

/** The repository the fixture manifest declares its boundaries live in. */
const INFRASTRUCTURE = manifest.github.infrastructureRepository!;

/** What `terraform/projects/cloud/services.tf` already held. */
const EXISTING = `resource "google_project_service" "existing" {
  project = "example-vessel"
  service = "storage.googleapis.com"
}
`;

function host(fake: FakeGitHub): GitHubApp {
  return new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-user-token',
    fetch: fake.fetch,
  });
}

function context(fake: FakeGitHub | null): CommandContext {
  // Every far side but the repository host is a tripwire. §14's claim is that
  // Spindrift enables no service and mutates no boundary to clear a row, and
  // the only way to assert a negative like that is to make the alternative
  // fail: a remediation that reached a deploy adapter would be reaching a
  // cloud control plane.
  const adapters: AdapterRegistry = {
    deploy: () => {
      throw new Error('a remediation reached a deploy adapter');
    },
    build: () => {
      throw new Error('a remediation reached a build route');
    },
    store: () => {
      throw new Error('a remediation reached the secret store');
    },
    repository: () => (fake === null ? null : host(fake)),
    supplyChain: () => {
      throw new Error('a remediation reached the supply chain');
    },
  };
  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => NOW },
    db: database().db,
    adapters,
    manifest,
  };
}

/** The infrastructure repository, with the destination file already in it. */
function repository(files: Record<string, string> = {}): FakeGitHub {
  const fake = new FakeGitHub({ fullName: INFRASTRUCTURE });
  fake.commitFiles(fake.defaultBranch, {
    'terraform/projects/cloud/services.tf': EXISTING,
    ...files,
  });
  return fake;
}

/**
 * The home boundary, unhealthy, carrying one connected runtime surface.
 *
 * Named for the vessel the fixture manifest points `installation.homeVessel`
 * at, because that pointer is what puts a source bucket and a declared root on
 * this row rather than on any other.
 */
async function seedBoundary(
  options: {
    readonly vessel?: string;
    readonly checklist?: readonly {
      readonly name: 'SOURCE_BUCKET' | 'SECRET_STORE';
      readonly met: boolean;
    }[];
  } = {},
) {
  const db = database().db;
  const [vessel] = await db
    .insert(vessels)
    .values({
      name: options.vessel ?? manifest.installation.homeVessel,
      kind: 'gcp-project',
      location: { kind: 'gcp-project', project: 'example-vessel' },
      prerequisites: [
        ...(options.checklist ?? [
          {
            name: 'SOURCE_BUCKET' as const,
            met: false,
            detail: 'example-source-bucket is not a bucket in example-vessel',
          },
        ]),
      ],
    })
    .returning();

  await db.insert(targets).values(
    targetValues({
      adapter: 'cloudrun',
      vesselId: vessel!.id,
      health: 'unhealthy',
      prerequisites: [
        {
          name: 'PLATFORM_API',
          met: false,
          detail: 'the Cloud Run API is not enabled on example-vessel',
        },
        { name: 'OIDC_FEDERATION', met: true },
        { name: 'VESSEL', met: true },
      ],
    }),
  );
  return vessel!;
}

describe('opening the change on a surface', () => {
  test('one pull request adds the stanza to the file that already exists', async () => {
    await seedBoundary();
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest).toBeGreaterThan(0);
    expect(result.value.path).toBe('terraform/projects/cloud/services.tf');
    expect(result.value.createdFile).toBe(false);

    const written = fake.filesAt(fake.head(result.value.branch)!);
    // Exactly one file, because one pull request is one prerequisite's change.
    // A tidy-up or a second service in the same tree is a review about
    // something other than the row it came from.
    expect(Object.keys(written)).toEqual([
      'terraform/projects/cloud/services.tf',
    ]);
    const contents = written['terraform/projects/cloud/services.tf']!;
    expect(contents).toContain(EXISTING.trim());
    expect(contents).toContain('"run.googleapis.com"');
  });

  test('the pull request stands on its own and claims nothing', async () => {
    await seedBoundary();
    const fake = repository();

    await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );

    const [pull] = fake.pulls;
    expect(pull).toBeDefined();
    expect(pull!.base).toBe(fake.defaultBranch);
    // What clears the row is applying it, and the loop is what notices — so
    // the body says that rather than implying a merge is the end of it.
    expect(pull!.body).toContain('applying it is');
    expect(pull!.body).toContain('goes green on its own');
    expect(pull!.body).toContain('terraform/projects/cloud/services.tf');
  });

  test('nothing is written here, and the row is still unmet', async () => {
    const vessel = await seedBoundary();
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      {
        vessel: vessel.name,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.prerequisiteMet).toBe(false);

    // An unmerged pull request has changed nothing about the boundary, so a
    // checklist that moved would be stating a fact nobody established.
    const [row] = await database()
      .db.select()
      .from(targets)
      .where(eq(targets.vesselId, vessel.id));
    expect(row!.health).toBe('unhealthy');
    expect(
      row!.prerequisites?.find((item) => item.name === 'PLATFORM_API')?.met,
    ).toBe(false);
  });
});

describe('opening the change on the boundary itself', () => {
  test('a vessel row lands in the file its own resource belongs in', async () => {
    const vessel = await seedBoundary();
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SOURCE_BUCKET' },
      context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe('terraform/projects/cloud/storage.tf');
    // The destination file was not there, so this is the one case where a whole
    // file is written — and it holds the stanza and nothing else.
    expect(result.value.createdFile).toBe(true);
    const written = fake.filesAt(fake.head(result.value.branch)!);
    expect(written['terraform/projects/cloud/storage.tf']).toContain(
      'google_storage_bucket',
    );
    // And the file that was already there is untouched by this branch.
    expect(written['terraform/projects/cloud/services.tf']).toBe(EXISTING);
  });
});

describe('what the checklist carries onto a screen', () => {
  test('every unmet row arrives with an answer and every met row without one', async () => {
    await seedBoundary();
    const result = await listTargets({}, context(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const surface = result.value.targets[0]!;
    const rows = new Map(surface.prerequisites.map((row) => [row.name, row]));
    // Met rows carry nothing: there is nothing to clear, and a change beside a
    // green row is a change somebody might apply.
    expect(rows.get('OIDC_FEDERATION')?.remediation).toBeUndefined();

    const unmet = rows.get('PLATFORM_API')?.remediation;
    expect(unmet?.kind).toBe('generated');
    if (unmet?.kind !== 'generated') return;
    expect(unmet.terraform).toContain('"run.googleapis.com"');
    expect(unmet.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/services.tf',
    });
  });

  test('a boundary row is answered as the boundary and not as a surface', async () => {
    await seedBoundary();
    const result = await listTargets({}, context(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const boundary = result.value.vessels.find(
      (vessel) => vessel.name === manifest.installation.homeVessel,
    )!;
    const bucket = boundary.prerequisites.find(
      (row) => row.name === 'SOURCE_BUCKET',
    )?.remediation;
    expect(bucket?.kind).toBe('generated');
    if (bucket?.kind !== 'generated') return;
    expect(bucket.terraform).toContain('google_storage_bucket');
    // The runtime's own service is a fact about a surface, and answering a
    // boundary's row with one would be the duplication the vessel exists to
    // remove.
    expect(bucket.terraform).not.toContain('googleapis.com');
  });

  test('nothing about a remediation is stored on the row it explains', async () => {
    // Derived at read time, exactly as health is: a stanza moves when a root is
    // declared or a surface is connected, and a stored one would go stale with
    // nothing watching.
    const vessel = await seedBoundary();
    await listTargets({}, context(null));
    const [row] = await database()
      .db.select()
      .from(vessels)
      .where(eq(vessels.id, vessel.id));
    for (const item of row!.prerequisites ?? []) {
      expect(item.remediation).toBeUndefined();
    }
  });
});

describe('what it refuses, and why', () => {
  test('a row that is already met has nothing to change', async () => {
    const vessel = await seedBoundary({
      checklist: [{ name: 'SOURCE_BUCKET', met: true }],
    });
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SOURCE_BUCKET' },
      context(fake),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('already met');
    expect(fake.pulls).toHaveLength(0);
  });

  test('a row with no generated change opens nothing and names the reason', async () => {
    const vessel = await seedBoundary({
      checklist: [{ name: 'SECRET_STORE', met: false }],
    });
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SECRET_STORE' },
      context(fake),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain(
      'no Terraform change was generated',
    );
    expect(fake.pulls).toHaveLength(0);
  });

  test('a boundary with no declared root opens nothing', async () => {
    // The honest arm. There is no path to write to, and a root has a backend,
    // a provider and a version pin that nothing here observed — so this refuses
    // rather than creating one.
    const vessel = await seedBoundary({ vessel: 'elsewhere' });
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      {
        vessel: vessel.name,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('no Terraform root');
    expect(fake.pulls).toHaveLength(0);
  });

  test('an installation with no repository integration says so', async () => {
    await seedBoundary();
    const result = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(null),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
  });

  test('a row nothing has been asked about is a not-found', async () => {
    const vessel = await seedBoundary();
    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SIGNER_KEY' },
      context(repository()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});
