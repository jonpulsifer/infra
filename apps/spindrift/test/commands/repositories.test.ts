/**
 * `connectRepository` opens a configuration pull request and adopts nothing:
 * `authoritativeCommit` stays null however many times it runs.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dispatch } from '../../src/commands/registry.ts';
import { connectRepository } from '../../src/commands/repositories/connect.ts';
import { inspectRepository } from '../../src/commands/repositories/inspect.ts';
import { listRepositories } from '../../src/commands/repositories/list.ts';
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
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-07-28T12:00:00.000Z');

const proposal: DetectionProposal = {
  source: 'detection',
  kind: 'service',
  reason: 'a fixture',
  kinds: [{ kind: 'service', available: true }],
  build: {
    frontend: 'railpack',
    buildCommand: 'bun run build',
    outputDirectory: null,
  },
  watchPaths: ['services/api'],
};

/** A repository whose root is a Go service and nothing else. */
const GO_SERVICE = {
  'README.md': 'unconnected',
  'go.mod': 'module example.com/app\n',
};

async function context(
  fake: FakeGitHub | null,
  customFetch?: typeof fetch,
): Promise<CommandContext> {
  const host =
    fake === null
      ? null
      : new GitHubApp({
          baseUrl: fake.baseUrl,
          authorization: () => 'Bearer test-installation-token',
          appAuthorization: () => 'Bearer test-app-jwt',
          fetch: customFetch ?? fake.fetch,
        });

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

/** An operator override, so detection holds still in pull request tests. */
const input = (fake: FakeGitHub) => ({
  fullName: fake.fullName,
  overrides: [
    {
      scope: 'services/api',
      kind: proposal.kind,
      build: proposal.build,
      watchPaths: [...proposal.watchPaths],
    },
  ],
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

  test('keys the row on the name the host answers with, not the one typed', async () => {
    // GitHub answers any spelling or old name with the canonical `full_name`;
    // the row's unique key is case-sensitive and rename-blind.
    const fake = new FakeGitHub({ fullName: 'Example/App' });
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    fake.rename('example/app');

    const typed = await connectRepository(
      { ...input(fake), fullName: 'Example/App' },
      await context(fake),
    );
    const canonical = await connectRepository(input(fake), await context(fake));

    expect(typed.ok && canonical.ok).toBe(true);
    if (!(typed.ok && canonical.ok)) return;
    expect(typed.value.fullName).toBe('example/app');
    expect(canonical.value.repositoryId).toBe(typed.value.repositoryId);
    expect(await database().db.select().from(repositories)).toHaveLength(1);
  });

  test('refuses a repository the App installation cannot see', async () => {
    const fake = new FakeGitHub();
    fake.accessLost = true;

    const result = await connectRepository(input(fake), await context(fake));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    // GitHub answers a missing repository and an unselected one identically.
    expect(result.failure.message).toContain('does not exist');
    expect(result.failure.message).toContain('repository selection');
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  // The wizard connects a repository it just listed, so NOT_FOUND would be
  // wrong.
  test('a quota refusal is not a missing repository', async () => {
    const fake = new FakeGitHub();
    fake.rateLimited = true;

    const result = await connectRepository(input(fake), await context(fake));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).not.toBe('NOT_FOUND');
    expect(result.failure.message).toContain('rate-limiting');
    expect(result.failure.message).not.toContain('rate limit exceeded');
    expect(result.failure.message).not.toContain('failed with');
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  test('a far side having a bad time says so, without its body', async () => {
    const fake = new FakeGitHub();
    const failing = (async () =>
      new Response('<html>upstream connect error</html>', {
        status: 502,
      })) as unknown as typeof fetch;

    const result = await connectRepository(
      input(fake),
      await context(fake, failing),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).not.toBe('NOT_FOUND');
    expect(result.failure.message).toContain('502');
    expect(result.failure.message).not.toContain('upstream connect error');
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  test('refuses when this installation has published no build workflow', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const base = await context(fake);

    const result = await connectRepository(input(fake), {
      ...base,
      manifest: {
        ...base.manifest,
        github: { ...base.manifest.github, buildWorkflow: null },
      },
    });

    // A null `buildWorkflow` means repositories cannot be connected.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('build workflow');
    expect(await database().db.select().from(repositories)).toEqual([]);
    expect(fake.pulls).toEqual([]);
  });

  test('fails open and leaves repository connected when configuration PR creation fails', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const failingFetch = (async (input: any) => {
      const urlStr =
        typeof input === 'string' ? input : (input?.url ?? String(input));
      if (urlStr.includes('/git/') || urlStr.includes('/pulls')) {
        throw new Error('GitHub API pull request error');
      }
      return fake.fetch(input);
    }) as any;
    const ctx = await context(fake, failingFetch);

    const result = await connectRepository(input(fake), ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest).toBeNull();
    // The error tells a failed pull request from one that was never needed.
    expect(result.value.pullRequestError).toContain('pull request error');

    const [row] = await database()
      .db.select()
      .from(repositories)
      .where(eq(repositories.id, result.value.repositoryId));
    expect(row).toMatchObject({
      fullName: fake.fullName,
      access: 'active',
      configPullRequest: null,
    });
  });

  test('refuses when this installation has no repository integration', async () => {
    const result = await connectRepository(
      {
        fullName: 'example/app',
        overrides: [
          {
            scope: 'services/api',
            kind: proposal.kind,
            build: proposal.build,
            watchPaths: [...proposal.watchPaths],
          },
        ],
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

    // The registry validates input; the handler holds no schema of its own.
    const refused = await dispatch(
      'connectRepository',
      { fullName: 'not-a-full-name', scopes: [] },
      loop,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.code).toBe('INVALID_INPUT');
      expect(refused.failure.issues?.length).toBeGreaterThan(0);
    }
    expect(fake.requests).toEqual([]);

    const accepted = await dispatch('connectRepository', input(fake), loop);
    expect(accepted.ok).toBe(true);
  });
});

/**
 * The command detects at the default branch's current head, so the file it
 * writes describes the code there now.
 */
describe('connecting a repository without being told what is in it', () => {
  test('detects the root and writes the Spindrift file it implies', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', GO_SERVICE);

    const result = await connectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest).toBe(1);

    const written = fake.filesAt(fake.head(CONFIG_BRANCH) ?? '');
    expect(Object.keys(written).sort()).toEqual(
      ['README.md', 'go.mod', WORKFLOW_PATH, SPINDRIFT_FILE].sort(),
    );
    expect(written[SPINDRIFT_FILE]).toContain('kind: service');
    // The body says whether detection or an operator proposed the file.
    expect(fake.pulls[0]?.body).toContain('detection');
  });

  test('a monorepo yields one pull request carrying every scope it found', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: ['apps/*'],
      }),
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        dependencies: { astro: '^5.0.0' },
      }),
      'apps/api/go.mod': 'module api\n',
      'apps/lib/package.json': JSON.stringify({ name: 'lib' }),
    });

    const result = await connectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(true);
    const written = fake.filesAt(fake.head(CONFIG_BRANCH) ?? '');
    // `apps/lib` is a library and is skipped. `apps/api` has no package.json,
    // so discovery reads past the workspace list.
    expect(
      Object.keys(written)
        .filter((path) => path.endsWith(SPINDRIFT_FILE))
        .sort(),
    ).toEqual([`apps/api/${SPINDRIFT_FILE}`, `apps/web/${SPINDRIFT_FILE}`]);
  });

  test('an in-repo spindrift.yaml is what gets written back, unchanged', async () => {
    const fake = new FakeGitHub();
    const authored = [
      'version: 1',
      'component:',
      '  kind: job',
      'build:',
      '  frontend: railpack',
      '  command: bun run nightly',
      '  outputDirectory: null',
      'watchPaths:',
      '  - .',
      '',
    ].join('\n');
    fake.commitFiles('main', {
      'go.mod': 'module example.com/app\n',
      [SPINDRIFT_FILE]: authored,
    });

    await connectRepository({ fullName: fake.fullName }, await context(fake));

    const written = fake.filesAt(fake.head(CONFIG_BRANCH) ?? '');
    // Detection would say `service`; the authored file wins.
    expect(written[SPINDRIFT_FILE]).toContain('kind: job');
  });

  test('refuses, and writes no row, when nothing in the repository is buildable', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'just prose' });

    const result = await connectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('nothing it knows how to build');
    // The repo loop would reconcile a scopeless row forever and never find an
    // App.
    expect(await database().db.select().from(repositories)).toEqual([]);
    expect(fake.pulls).toEqual([]);
  });

  test('a named scope is connected exactly, with no discovery', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        dependencies: { astro: '^5.0.0' },
      }),
      'apps/api/go.mod': 'module api\n',
    });

    await connectRepository(
      { fullName: fake.fullName, scopes: ['apps/api'] },
      await context(fake),
    );

    const written = fake.filesAt(fake.head(CONFIG_BRANCH) ?? '');
    expect(
      Object.keys(written)
        .filter((path) => path.endsWith(SPINDRIFT_FILE))
        .sort(),
    ).toEqual([`apps/api/${SPINDRIFT_FILE}`]);
  });
});

