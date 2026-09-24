/**
 * The GitHub App client. Nothing it returns carries a bearer credential, and
 * `ACCESS_LOST` covers a `401`, `403` or `404` but never a rate limit.
 */
import { describe, expect, test } from 'bun:test';
import { stageSourceBundle } from '../../../src/domain/source-bundle.ts';
import { GitHubApp } from '../../../src/integrations/github/app.ts';
import { GitHubAccessError } from '../../../src/integrations/github/http.ts';
import { FakeGitHub } from '../../harness/fakes/github-api.ts';

async function app(fake: FakeGitHub) {
  return {
    app: new GitHubApp({
      baseUrl: fake.baseUrl,
      authorization: () => 'Bearer test-installation-token',
      appAuthorization: () => 'Bearer test-app-jwt',
      fetch: fake.fetch,
    }),
  };
}

describe('reading a repository', () => {
  test('reports the default branch rather than assuming one', async () => {
    const fake = new FakeGitHub({ defaultBranch: 'trunk' });
    const { app: github } = await app(fake);
    await expect(
      github.repository({ installationId: fake.installationId }, fake.fullName),
    ).resolves.toEqual({ defaultBranch: 'trunk', fullName: fake.fullName });
  });

  test('reports the name the host uses now, not the one it was asked by', async () => {
    const fake = new FakeGitHub();
    const { app: github } = await app(fake);
    fake.rename('example/renamed');

    // GitHub redirects the old name; only the body shows the rename.
    await expect(
      github.repository({ installationId: fake.installationId }, 'example/app'),
    ).resolves.toEqual({ defaultBranch: 'main', fullName: 'example/renamed' });
  });

  test('returns null for a file that is not there, and only for that', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'spindrift.yaml': 'version: 1' });
    const { app: github } = await app(fake);
    const ref = { installationId: fake.installationId };

    await expect(
      github.readFile(ref, fake.fullName, commit, 'spindrift.yaml'),
    ).resolves.toBe('version: 1');
    await expect(
      github.readFile(ref, fake.fullName, commit, 'nowhere.yaml'),
    ).resolves.toBeNull();
  });
});

describe('fetching one exact commit', () => {
  test('resolves the revision, downloads one archive, and names the principal', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { app: github } = await app(fake);

    const fetched = await github.fetchExactCommit({
      repository: fake.fullName,
      commit,
      credential: { installationId: fake.installationId },
    });

    expect(fetched.resolvedCommit).toBe(commit);
    expect(fetched.hasSubmodules).toBe(false);
    expect(fetched.hasGitLfs).toBe(false);
    expect(fetched.principal).toEqual({
      kind: 'githubApp',
      subject: `installation:${fake.installationId}`,
    });
    expect(fake.tarballs).toEqual([commit]);
  });

  test('reports the revision the far side resolved, not the one asked for', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { app: github } = await app(fake);

    // Only a resolved sha lets `stageSourceBundle` catch a branch name.
    const fetched = await github.fetchExactCommit({
      repository: fake.fullName,
      commit: 'main',
      credential: { installationId: fake.installationId },
    });
    expect(fetched.resolvedCommit).toBe(commit);
  });

  test.each([
    ['.gitmodules', 'a submodule declaration', 'hasSubmodules'],
    ['.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs', 'hasGitLfs'],
  ] as const)(
    'reports %s so staging can refuse it',
    async (path, contents, flag) => {
      const fake = new FakeGitHub();
      const commit = fake.commitFiles('main', { [path]: contents });
      const { app: github } = await app(fake);

      const fetched = await github.fetchExactCommit({
        repository: fake.fullName,
        commit,
        credential: { installationId: fake.installationId },
      });
      expect(fetched[flag]).toBe(true);
    },
  );

  test('an ordinary .gitattributes is not LFS', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', {
      '.gitattributes': '* text=auto eol=lf',
    });
    const { app: github } = await app(fake);

    const fetched = await github.fetchExactCommit({
      repository: fake.fullName,
      commit,
      credential: { installationId: fake.installationId },
    });
    expect(fetched.hasGitLfs).toBe(false);
  });

  test('stages through source-bundle with no token in the result', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { app: github } = await app(fake);

    const signedPayloads: Uint8Array[] = [];
    const staged = await stageSourceBundle(
      {
        kind: 'git',
        repository: fake.fullName,
        commit,
        credential: { installationId: fake.installationId },
      },
      {
        fetcher: github,
        depot: {
          async putImmutable(input) {
            return { location: `bundles/${input.digest}.tar` };
          },
        },
        signer: {
          async sign(payload) {
            signedPayloads.push(payload);
            return { keyId: 'test', algorithm: 'test', value: 'signed' };
          },
        },
        receipts: {
          async putImmutable(receipt) {
            return { location: `receipts/${receipt.statement.subject.digest}` };
          },
        },
      },
      new Date('2026-07-28T12:00:00.000Z'),
    );

    expect(staged.bundle.retention).toBe('ephemeral');
    expect(staged.receipt.statement.predicate.principal).toEqual({
      kind: 'githubApp',
      subject: `installation:${fake.installationId}`,
    });
    // The minted token reached the transport and nothing else.
    expect(JSON.stringify(staged)).not.toContain('installation-token');
    expect(new TextDecoder().decode(signedPayloads[0])).not.toContain(
      'installation-token',
    );
  });
});

