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

/**
 * The escape hatch, as an input: an operator asserting the proposal.
 *
 * Most tests here are about the transaction rather than about detection, and
 * an override is the way to hold detection still while asserting on what the
 * pull request wrote. The detection path has its own tests below.
 */
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
    // GitHub answers a repository that does not exist and one the installation
    // does not select identically, so the sentence names both rather than
    // asserting an existence nothing established.
    expect(result.failure.message).toContain('does not exist');
    expect(result.failure.message).toContain('repository selection');
    // Nothing was written on the way to refusing.
    expect(await database().db.select().from(repositories)).toEqual([]);
  });

  // The creation wizard connects on Deploy, against a repository it has
  // already read successfully on this screen. A quota window answering
  // `NOT_FOUND` there contradicts the list the operator picked from, and a raw
  // HTTP body is not a sentence anybody can act on.
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

    // The schema's word ("null means repositories cannot be connected") is the
    // command's word too: a repository connected without a build route is
    // connected to nothing, so nothing is written at all.
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
    // Fail open, but never silently: the result names the failure, so a null
    // pull request is distinguishable from one that was never needed.
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

    // The registry validates and the handler trusts — the same split every
    // other command takes, which is why the handler holds no schema of its own.
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
    // Refused before the far side was reached at all.
    expect(fake.requests).toEqual([]);

    const accepted = await dispatch('connectRepository', input(fake), loop);
    expect(accepted.ok).toBe(true);
  });
});

/**
 * Connecting with nothing but a name (§5, story 25).
 *
 * The point of these is that the *command* detects. A browser that sent back
 * what a screen showed it would be authoring domain state and would write
 * whatever was on screen when the tab was opened; the connect resolves the
 * default branch again and reads the repository at that commit, so the file it
 * writes is a statement about the code that is there now.
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
    // The pull request names the detector, not a person, so a reviewer can tell
    // which of the two proposed it.
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
    // `apps/lib` is a library. It is passed over rather than connected, and
    // passing over seven of nine directories is the ordinary monorepo case —
    // refusing the whole connect over them would make discovery useless.
    //
    // `apps/api` is a Go service and the workspace declaration says nothing
    // about it, which is exactly why discovery does not stop at that
    // declaration: a repository is not one ecosystem's package list.
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
    // Detection would have said `service`. The file says `job` and the file
    // wins (§5) — including here, where Spindrift is writing the file back.
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
    // A row with no scope is a connection to nothing: the repo loop would
    // reconcile it forever and never find an App.
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
        // Both halves of a zero-config build travel with the proposal, so the
        // creation screen can render the `spindrift.yaml` this scope will get
        // rather than compose one from a subset of it.
        buildCommand: null,
        outputDirectory: null,
        watchPaths: ['.', 'go.mod'],
        configured: false,
        // The kinds detection ruled out travel with the proposal, so the
        // creation flow can render them disabled wearing their reason (§3).
        unavailable: {
          website: 'Go projects build a program, not a directory of files',
          job: 'jobs are asserted, never inferred',
        },
      },
    ]);
    // Read-only: no branch was cut, no pull request opened, no row written.
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
      // Still a website. An nginx-plus-files image that lost its static
      // rendering is the exact failure §5 names.
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
    // GitHub answers a repository that does not exist and one the installation
    // does not select identically, so the sentence names both rather than
    // asserting an existence nothing established.
    expect(result.failure.message).toContain('does not exist');
    expect(result.failure.message).toContain('repository selection');
  });

  test('a quota refusal is not a missing repository', async () => {
    // §15 splits `RATE_LIMITED` from `ACCESS_LOST` precisely so that an hour's
    // quota is never read as a repository that is gone. Collapsing them here
    // sends an operator to check an installation that is fine.
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
    // And no response body: the far side answers a refusal with JSON or with
    // somebody's error page, and neither is a sentence.
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

    // One recursive listing for the whole scan, not one per scope: this is
    // what makes inspection something a screen can do while somebody watches.
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
    // Listing refreshes every connected repository from the host. One that
    // fails must not empty the screen — and must not pass for current either,
    // because the commit beside it is then older than it looks.
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
        // The manifest's repository host, not the public one: an enterprise
        // installation clones from its own, and the browser reads no manifest.
        cloneUrl: 'https://git.example.test/example/available.git',
        rowExists: false,
      },
    ]);
  });
});
