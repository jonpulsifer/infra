/**
 * `connectRepository` (Task 24, §15).
 *
 * The command is the whole of user stories 18 and 19: connecting a repository
 * is "**a thing I review and merge rather than a thing that happens to my
 * repo**", and "**only the default-branch merge of that PR becomes
 * authoritative**". Both are asserted here as facts about the row the command
 * wrote — `authoritativeCommit` is null when it returns, and stays null however
 * many times it is called.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dispatch } from '../../src/commands/registry.ts';
import { connectRepository } from '../../src/commands/repositories/connect.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { repositories } from '../../src/db/schema.ts';
import type { DetectionProposal } from '../../src/domain/detection/ladder.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import {
  CONFIG_BRANCH,
  SPINDRIFT_FILE,
  WORKFLOW_PATH,
} from '../../src/integrations/github/config-pr.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub, testAppKey } from '../harness/fakes/github-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-07-28T12:00:00.000Z');

const proposal: DetectionProposal = {
  source: 'railpack',
  kind: 'service',
  kinds: [{ kind: 'service', available: true }],
  build: {
    frontend: 'railpack',
    buildCommand: 'bun run build',
    outputDirectory: null,
  },
  watchPaths: ['services/api'],
};

async function context(fake: FakeGitHub | null): Promise<CommandContext> {
  const { pem } = await testAppKey();
  const host =
    fake === null
      ? null
      : new GitHubApp(
          {
            appId: '1234567',
            privateKeyPem: pem,
            baseUrl: fake.baseUrl,
            fetch: fake.fetch,
          },
          () => NOW,
        );

  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: () => null,
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => host,
    supplyChain: () => {
      throw new Error('repository connection reached the supply chain');
    },
  };

  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => NOW },
    db: database().db,
    adapters,
    manifest: await fixtureManifest(),
  };
}

const input = (fake: FakeGitHub) => ({
  fullName: fake.fullName,
  installationId: fake.installationId,
  scopes: [{ scope: 'services/api', proposal }],
});

describe('connecting a repository', () => {
  test('writes one row, opens one pull request, and adopts nothing', async () => {
    const fake = new FakeGitHub();
    const base = fake.commitFiles('main', { 'README.md': 'unconnected' });

    const result = await connectRepository(input(fake), await context(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      fullName: fake.fullName,
      defaultBranch: 'main',
      pullRequest: 1,
      // Stated rather than omitted: opening the pull request adopted nothing.
      authoritativeCommit: null,
    });

    const [row] = await database()
      .db.select()
      .from(repositories)
      .where(eq(repositories.id, result.value.repositoryId));
    expect(row).toMatchObject({
      fullName: fake.fullName,
      installationId: fake.installationId,
      defaultBranch: 'main',
      access: 'active',
      authoritativeCommit: null,
      configPullRequest: 1,
    });

    // The default branch is untouched; the transaction is on its own branch.
    expect(fake.head('main')).toBe(base);
    const written = fake.filesAt(fake.head(CONFIG_BRANCH) ?? '');
    expect(Object.keys(written).sort()).toEqual(
      ['README.md', WORKFLOW_PATH, `services/api/${SPINDRIFT_FILE}`].sort(),
    );
  });

  test('connecting twice re-adopts the one row rather than duplicating it', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });

    const first = await connectRepository(input(fake), await context(fake));
    const second = await connectRepository(input(fake), await context(fake));

    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    expect(second.value.repositoryId).toBe(first.value.repositoryId);
    expect(await database().db.select().from(repositories)).toHaveLength(1);
  });

  test('refuses a repository the App installation cannot see', async () => {
    const fake = new FakeGitHub();
    fake.accessLost = true;

    const result = await connectRepository(input(fake), await context(fake));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('still selects it');
    // Nothing was written on the way to refusing.
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  test('refuses when this installation has published no build workflow', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const base = await context(fake);

    // A repository connected without a build route is connected to nothing, so
    // the transaction is refused rather than opened without its one caller.
    const result = await connectRepository(input(fake), {
      ...base,
      manifest: {
        ...base.manifest,
        github: { ...base.manifest.github, buildWorkflow: null },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('reusable build workflow');
    expect(await database().db.select().from(repositories)).toEqual([]);
    expect(fake.pulls).toEqual([]);
  });

  test('refuses when this installation has no repository integration', async () => {
    const result = await connectRepository(
      {
        fullName: 'example/app',
        installationId: '4242',
        scopes: [{ scope: 'services/api', proposal }],
      },
      await context(null),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
  });

  test('is reachable through dispatch, which is what validates its input', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const loop = await context(fake);

    // The registry validates and the handler trusts — the same split every
    // other command takes, which is why the handler holds no schema of its own.
    const refused = await dispatch(
      'connectRepository',
      { fullName: 'not-a-full-name', installationId: '', scopes: [] },
      loop,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.code).toBe('INVALID_INPUT');
      expect(refused.failure.issues?.length).toBeGreaterThan(0);
    }
    // Refused before the far side was reached at all.
    expect(fake.requests).toEqual([]);

    const accepted = await dispatch('connectRepository', input(fake), loop);
    expect(accepted.ok).toBe(true);
  });
});
