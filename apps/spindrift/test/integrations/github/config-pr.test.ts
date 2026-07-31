/**
 * The one configuration pull request (Task 24, §15).
 *
 * Task 24's first acceptance criterion — "a fake GitHub API asserts the PR
 * contains **exactly** the Spindrift files plus one workflow caller" — is the
 * whole reason `test/harness/fakes/github-api.ts` models blobs, trees, and
 * `base_tree` layering rather than only recording requests. `exactly` is a
 * claim about the resulting tree, and a test that asserted on the calls would
 * be asserting that the right things were *asked for*, which is a weaker and
 * much easier thing to be right about by accident.
 *
 * The second claim tested here is §15's "**lossless** serialization": what
 * Spindrift writes into a repository has to parse back to what Spindrift meant,
 * or the file it asks a human to edit is a file it will misread.
 */
import { describe, expect, test } from 'bun:test';
import type { DetectionProposal } from '../../../src/domain/detection/ladder.ts';
import { parseSpindriftFile } from '../../../src/domain/detection/spindrift-file.ts';
import { GitHubApp } from '../../../src/integrations/github/app.ts';
import {
  buildWorkflowCaller,
  CONFIG_BRANCH,
  configurationTransaction,
  openConfigurationPullRequest,
  SPINDRIFT_FILE,
  serializeSpindriftFile,
  WORKFLOW_PATH,
} from '../../../src/integrations/github/config-pr.ts';
import { FakeGitHub } from '../../harness/fakes/github-api.ts';

const BUILD_WORKFLOW =
  'example/platform/.github/workflows/spindrift-build.yml@4bf1f21a7c1e2d3b5a6f708192a3b4c5d6e7f809';

const railpack: DetectionProposal = {
  source: 'railpack',
  kind: 'website',
  kinds: [{ kind: 'website', available: true }],
  build: {
    frontend: 'railpack',
    buildCommand: 'bun run build',
    outputDirectory: 'dist',
  },
  watchPaths: ['apps/site', 'packages/ui'],
};

const dockerfile: DetectionProposal = {
  source: 'railpack',
  kind: 'service',
  kinds: [{ kind: 'service', available: true }],
  build: { frontend: 'dockerfile', dockerfile: 'Dockerfile' },
  watchPaths: ['services/api'],
};

function app(fake: FakeGitHub, customFetch?: typeof fetch): GitHubApp {
  return new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-user-token',
    fetch: customFetch ?? fake.fetch,
  });
}

describe('the Spindrift file Spindrift writes', () => {
  test.each([
    ['a zero-config build', railpack],
    ['a Dockerfile build', dockerfile],
  ] as const)('round-trips through its own parser: %s', (_name, proposal) => {
    const parsed = parseSpindriftFile(serializeSpindriftFile(proposal));

    expect(parsed.kind).toBe(proposal.kind);
    expect(parsed.build).toEqual(proposal.build);
    expect(parsed.watchPaths).toEqual(proposal.watchPaths);
    // The parser reports the file as the source, which is the point of writing
    // it: §5's ladder puts an in-repo file above detection.
    expect(parsed.source).toBe('spindrift-file');
  });

  test('round-trips a zero-config build that declares neither command', () => {
    const bare: DetectionProposal = {
      ...railpack,
      build: {
        frontend: 'railpack',
        buildCommand: null,
        outputDirectory: null,
      },
    };
    expect(parseSpindriftFile(serializeSpindriftFile(bare)).build).toEqual(
      bare.build,
    );
  });

  test('is block-style YAML a person can edit', () => {
    const written = serializeSpindriftFile(railpack);
    expect(written).toContain('component:\n  kind: website');
    expect(written).toContain('watchPaths:\n  - apps/site');
    expect(written).not.toContain('{');
  });
});

describe('the CI caller', () => {
  test('calls the pinned reusable workflow and nothing else', () => {
    const caller = buildWorkflowCaller(BUILD_WORKFLOW);
    expect(caller).toContain(`uses: ${BUILD_WORKFLOW}`);
    // §15: the run happens in the connected repository, so the trigger is a
    // dispatch Spindrift makes rather than a push this repository takes.
    expect(caller).toContain('workflow_dispatch:');
    expect(caller).not.toContain('on: push');
    // §15's workflow-ref-scoped cloud identity: federated, never a stored
    // credential this file would have to carry.
    expect(caller).toContain('id-token: write');
    expect(caller).not.toMatch(/secrets\./);
  });
});