describe('inspecting a repository before connecting it', () => {
  test('reads the repository and writes nothing', async () => {
    const fake = new FakeGitHub();
    const head = fake.commitFiles('main', GO_SERVICE);

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      fullName: fake.fullName,
      defaultBranch: 'main',
      commit: head,
      canConnect: true,
    });
    expect(result.value.scopes).toEqual([
      {
        scope: '.',
        outcome: 'detected',
        kind: 'service',
        reason: 'Go — go.mod is in this directory',
        frontend: 'railpack',
        dockerfile: null,
        // Both zero-config build fields travel, so the screen can render the
        // full file.
        buildCommand: null,
        outputDirectory: null,
        watchPaths: ['.', 'go.mod'],
        configured: false,
        // Ruled-out kinds carry a reason, so the creation flow can show them
        // disabled.
        unavailable: {
          website: 'Go projects build a program, not a directory of files',
          job: 'jobs are asserted, never inferred',
        },
      },
    ]);
    expect(fake.head(CONFIG_BRANCH)).toBeUndefined();
    expect(fake.pulls).toEqual([]);
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  test('a Dockerfile settles how to build and not what the thing is', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'package.json': JSON.stringify({
        name: 'site',
        dependencies: { astro: '^5.0.0' },
      }),
      Dockerfile: 'FROM nginx\n',
    });

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scopes[0]).toMatchObject({
      outcome: 'detected',
      // A Dockerfile sets the frontend, never the kind.
      kind: 'website',
      frontend: 'dockerfile',
      dockerfile: 'Dockerfile',
    });
  });

  test('says what it could not make sense of, rather than answering empty', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'just prose' });

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scopes).toEqual([
      {
        scope: '.',
        outcome: 'unsupported',
        detail:
          'no index.html, package.json, go.mod, Cargo.toml, pyproject.toml, requirements.txt or Gemfile in this directory.',
      },
    ]);
  });

  test('warns that this installation cannot open a configuration PR at all', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', GO_SERVICE);
    const base = await context(fake);

    const result = await inspectRepository(
      { fullName: fake.fullName },
      {
        ...base,
        manifest: {
          ...base.manifest,
          github: { ...base.manifest.github, buildWorkflow: null },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canConnect).toBe(false);
  });

  test('refuses a repository the App installation cannot see', async () => {
    const fake = new FakeGitHub();
    fake.accessLost = true;

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    // GitHub answers a missing repository and an unselected one identically.
    expect(result.failure.message).toContain('does not exist');
    expect(result.failure.message).toContain('repository selection');
  });

  test('a quota refusal is not a missing repository', async () => {
    // `RATE_LIMITED` and `ACCESS_LOST` stay apart, so a spent quota never reads
    // as a lost repository.
    const fake = new FakeGitHub();
    fake.rateLimited = true;

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).not.toBe('NOT_FOUND');
    expect(result.failure.message).toContain('rate-limiting');
    expect(result.failure.message).not.toContain('rate limit exceeded');
    expect(result.failure.message).not.toContain('failed with');
  });

  test('a far side having a bad time says so, without its body', async () => {
    const fake = new FakeGitHub();
    const failing = (async () =>
      new Response('<html>upstream connect error</html>', {
        status: 502,
      })) as unknown as typeof fetch;

    const result = await inspectRepository(
      { fullName: fake.fullName },
      await context(fake, failing),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).not.toBe('NOT_FOUND');
    expect(result.failure.message).toContain('502');
    expect(result.failure.message).not.toContain('upstream connect error');
  });

  test('reads the tree once however many scopes it inspects', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      'apps/one/go.mod': 'module one\n',
      'apps/two/go.mod': 'module two\n',
      'apps/three/go.mod': 'module three\n',
    });

    await inspectRepository({ fullName: fake.fullName }, await context(fake));

    expect(
      fake.requests.filter((request) => request.path.includes('/git/trees/')),
    ).toHaveLength(1);
  });
});

