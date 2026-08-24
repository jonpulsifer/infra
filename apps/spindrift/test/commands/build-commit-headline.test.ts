/**
 * What a Build keeps of its commit beyond the sha (§15's one fetch, kept on
 * the row), and where that reaches.
 *
 * Every Build, Deploy and Source row used to be a bare sha. Staging now hands
 * the headline, author and authored instant to the row it stages for; the
 * ledgers read them back; a rerun that inherits a bundle inherits them; an
 * adopted artifact carries its source Build's.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { adoptBuild } from '../../src/commands/builds/adopt.ts';
import { getBuildDetail } from '../../src/commands/builds/get-detail.ts';
import { listBuilds } from '../../src/commands/builds/list.ts';
import { listSources } from '../../src/commands/sources/list.ts';
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
  CommitHeadline,
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
const STALE_HANDLE =
  'upload://3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03';
const DURABLE_LOCATION =
  'gs://bluenose-spindrift-source/3f5cbbc2ced964573220535fc887677dcb768b9d56b4931c415db44402440b03.tgz';
const HEADLINE: CommitHeadline = {
  message: 'feat(web): stop the header wrapping',
  author: 'octocat',
  authoredAt: new Date('2026-07-27T09:30:00.000Z'),
};

/** Stages nothing; answers with a bundle that knows its commit. */
class FakeSourceStager implements RepositorySourceStager {
  readonly staged: string[] = [];
  async stageRepository(input: {
    readonly commit: string;
  }): Promise<StagedSourceBundle> {
    this.staged.push(input.commit);
    return {
      digest: `sha256:${'a1'.repeat(32)}`,
      location: `gs://bluenose-spindrift-source/${'a1'.repeat(32)}.tgz`,
      retention: 'ephemeral',
      commit: HEADLINE,
    };
  }
}

describe('the commit headline on a Build', () => {
  let ctx: CommandContext;
  let stager: FakeSourceStager;

  /** A repo App with one placed Component and, optionally, a previous Build. */
  async function seed(previous: {
    location: string;
    headline?: CommitHeadline;
    status?: 'FAILED' | 'SUCCEEDED';
  }) {
    const name = `headline-${crypto.randomUUID().slice(0, 8)}`;
    const [repository] = await ctx.db
      .insert(repositories)
      .values({
        fullName: `jonpulsifer/${name}`,
        installationId: '4242',
        defaultBranch: 'main',
        authoritativeCommit: COMMIT,
      })
      .returning();
    const [app] = await ctx.db
      .insert(apps)
      .values({
        name,
        sourceKind: 'repo',
        sourceRepoUrl: `https://github.com/jonpulsifer/${name}.git`,
        sourceRepoSubpath: 'apps/web',
        repositoryId: repository!.id,
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
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: COMMIT,
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: `sha256:${'3f'.repeat(32)}`,
        bundleLocation: previous.location,
        status: previous.status ?? 'FAILED',
        ...(previous.status === 'SUCCEEDED'
          ? { artifactDigest: `sha256:${'ab'.repeat(32)}`, runner: 'github' }
          : {}),
        commitMessage: previous.headline?.message ?? null,
        commitAuthor: previous.headline?.author ?? null,
        commitAuthoredAt: previous.headline?.authoredAt ?? null,
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

  test('a freshly staged bundle lands the headline on the Build, and the ledgers read it back', async () => {
    const seeded = await seed({ location: STALE_HANDLE });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stager.staged).toEqual([COMMIT]);

    const [row] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row).toMatchObject({
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
      commitAuthoredAt: HEADLINE.authoredAt,
    });

    const ledger = await listBuilds({}, ctx);
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    expect(
      ledger.value.builds.find((build) => build.id === result.value.buildId),
    ).toMatchObject({
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
      commitAuthoredAt: '2026-07-27T09:30:00.000Z',
    });

    const sources = await listSources({}, ctx);
    expect(sources.ok).toBe(true);
    if (!sources.ok) return;
    expect(
      sources.value.sources.find(
        (source) => source.latestBuildId === result.value.buildId,
      ),
    ).toMatchObject({
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
      commitAuthoredAt: '2026-07-27T09:30:00.000Z',
    });

    // The attempt screen reads the same row through `sourceViewOf`.
    const detail = await getBuildDetail({ id: result.value.buildId }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.attempt.source).toMatchObject({
      kind: 'repo',
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
    });
  });

  test('a rerun that inherits a durable bundle inherits its headline too', async () => {
    const seeded = await seed({
      location: DURABLE_LOCATION,
      headline: HEADLINE,
    });

    const result = await deployApp({ name: seeded.app.name }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing was staged, so nothing could have told the new row — the
    // inherited row did.
    expect(stager.staged).toEqual([]);

    const [row] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row!.id).not.toBe(seeded.build.id);
    expect(row).toMatchObject({
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
      commitAuthoredAt: HEADLINE.authoredAt,
    });
  });

  test('an adopted artifact carries its source Build headline', async () => {
    const seeded = await seed({
      location: DURABLE_LOCATION,
      headline: HEADLINE,
      status: 'SUCCEEDED',
    });
    const [sibling] = await ctx.db
      .insert(components)
      .values({ appId: seeded.app.id, name: 'worker', kind: 'job' })
      .returning();

    const adopted = await adoptBuild(
      { componentId: sibling!.id, fromBuildId: seeded.build.id },
      ctx,
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;

    const [row] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, adopted.value.buildId));
    expect(row).toMatchObject({
      commitMessage: HEADLINE.message,
      commitAuthor: HEADLINE.author,
      commitAuthoredAt: HEADLINE.authoredAt,
    });
  });
});
