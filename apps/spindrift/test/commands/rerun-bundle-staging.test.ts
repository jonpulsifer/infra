/**
 * The source bundle a rerun's Build is created with. A stale `upload://` handle
 * copied forward fails at fetch, so a rerun stages or inherits a durable
 * bundle.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const COMMIT = 'be796d65be796d65be796d65be796d65be796d65';
/** The default branch's head after the seeded Build. */
const MOVED = 'c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11';
const STALE_HANDLE =
  'upload://3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03';
const DURABLE_LOCATION =
  'gs://bluenose-spindrift-source/3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03.tgz';
const FRESH_DIGEST =
  'sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const FRESH_LOCATION =
  'gs://bluenose-spindrift-source/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.tgz';

/** Records what it was asked to stage; fetches nothing. */
class FakeSourceStager implements RepositorySourceStager {
  readonly staged: Array<{ repository: string; commit: string }> = [];
  constructor(private readonly failure: Error | null = null) {}

  async stageRepository(input: {
    readonly repository: string;
    readonly commit: string;
  }): Promise<StagedSourceBundle> {
    this.staged.push({ repository: input.repository, commit: input.commit });
    if (this.failure !== null) throw this.failure;
    return {
      digest: FRESH_DIGEST,
      location: FRESH_LOCATION,
      retention: 'ephemeral',
    };
  }
}