describe('listRepositories', () => {
  test('returns empty lists when no repositories are connected', async () => {
    const fake = new FakeGitHub();
    const result = await listRepositories({}, await context(fake));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repos).toEqual([]);
      expect(result.value.options).toEqual([]);
    }
  });

  test('lists connected repositories with health, authoritative commit, and options', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });

    await connectRepository(input(fake), await context(fake));

    const result = await listRepositories({}, await context(fake));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repos).toHaveLength(1);
      expect(result.value.repos[0]?.fullName).toBe(fake.fullName);
      expect(result.value.repos[0]?.health).toBe('connected');
      expect(result.value.options).toHaveLength(1);
      expect(result.value.options[0]?.fullName).toBe(fake.fullName);
    }
  });

  test('a repository the host would not answer about is listed, and says so', async () => {
    // Listing refreshes each repository from the host, so a failure marks it
    // stale.
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    await connectRepository(input(fake), await context(fake));

    const offline = await context(fake, (() => {
      throw new Error('the repository host is unreachable');
    }) as unknown as typeof fetch);
    const result = await listRepositories({}, offline);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos).toHaveLength(1);
    expect(result.value.repos[0]?.staleReason).toContain('unreachable');
  });

  test('renders the commit that governs, not the one the branch has moved to', async () => {
    const fake = new FakeGitHub();
    const adopted = fake.commitFiles('main', { 'README.md': 'unconnected' });
    const connected = await connectRepository(input(fake), await context(fake));
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    await database()
      .db.update(repositories)
      .set({ authoritativeCommit: adopted })
      .where(eq(repositories.id, connected.value.repositoryId));

    // A push the loop has not adopted yet. Refreshing the row must not adopt
    // it.
    const pushed = fake.commitFiles('main', { 'README.md': 'pushed' });

    const result = await listRepositories({}, await context(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await database()
      .db.select()
      .from(repositories)
      .where(eq(repositories.id, connected.value.repositoryId));
    expect(row?.authoritativeCommit).toBe(adopted);
    expect(row?.authoritativeCommit).not.toBe(pushed);
    expect(result.value.repos[0]?.lastReconciledSha).toBe(adopted);
  });

  test('keeps GitHub-granted repositories separate from durable connections', async () => {
    const base = await context(null);
    const result = await listRepositories(
      {},
      {
        ...base,
        adapters: {
          ...base.adapters,
          repositoryAuthorization: () => ({
            status: async () => ({
              state: 'authorized' as const,
              slug: 'spindrift-example',
              appId: '1234567',
            }),
            setup: async () => {
              throw new Error('not reached');
            },
            repositories: async () => [
              {
                repositoryId: '99',
                fullName: 'example/available',
                defaultBranch: 'trunk',
                installationId: '37547020',
              },
            ],
            installationFor: async () => ({
              installationId: '37547020',
            }),
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toEqual([]);
    expect(result.value.available).toEqual([
      {
        repositoryId: '99',
        fullName: 'example/available',
        defaultBranch: 'trunk',
        // From the manifest's repository host, which an enterprise installation
        // sets.
        cloneUrl: 'https://git.example.test/example/available.git',
        rowExists: false,
      },
    ]);
  });
});