describe('what the far side refusing means', () => {
  test('a repository the App can no longer see is lost access', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { app: github } = await app(fake);
    fake.accessLost = true;

    const read = github.repository(
      { installationId: fake.installationId },
      fake.fullName,
    );
    await expect(read).rejects.toBeInstanceOf(GitHubAccessError);
    await expect(read).rejects.toMatchObject({ code: 'ACCESS_LOST' });
  });

  test('a quota refusal is emphatically not lost access', async () => {
    const fake = new FakeGitHub();
    const { app: github } = await app(fake);
    fake.rateLimited = true;

    const read = github.repository(
      { installationId: fake.installationId },
      fake.fullName,
    );
    await expect(read).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('a repository this host does not serve is lost access, not a null', async () => {
    const fake = new FakeGitHub();
    const { app: github } = await app(fake);

    // Only `readFile` tolerates a 404; a repository's own 404 is lost access.
    await expect(
      github.repository(
        { installationId: fake.installationId },
        'example/somebody-elses',
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_LOST' });
  });
});

/** The fake's content negotiation, matching the real API's refusals. */
describe('the media types this host serves', () => {
  function get(fake: FakeGitHub, path: string, accept: string) {
    return fake.fetch(
      new Request(`${fake.baseUrl}${path}`, { headers: { Accept: accept } }),
    );
  }

  test('a job log asked for as text is refused, as the real API refuses it', async () => {
    const fake = new FakeGitHub();
    const refused = await get(
      fake,
      `/repos/${fake.fullName}/actions/jobs/1/logs`,
      'text/plain',
    );

    expect(refused.status).toBe(415);
    expect(await refused.text()).toContain("Must accept 'application/json'");
  });

  test('a job log asked for as JSON gets past negotiation to the job itself', async () => {
    const fake = new FakeGitHub();
    const answered = await get(
      fake,
      `/repos/${fake.fullName}/actions/jobs/1/logs`,
      'application/vnd.github+json',
    );

    // No run was dispatched, so a 404 means negotiation let the request through.
    expect(answered.status).toBe(404);
  });

  test('file contents are raw only to a client that asked for raw', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'spindrift.yaml': 'version: 1' });
    const path = `/repos/${fake.fullName}/contents/spindrift.yaml?ref=main`;

    const raw = await get(fake, path, 'application/vnd.github.raw');
    expect(await raw.text()).toBe('version: 1');

    // The default media type answers with a JSON metadata envelope.
    const envelope = await get(fake, path, 'application/vnd.github+json');
    expect(await envelope.json()).toMatchObject({ encoding: 'base64' });
  });
});