describe('the bundle a rerun stages', () => {
  let ctx: CommandContext;
  let stager: FakeSourceStager;

  function withStager(replacement: RepositorySourceStager | null) {
    return {
      ...ctx,
      adapters: { ...ctx.adapters, source: () => replacement },
    } as CommandContext;
  }

  /**
   * An App whose only Build failed carrying `location`, placed on a Target.
   * `status` and `artifactDigest` override the failed Build's defaults.
   */
  async function seedFailedBuild(options: {
    location: string | null;
    sourceKind?: 'repo' | 'archive';
    connectRepository?: boolean;
    status?: 'FAILED' | 'SUCCEEDED';
    artifactDigest?: string;
    /** `false` seeds a Component that has never built at all. */
    previousBuild?: boolean;
  }) {
    const name = `rerun-${crypto.randomUUID().slice(0, 8)}`;
    const [repository] = options.connectRepository
      ? await ctx.db
          .insert(repositories)
          .values({
            fullName: `jonpulsifer/${name}`,
            installationId: '4242',
            defaultBranch: 'main',
            authoritativeCommit: COMMIT,
          })
          .returning()
      : [];
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name,
        sourceKind: options.sourceKind ?? 'repo',
        sourceRepoUrl: `https://github.com/jonpulsifer/${name}.git`,
        sourceRepoSubpath: 'apps/spindrift',
        repositoryId: repository?.id ?? null,
      })
      .returning();
    const [component] = await ctx.db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();
    const vessel = await insertVessel(ctx.db, 'kubernetes', {
      name: `target-${name}`,
    });
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id, adapter: 'kubernetes' }))
      .returning();
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: component!.id, targetId: target!.id });
    await ctx.db
      .update(components)
      .set({ placedTargetId: target!.id })
      .where(eq(components.id, component!.id));
    if (options.previousBuild === false) {
      return { app: app!, component: component!, build: null };
    }
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: COMMIT,
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest:
          'sha256:3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03',
        bundleLocation: options.location,
        status: options.status ?? 'FAILED',
        ...(options.artifactDigest === undefined
          ? {}
          : { artifactDigest: options.artifactDigest }),
      })
      .returning();
    return { app: app!, component: component!, build: build! };
  }

  beforeEach(async () => {
    const { client, db } = database();
    await db.delete(componentTargetDesired);
    await db.delete(builds);
    await db.delete(components);
    await db.delete(apps);
    await db.delete(repositories);
    await db.delete(targets);
    await db.delete(users);

    const [operator] = await db
      .insert(users)
      .values({ displayName: 'Operator' })
      .returning();

    stager = new FakeSourceStager();
    const adapters: AdapterRegistry = {
      deploy: () => null,
      build: () => null,
      store: () => null,
      supplyChain: () => new SupplyChainHarness(),
      repository: () => null,
      source: () => stager,
    };

    ctx = {
      client,
      db,
      adapters,
      clock: { now: () => new Date('2026-08-01T12:00:00.000Z') },
      manifest,
      operatorId: operator!.id,
      principal: { type: 'user', id: operator!.id, displayName: 'Operator' },
    } as unknown as CommandContext;
  });

  test('a stale handle is replaced by a freshly staged bundle', async () => {
    const seeded = await seedFailedBuild({
      location: STALE_HANDLE,
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');

    const [rerun] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(rerun!.bundleLocation).toBe(FRESH_LOCATION);
    expect(rerun!.bundleDigest).toBe(FRESH_DIGEST);
    expect(rerun!.id).not.toBe(seeded.build!.id);

    // The row's rerun suffix keeps it unique and never reaches staging.
    expect(stager.staged).toEqual([
      { repository: `jonpulsifer/${seeded.app.name}`, commit: COMMIT },
    ]);
    expect(rerun!.commit.split('#')[0]).toBe(COMMIT);
  });

  test('a durable bundle is inherited rather than fetched again', async () => {
    const seeded = await seedFailedBuild({
      location: DURABLE_LOCATION,
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [rerun] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(rerun!.bundleLocation).toBe(DURABLE_LOCATION);
    // The depot object is immutable and content-addressed.
    expect(stager.staged).toHaveLength(0);
  });

  test('an ephemeral bundle is staged again rather than inherited', async () => {
    // The depot may expire anything under `ephemeral/`. Restaging a commit
    // writes the same object and resets its lifecycle clock.
    const seeded = await seedFailedBuild({
      location:
        'gs://bluenose-spindrift-source/ephemeral/3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03.tgz',
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(stager.staged).toEqual([
      { repository: `jonpulsifer/${seeded.app.name}`, commit: COMMIT },
    ]);
    const [rerun] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(rerun!.bundleLocation).toBe(FRESH_LOCATION);
  });

  test('a durable bundle is left behind once the repository has moved past it', async () => {
    // `authoritative_commit` moves on every default-branch push, and a rerun
    // builds that commit.
    const seeded = await seedFailedBuild({
      location: DURABLE_LOCATION,
      connectRepository: true,
    });
    await ctx.db
      .update(repositories)
      .set({ authoritativeCommit: MOVED })
      .where(eq(repositories.fullName, `jonpulsifer/${seeded.app.name}`));

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(stager.staged).toEqual([
      { repository: `jonpulsifer/${seeded.app.name}`, commit: MOVED },
    ]);
    const [rerun] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(rerun!.commit.split('#')[0]).toBe(MOVED);
    expect(rerun!.bundleLocation).toBe(FRESH_LOCATION);
  });

  test('an archive App is refused rather than rebuilt from bytes nobody holds', async () => {
    const seeded = await seedFailedBuild({
      location: STALE_HANDLE,
      sourceKind: 'archive',
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain(seeded.app.name);
    expect(result.failure.message).toContain('upload it again');
    expect(stager.staged).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, seeded.component.id));
    expect(rows).toHaveLength(1);
  });

  test('an archive Component with no bundle of its own is refused at the press', async () => {
    // Archive bytes live per Component, so one added beside a sibling has none.
    // The refusal names the two acts that would give it an artifact.
    const seeded = await seedFailedBuild({
      location: null,
      sourceKind: 'archive',
      connectRepository: true,
      previousBuild: false,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain(seeded.component.name);
    expect(result.failure.message).toContain('upload an archive for this');
    expect(result.failure.message).toContain('adopt the artifact');
    expect(stager.staged).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, seeded.component.id));
    expect(rows).toHaveLength(0);
  });

  test('a repo App with nothing connected is told what would make it buildable', async () => {
    const seeded = await seedFailedBuild({ location: STALE_HANDLE });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain('connect its repository');
  });

  test('an installation with no depot says so instead of writing a dead Build', async () => {
    const seeded = await seedFailedBuild({
      location: STALE_HANDLE,
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, withStager(null));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain('no source depot');
  });

  test('a staging failure is a refusal carrying what the far side said', async () => {
    const seeded = await seedFailedBuild({
      location: STALE_HANDLE,
      connectRepository: true,
    });
    const failing = new FakeSourceStager(new Error('403 not accessible'));

    const result = await deployApp(
      { name: seeded.app.name },
      withStager(failing),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(result.failure.message).toContain('403 not accessible');
    expect(result.failure.message).toContain(COMMIT);
  });

  test('a repo Build with no bundle stages one instead of starting dead', async () => {
    const seeded = await seedFailedBuild({
      location: null,
      connectRepository: true,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');
    expect(stager.staged).toEqual([
      { repository: `jonpulsifer/${seeded.app.name}`, commit: COMMIT },
    ]);

    const [row] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row?.bundleLocation).toBe(FRESH_LOCATION);
    // The App's declared subpath wins over the predecessor's placeholder.
    expect(row?.bundleSubpath).toBe('apps/spindrift');
  });

  test("a Component's first Build stages the App's source and subpath", async () => {
    // A subpath of '.' would build the monorepo root instead of the App.
    const seeded = await seedFailedBuild({
      location: null,
      connectRepository: true,
      previousBuild: false,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('BUILDING');
    expect(stager.staged).toEqual([
      { repository: `jonpulsifer/${seeded.app.name}`, commit: COMMIT },
    ]);

    const [row] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row?.bundleLocation).toBe(FRESH_LOCATION);
    expect(row?.bundleSubpath).toBe('apps/spindrift');
  });

  describe('a rebuild asked for against a succeeded Build', () => {
    const seedSucceeded = () =>
      seedFailedBuild({
        location: DURABLE_LOCATION,
        connectRepository: true,
        status: 'SUCCEEDED',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
      });

    test('writes a new PENDING Build and leaves the succeeded one alone', async () => {
      const seeded = await seedSucceeded();

      const result = await deployApp(
        { name: seeded.app.name, rebuild: true },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // A Build started, so there is no Deploy to navigate to.
      expect(result.value.phase).toBe('BUILDING');
      expect(result.value.deployId).toBeNull();
      expect(result.value.buildId).not.toBe(seeded.build!.id);

      const rows = await ctx.db
        .select()
        .from(builds)
        .where(eq(builds.componentId, seeded.component.id));
      expect(rows).toHaveLength(2);

      const rerun = rows.find((row) => row.id === result.value.buildId);
      expect(rerun?.status).toBe('PENDING');
      // A durable bundle is inherited, as on the failed-Build path.
      expect(rerun?.bundleLocation).toBe(DURABLE_LOCATION);
      expect(stager.staged).toHaveLength(0);

      const succeeded = rows.find((row) => row.id === seeded.build!.id);
      expect(succeeded?.status).toBe('SUCCEEDED');
      expect(succeeded?.artifactDigest).toBe(`sha256:${'b'.repeat(64)}`);
    });

    test('is the only thing that reaches it — the button still deploys', async () => {
      const seeded = await seedSucceeded();

      // Without `rebuild` the deploy branch runs, and refuses because the
      // Target is not connected.
      const result = await deployApp({ name: seeded.app.name }, ctx);
      expect(result.ok).toBe(false);

      const rows = await ctx.db
        .select()
        .from(builds)
        .where(eq(builds.componentId, seeded.component.id));
      expect(rows).toHaveLength(1);
    });
  });
});
