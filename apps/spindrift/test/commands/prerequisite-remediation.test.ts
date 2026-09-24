/**
 * `openPrerequisiteRemediation` opens an unmet checklist row as a pull request
 * against a fake GitHub API, and writes nothing else: the row stays unmet.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { listTargets } from '../../src/commands/targets/list.ts';
import { openPrerequisiteRemediation } from '../../src/commands/targets/remediate.ts';
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

const INFRASTRUCTURE = manifest.github.infrastructureRepository!;

/** The contents `terraform/projects/cloud/services.tf` starts with. */
const EXISTING = `resource "google_project_service" "existing" {
  project = "example-vessel"
  service = "storage.googleapis.com"
}
`;

function host(fake: FakeGitHub): GitHubApp {
  return new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-installation-token',
    appAuthorization: () => 'Bearer test-app-jwt',
    fetch: fake.fetch,
  });
}

function context(fake: FakeGitHub | null): CommandContext {
  // Every adapter but the repository host throws: a remediation enables no
  // service and mutates no boundary.
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
 * The home vessel, unhealthy, with one Cloud Run Target. Only the home vessel
 * has a source bucket and a declared Terraform root in the fixture.
 */
async function seedBoundary(
  options: {
    readonly vessel?: string;
    readonly checklist?: readonly {
      readonly name: 'SOURCE_BUCKET' | 'SECRET_STORE';
      readonly met: boolean;
      readonly assessed?: boolean;
    }[];
    /** Adds the vessel's static Target beside Cloud Run. */
    readonly alsoStatic?: boolean;
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
  if (options.alsoStatic === true) {
    await db.insert(targets).values(
      targetValues({
        adapter: 'static',
        rank: 1,
        vesselId: vessel!.id,
        health: 'unhealthy',
        prerequisites: [
          {
            name: 'PLATFORM_API',
            met: false,
            detail: 'the Firebase Hosting API is not enabled on example-vessel',
          },
          { name: 'OIDC_FEDERATION', met: true },
          { name: 'VESSEL', met: true },
        ],
      }),
    );
  }
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
    // One pull request is one prerequisite's change.
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
    // Applying the change clears the row, and the loop notices; a merge alone
    // does not.
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
    expect(result.value.createdFile).toBe(true);
    const written = fake.filesAt(fake.head(result.value.branch)!);
    expect(written['terraform/projects/cloud/storage.tf']).toContain(
      'google_storage_bucket',
    );
    expect(written['terraform/projects/cloud/services.tf']).toBe(EXISTING);
  });
});

describe('two surfaces of one boundary', () => {
  test('each opens its own branch, and neither overwrites the other', async () => {
    // `PREREQUISITES_BY_ADAPTER` puts `PLATFORM_API` on both cloud Targets. On
    // a shared branch, the second open would force-push over the first.
    await seedBoundary({ alsoStatic: true });
    const fake = repository();

    const run = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );
    const site = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'static',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );

    expect(run.ok).toBe(true);
    expect(site.ok).toBe(true);
    if (!run.ok || !site.ok) return;
    expect(run.value.branch).not.toBe(site.value.branch);

    const onRun = fake.filesAt(fake.head(run.value.branch)!);
    const onSite = fake.filesAt(fake.head(site.value.branch)!);
    expect(onRun['terraform/projects/cloud/services.tf']).toContain(
      '"run.googleapis.com"',
    );
    expect(onSite['terraform/projects/cloud/services.tf']).toContain(
      '"firebasehosting.googleapis.com"',
    );
    expect(onRun['terraform/projects/cloud/services.tf']).not.toContain(
      'firebasehosting',
    );
    expect(onSite['terraform/projects/cloud/services.tf']).not.toContain(
      'run.googleapis.com',
    );
  });

  test('the pull request names the surface it is about', async () => {
    await seedBoundary({ alsoStatic: true });
    const fake = repository();

    await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'static',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );

    const [pull] = fake.pulls;
    // Two pull requests on one vessel would otherwise share a title.
    expect(pull!.title).toContain('static');
    expect(pull!.body).toContain('static');
  });
});