describe('which installations this App operates for', () => {
  test('installationFor asks the host exactly, with the App JWT', async () => {
    const fake = new FakeGitHub({ installationId: '37547020' });
    const { app: github } = await app(fake);

    await expect(github.installationFor(fake.fullName)).resolves.toEqual({
      installationId: '37547020',
    });
    const asked = fake.requests.find((request) =>
      request.path.endsWith('/installation'),
    );
    expect(asked?.authorization).toBe('Bearer test-app-jwt');
  });

  test('a stranger account is refused, never operated on', async () => {
    // Anyone can install a public App; an unrecognized account gets the same
    // refusal as a missing repository.
    const fake = new FakeGitHub({ accountLogin: 'a-stranger' });
    const github = new GitHubApp({
      baseUrl: fake.baseUrl,
      authorization: () => 'Bearer test-installation-token',
      appAuthorization: () => 'Bearer test-app-jwt',
      recognizedAccounts: ['example'],
      fetch: fake.fetch,
    });

    await expect(github.installationFor(fake.fullName)).rejects.toMatchObject({
      code: 'ACCESS_LOST',
    });
  });

  test('enumeration walks the App installations and each grant', async () => {
    const fake = new FakeGitHub({ installationId: '37547020' });
    const { app: github } = await app(fake);

    await expect(github.availableRepositories()).resolves.toEqual([
      {
        repositoryId: '1',
        fullName: fake.fullName,
        defaultBranch: 'main',
        installationId: '37547020',
      },
    ]);
    // The enumeration is JWT-side; the grant read is installation-side.
    expect(
      fake.requests.find((request) =>
        request.path.startsWith('/app/installations?'),
      )?.authorization,
    ).toBe('Bearer test-app-jwt');
    expect(
      fake.requests.find((request) =>
        request.path.startsWith('/installation/repositories'),
      )?.authorization,
    ).toBe('Bearer test-installation-token');
  });

  test('a stranger installation never reaches the grant read at all', async () => {
    const fake = new FakeGitHub({ accountLogin: 'a-stranger' });
    const github = new GitHubApp({
      baseUrl: fake.baseUrl,
      authorization: () => 'Bearer test-installation-token',
      appAuthorization: () => 'Bearer test-app-jwt',
      recognizedAccounts: ['example'],
      fetch: fake.fetch,
    });

    await expect(github.availableRepositories()).resolves.toEqual([]);
    expect(
      fake.requests.some((request) =>
        request.path.startsWith('/installation/repositories'),
      ),
    ).toBe(false);
  });
});

describe('what one exact commit says beyond its sha', () => {
  test('the message, the login and the authored instant come back with the archive', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles(
      'main',
      { 'README.md': 'hello' },
      {
        message: 'fix(web): stop the header wrapping\n\nBody text.',
        authorLogin: 'octocat',
        authoredAt: '2026-08-20T10:15:00Z',
      },
    );
    const { app: github } = await app(fake);

    const fetched = await github.fetchExactCommit({
      repository: fake.fullName,
      commit,
      credential: { installationId: fake.installationId },
    });

    // The whole message; core decides the headline.
    expect(fetched.message).toBe(
      'fix(web): stop the header wrapping\n\nBody text.',
    );
    expect(fetched.author).toBe('octocat');
    expect(fetched.authoredAt).toEqual(new Date('2026-08-20T10:15:00Z'));
    // Still one archive: the metadata rides on the resolve call.
    expect(fake.tarballs).toEqual([commit]);
  });

  test('an author the host matched to no user is named from the commit itself', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles(
      'main',
      { 'README.md': 'hello' },
      { authorLogin: null, authorName: 'Ada Lovelace' },
    );
    const { app: github } = await app(fake);

    const fetched = await github.fetchExactCommit({
      repository: fake.fullName,
      commit,
      credential: { installationId: fake.installationId },
    });
    expect(fetched.author).toBe('Ada Lovelace');
  });
});