describe('the transaction', () => {
  test('is one file per scope plus exactly one caller', () => {
    const transaction = configurationTransaction({
      scopes: [
        { scope: 'apps/site', proposal: railpack },
        { scope: 'services/api', proposal: dockerfile },
      ],
      buildWorkflow: BUILD_WORKFLOW,
    });

    expect(transaction.files.map((file) => file.path)).toEqual([
      `apps/site/${SPINDRIFT_FILE}`,
      `services/api/${SPINDRIFT_FILE}`,
      WORKFLOW_PATH,
    ]);
    expect(transaction.branch).toBe(CONFIG_BRANCH);
  });

  test('puts a root scope’s file at the repository root', () => {
    const transaction = configurationTransaction({
      scopes: [{ scope: '.', proposal: railpack }],
      buildWorkflow: BUILD_WORKFLOW,
    });
    expect(transaction.files[0]?.path).toBe(SPINDRIFT_FILE);
  });

  test('refuses to be a pull request about nothing', () => {
    expect(() =>
      configurationTransaction({ scopes: [], buildWorkflow: BUILD_WORKFLOW }),
    ).toThrow(RangeError);
  });
});

describe('opening it against the repository API', () => {
  async function open(fake: FakeGitHub, customFetch?: typeof fetch) {
    const base = fake.commitFiles('main', {
      'README.md': 'the repository as it was',
      'apps/site/package.json': '{}',
    });
    const transaction = configurationTransaction({
      scopes: [
        { scope: 'apps/site', proposal: railpack },
        { scope: 'services/api', proposal: dockerfile },
      ],
      buildWorkflow: BUILD_WORKFLOW,
    });
    const opened = await openConfigurationPullRequest(
      app(fake, customFetch),
      { installationId: fake.installationId },
      {
        fullName: fake.fullName,
        defaultBranch: 'main',
        transaction,
      },
    );
    return { opened, transaction, base };
  }

  test('writes exactly the Spindrift files plus one workflow caller', async () => {
    const fake = new FakeGitHub();
    const { opened, base } = await open(fake);

    const before = fake.filesAt(base);
    const after = fake.filesAt(opened.commit);
    const added = Object.keys(after).filter((path) => !(path in before));

    expect(added.sort()).toEqual(
      [
        WORKFLOW_PATH,
        `apps/site/${SPINDRIFT_FILE}`,
        `services/api/${SPINDRIFT_FILE}`,
      ].sort(),
    );
    // Nothing else in the repository is touched: the review is about the
    // connection and nothing more.
    expect(after['README.md']).toBe('the repository as it was');
    expect(after['apps/site/package.json']).toBe('{}');
    expect(after[WORKFLOW_PATH]).toContain(`uses: ${BUILD_WORKFLOW}`);
    expect(
      parseSpindriftFile(after[`services/api/${SPINDRIFT_FILE}`] ?? '').build,
    ).toEqual(dockerfile.build);
  });

  test('is one commit, on its own branch, off the default branch', async () => {
    const fake = new FakeGitHub();
    const { opened, base } = await open(fake);

    expect(opened.branch).toBe(CONFIG_BRANCH);
    expect(fake.head(CONFIG_BRANCH)).toBe(opened.commit);
    // The default branch has not moved: §15 makes its merge the authoritative
    // act, and opening a pull request is not that act.
    expect(fake.head('main')).toBe(base);

    const commits = fake.requests.filter(
      (request) =>
        request.method === 'POST' && request.path.endsWith('/git/commits'),
    );
    expect(commits).toHaveLength(1);
  });

  test('opens one pull request against the default branch', async () => {
    const fake = new FakeGitHub();
    const { opened } = await open(fake);

    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0]).toMatchObject({
      number: opened.number,
      head: CONFIG_BRANCH,
      base: 'main',
    });
    expect(fake.pulls[0]?.body).toContain('apps/site');
    expect(fake.pulls[0]?.body).toContain('services/api');
  });

  test('re-running the connection replaces the branch rather than failing', async () => {
    const fake = new FakeGitHub();
    const first = await open(fake);
    const second = await open(fake);

    expect(second.opened.commit).not.toBe(first.opened.commit);
    expect(fake.head(CONFIG_BRANCH)).toBe(second.opened.commit);
    // The second run patched the existing ref rather than trying to create it
    // twice — a second connection is somebody correcting the first.
    expect(
      fake.requests.filter((request) => request.method === 'PATCH'),
    ).toHaveLength(2);
    expect(
      fake.requests.filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/git/refs'),
      ),
    ).toHaveLength(1);
  });

  test('recovers existing open pull request number when POST /pulls fails', async () => {
    const fake = new FakeGitHub();
    const first = await open(fake);

    // Simulate GitHub returning 422 when PR already exists
    const failingFetch = (async (request: any) => {
      const url = new URL(typeof request === 'string' ? request : request.url);
      if (request.method === 'POST' && url.pathname.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({
            message: 'Validation Failed',
            errors: [{ message: 'A pull request already exists' }],
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return fake.fetch(request);
    }) as any;

    const second = await open(fake, failingFetch);
    expect(second.opened.number).toBe(first.opened.number);
  });

  test('presents the user authorization without exposing it to callers', async () => {
    const fake = new FakeGitHub();
    await open(fake);

    for (const request of fake.requests) {
      expect(request.authorization).toBe('Bearer test-user-token');
    }
  });
});
