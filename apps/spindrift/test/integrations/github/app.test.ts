/**
 * The GitHub App integration (Task 24, §15).
 *
 * Two claims §15 makes are properties of this file rather than of anybody's
 * discipline, and both are asserted here:
 *
 * - **"Storing no token."** The only long-lived credential is the App key; the
 *   App JWT and the installation token are minted per use. The tests check that
 *   what leaves this module — a `FetchedCommit` staged by
 *   `src/domain/source-bundle.ts` — carries neither.
 * - **Lost access is a state, not a fault.** A selected-repository App can be
 *   un-selected at any time, and the response is a `404` indistinguishable from
 *   a repository that never existed. So `ACCESS_LOST` has to cover `401`, `403`
 *   and `404`, and a rate limit must *not* be mistaken for it — freezing a
 *   repository because an hour's quota ran out would turn a delay into an
 *   operator incident.
 */
import { describe, expect, test } from 'bun:test';
import { stageSourceBundle } from '../../../src/domain/source-bundle.ts';
import {
  GitHubApp,
  GitHubAppKeyError,
} from '../../../src/integrations/github/app.ts';
import { GitHubAccessError } from '../../../src/integrations/github/http.ts';
import { FakeGitHub, testAppKey } from '../../harness/fakes/github-api.ts';

const APP_ID = '1234567';

async function app(
  fake: FakeGitHub,
  now: () => Date = () => new Date('2026-07-28T12:00:00.000Z'),
) {
  const { pem, publicKey } = await testAppKey();
  return {
    publicKey,
    app: new GitHubApp(
      {
        appId: APP_ID,
        privateKeyPem: pem,
        baseUrl: fake.baseUrl,
        fetch: fake.fetch,
      },
      now,
    ),
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(padded));
}

describe('the App’s own JWT', () => {
  test('is signed by the App key and claims the App id', async () => {
    const fake = new FakeGitHub();
    const { app: github, publicKey } = await app(fake);
    const jwt = await github.appJwt();

    const [header, claims, signature] = jwt.split('.');
    expect(decodeSegment(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = decodeSegment(claims ?? '');
    const issuedAt = Math.floor(
      new Date('2026-07-28T12:00:00.000Z').getTime() / 1000,
    );
    expect(payload.iss).toBe(APP_ID);
    // Backdated by a minute: the documented remedy for a far side whose clock
    // runs behind this one, which it otherwise rejects outright.
    expect(payload.iat).toBe(issuedAt - 60);
    expect(payload.exp).toBeLessThanOrEqual(issuedAt + 600);

    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Uint8Array.from(
        atob((signature ?? '').replaceAll('-', '+').replaceAll('_', '/')),
        (character) => character.charCodeAt(0),
      ),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  test('refuses the PKCS#1 key the App UI hands out, and says how to convert it', async () => {
    const github = new GitHubApp({
      appId: APP_ID,
      privateKeyPem:
        '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
      baseUrl: 'https://api.git.invalid',
    });
    const signed = github.appJwt();
    await expect(signed).rejects.toBeInstanceOf(GitHubAppKeyError);
    await expect(signed).rejects.toThrow(/openssl pkcs8 -topk8/);
  });
});

describe('installation tokens', () => {
  test('are minted once and reused until they are close to expiring', async () => {
    const fake = new FakeGitHub({
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    const { app: github } = await app(fake);
    const ref = { installationId: fake.installationId };

    await github.repository(ref, fake.fullName);
    await github.repository(ref, fake.fullName);
    await github.branchHead(ref, fake.fullName, 'main').catch(() => null);

    expect(
      fake.requests.filter((request) =>
        request.path.includes('/access_tokens'),
      ),
    ).toHaveLength(1);
  });

  test('are re-minted once the cached one is inside the refresh margin', async () => {
    let clock = new Date('2026-07-28T12:00:00.000Z');
    const fake = new FakeGitHub({ now: () => clock });
    const { app: github } = await app(fake, () => clock);
    const ref = { installationId: fake.installationId };

    await github.repository(ref, fake.fullName);
    // The fake's tokens live an hour. A token that expires mid-request is a
    // `401` that reads exactly like lost access, which is the one
    // misclassification this integration must not make.
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await github.repository(ref, fake.fullName);

    expect(
      fake.requests.filter((request) =>
        request.path.includes('/access_tokens'),
      ),
    ).toHaveLength(2);
  });
});

describe('reading a repository', () => {
  test('reports the default branch rather than assuming one', async () => {
    const fake = new FakeGitHub({ defaultBranch: 'trunk' });
    const { app: github } = await app(fake);
    await expect(
      github.repository({ installationId: fake.installationId }, fake.fullName),
    ).resolves.toEqual({ defaultBranch: 'trunk' });
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
    // §15: "fetches the exact commit **once**".
    expect(fake.tarballs).toEqual([commit]);
  });

  test('reports the revision the far side resolved, not the one asked for', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { app: github } = await app(fake);

    // Asking by branch name is what `stageSourceBundle`'s mismatch check exists
    // to catch. It can only catch it if this reports what actually resolved.
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

    // `readFile` tolerates a 404 and everything else does not. A repository
    // that answers 404 for *itself* must not be readable as "no such file".
    await expect(
      github.repository(
        { installationId: fake.installationId },
        'example/somebody-elses',
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_LOST' });
  });
});
