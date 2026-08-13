/**
 * What bundle a rerun's Build is created with (ticket 24).
 *
 * §15 has Spindrift stage an immutable source bundle for either builder, and
 * the thing it is staged *for* is a Build. Copying the previous Build's
 * `bundleLocation` forward instead would carry an unfetchable `upload://`
 * handle into build 10 that dies at `curl` for build 9's reason.
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
/** Where the default branch got to after the Build above was created. */
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
   * An App whose only Build failed carrying `location`, placed on a Target —
   * the shape the deploy button acts on, and offsite's shape today.
   *
   * `status` and `artifactDigest` default to that shape. Ticket 36 is the one
   * caller that overrides them, because the act it asks for is only reachable
   * on the Build the defaults exclude.
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
    // The whole ticket in two assertions: the new Build carries the bundle that
    // was staged for it, and the handle that predates the depot is not in it.
    expect(rerun!.bundleLocation).toBe(FRESH_LOCATION);
    expect(rerun!.bundleDigest).toBe(FRESH_DIGEST);
    expect(rerun!.id).not.toBe(seeded.build!.id);

    // The exact commit, once — the rerun suffix is a uniqueness device on the
    // row and never travels into staging.
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
    // The depot object is immutable and content-addressed, so the same commit
    // wants the same object. Re-fetching it would cost a tarball to arrive back
    // where it started.
    expect(stager.staged).toHaveLength(0);
  });

  test('a durable bundle is left behind once the repository has moved past it', async () => {
    // The hole this closes: `authoritative_commit` moves on every default-branch
    // push, and a rerun that inherited any still-fetchable bundle rebuilt the
    // commit the App was created at — forever, reporting success each time.
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

    // Nothing was written behind the refusal.
    const rows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, seeded.component.id));
    expect(rows).toHaveLength(1);
  });

  test('an archive Component with no bundle of its own is refused at the press', async () => {
    // The hole the Components card opens (ticket 118). An archive App's bytes
    // are held per Component — `uploadArchive` and `completeCreationDraft` are
    // what put them on a Build row — so a Component added beside a sibling has
    // none, and this used to answer with `ok` and a null location: a PENDING
    // Build `dispatchBuild` closes on sight
    // (`src/commands/builds/dispatch.ts:524`). A dead Build is the wrong answer
    // to a button press, so the refusal names the two acts that would give this
    // Component an artifact.
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

    // Nothing was written behind the refusal — no Build, and no placement.
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
    // A repo Component whose previous Build never had a bundle used to get
    // another Build with none — a row dispatch then refused, forever. The
    // repository is right there; staging it is what a first bundle is.
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
    // The predecessor was created before its Component could stage, so its
    // recorded subpath is the placeholder — the App's declared subpath wins,
    // observed live as build 52 building a monorepo root.
    expect(row?.bundleSubpath).toBe('apps/spindrift');
  });

  test("a Component's first Build stages the App's source and subpath", async () => {
    // The live shape this pins: a freshly created second Component has no
    // Build history at all. Its first Build stages the repository at the
    // authoritative commit and carries the App's own subpath — '.' would
    // build the monorepo root instead of the App.
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

  /**
   * Ticket 36 — an App whose newest Build succeeded had no path to a new one.
   * The branch above is the only caller of `sourceForRerun`, and reaching it
   * meant writing `status = 'FAILED'` onto a Build that genuinely succeeded.
   */
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

      // The act says which of the two it did: a Build was started, so there is
      // no intent to navigate to.
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
      // Staged for it, not carried from the Build being rerun — the same rule
      // the failed-Build path follows, and the reason a durable bundle is
      // inherited rather than fetched twice.
      expect(rerun?.bundleLocation).toBe(DURABLE_LOCATION);
      expect(stager.staged).toHaveLength(0);

      // The row edit this ticket exists to end: the succeeded Build still says
      // it succeeded, and still names what it produced.
      const succeeded = rows.find((row) => row.id === seeded.build!.id);
      expect(succeeded?.status).toBe('SUCCEEDED');
      expect(succeeded?.artifactDigest).toBe(`sha256:${'b'.repeat(64)}`);
    });

    test('is the only thing that reaches it — the button still deploys', async () => {
      const seeded = await seedSucceeded();

      // Same App, same Build, no `rebuild`. The Target is not connected, so
      // `createDeploy` refuses — which is the point: the deploy branch was
      // taken, and it refused with its own sentence rather than building.
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