describe('a destination that already owns the change', () => {
  test('a file declaring the same resource is refused, not appended to', async () => {
    // Appending would duplicate a resource address, which fails to parse and
    // breaks the plan for every change against that root.
    const vessel = await seedBoundary();
    const fake = repository({
      'terraform/projects/cloud/storage.tf': `resource "google_storage_bucket" "spindrift_source" {
  name = "example-source-bucket"
}
`,
    });

    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SOURCE_BUCKET' },
      context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('already declares this change');
    expect(fake.pulls).toHaveLength(0);
    // Refused before the branch is created.
    expect(
      fake.head(`spindrift/remediate/${vessel.name}-source-bucket`),
    ).toBeUndefined();
  });

  test('a file owning the same fact under another label is refused too', async () => {
    // This parses, but two resources managing one API enablement drift apart.
    await seedBoundary();
    const fake = repository({
      'terraform/projects/cloud/services.tf': `resource "google_project_service" "service" {
  for_each = toset(["run.googleapis.com"])

  project = "example-vessel"
  service = each.key
}
`,
    });

    const result = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('"run.googleapis.com"');
    expect(fake.pulls).toHaveLength(0);
  });

  test('opening the same row twice adds it once', async () => {
    // Merged but not applied: the row is still unmet, and the base branch
    // already carries the stanza.
    await seedBoundary();
    const fake = repository();
    const first = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    fake.commitFiles(
      fake.defaultBranch,
      fake.filesAt(fake.head(first.value.branch)!),
    );

    const again = await openPrerequisiteRemediation(
      {
        vessel: manifest.installation.homeVessel,
        adapter: 'cloudrun',
        prerequisite: 'PLATFORM_API',
      },
      context(fake),
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.failure.message).toContain('already declares this change');
    expect(fake.pulls).toHaveLength(1);
  });
});

describe('a row nothing established', () => {
  test('an unassessed row carries the reason instead of a stanza', async () => {
    // A probe stopped by a disabled API leaves later rows unassessed, and a
    // grant generated for one would be a guess.
    const db = database().db;
    const [vessel] = await db
      .insert(vessels)
      .values({
        name: manifest.installation.homeVessel,
        kind: 'gcp-project',
        location: { kind: 'gcp-project', project: 'example-vessel' },
        prerequisites: [],
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
            assessed: true,
            detail: 'the Cloud Run API is not enabled on example-vessel',
          },
          {
            name: 'OIDC_FEDERATION',
            met: false,
            assessed: false,
            detail:
              'not assessed: the Cloud Run probe did not get far enough to check this',
          },
          {
            name: 'VESSEL',
            met: false,
            assessed: false,
            detail:
              'not assessed: the Cloud Run probe did not get far enough to check this',
          },
        ],
      }),
    );

    const listed = await listTargets({}, context(null));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = new Map(
      listed.value.targets[0]!.prerequisites.map((row) => [row.name, row]),
    );
    // The observed row still gets its change.
    expect(rows.get('PLATFORM_API')?.remediation?.kind).toBe('generated');
    const federation = rows.get('OIDC_FEDERATION')?.remediation;
    expect(federation?.kind).toBe('none');
    if (federation?.kind !== 'none') return;
    expect(federation.reason).toContain('nothing here observed');
  });

  test('and the act refuses to open one for it', async () => {
    const vessel = await seedBoundary({
      checklist: [{ name: 'SOURCE_BUCKET', met: false, assessed: false }],
    });
    const fake = repository();

    const result = await openPrerequisiteRemediation(
      { vessel: vessel.name, prerequisite: 'SOURCE_BUCKET' },
      context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('nothing here observed');
    expect(fake.pulls).toHaveLength(0);
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
    // API enablement belongs to a Target's row, so the vessel's row never
    // carries it.
    expect(bucket.terraform).not.toContain('googleapis.com');
  });

  test('nothing about a remediation is stored on the row it explains', async () => {
    // Derived at read time, since a stored stanza goes stale when a root or
    // Target changes.
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
    // Creating a root would guess its backend, provider and version pin.
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
