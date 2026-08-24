/**
 * Source custody at the seam between repository integration and every builder
 * (Task 23).
 *
 * These tests fake the two far sides — the repository and the immutable bundle
 * depot — while exercising core's real digesting, receipt construction, and
 * signing. That makes "fetch once", "store no token", and the provenance join
 * observable without choosing GitHub or GCS clients ahead of their tickets.
 */
import { describe, expect, test } from 'bun:test';
import type { BuildProvenance } from '../../src/adapters/build/contract.ts';
import {
  type BundleDepot,
  COMMIT_HEADLINE_LIMIT,
  commitHeadlineOf,
  type ExactCommitFetcher,
  SourceBundleError,
  stageSourceBundle,
} from '../../src/domain/source-bundle.ts';
import {
  type ReceiptSigner,
  receiptJoinsProvenance,
  type SourceReceiptStore,
} from '../../src/supply-chain/receipt.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BYTES = new TextEncoder().encode('the exact source bundle');
const DIGEST =
  'sha256:20c50fe07e8995fc04d396f4e4b0eeddd221d86e33be9726a17e42f6429d7f95';
const MESSAGE =
  'feat(spindrift): keep the headline\n\nA body the ledger never shows.';
const AUTHORED_AT = new Date('2026-07-27T09:30:00.000Z');
/** What the bundle keeps of {@link MESSAGE}: the first line only. */
const HEADLINE = {
  message: 'feat(spindrift): keep the headline',
  author: 'octocat',
  authoredAt: AUTHORED_AT,
};

function harness(options?: {
  resolvedCommit?: string;
  hasSubmodules?: boolean;
  hasGitLfs?: boolean;
  message?: string | null;
  author?: string | null;
}) {
  const fetches: unknown[] = [];
  const puts: unknown[] = [];
  const signedPayloads: Uint8Array[] = [];
  const storedReceipts: unknown[] = [];

  const fetcher: ExactCommitFetcher<{ readonly token: string }> = {
    async fetchExactCommit(input) {
      fetches.push(input);
      return {
        bytes: BYTES,
        resolvedCommit: options?.resolvedCommit ?? input.commit,
        hasSubmodules: options?.hasSubmodules ?? false,
        hasGitLfs: options?.hasGitLfs ?? false,
        message: options?.message === undefined ? MESSAGE : options.message,
        author: options?.author === undefined ? 'octocat' : options.author,
        authoredAt: AUTHORED_AT,
        principal: {
          kind: 'githubApp',
          subject: 'installation:42',
        },
      };
    },
  };

  const depot: BundleDepot = {
    async putImmutable(input) {
      puts.push(input);
      return { location: `bundles/${input.digest}.tar` };
    },
  };

  const signer: ReceiptSigner = {
    async sign(payload) {
      signedPayloads.push(payload);
      return {
        keyId: 'test-source-receipt',
        algorithm: 'test',
        value: 'signed',
      };
    },
  };

  const receipts: SourceReceiptStore = {
    async putImmutable(receipt) {
      storedReceipts.push(receipt);
      return {
        location: `receipts/${receipt.statement.subject.digest}.json`,
      };
    },
  };

  return {
    fetcher,
    depot,
    signer,
    receipts,
    fetches,
    puts,
    signedPayloads,
    storedReceipts,
  };
}

describe('repository bundle staging', () => {
  test('fetches the exact commit once and stages an ephemeral immutable bundle', async () => {
    const farSide = harness();
    const credential = { token: 'never-store-this' };

    const result = await stageSourceBundle(
      {
        kind: 'git',
        repository: 'https://example.test/owner/repo',
        commit: COMMIT,
        credential,
      },
      farSide,
      new Date('2026-07-28T12:00:00.000Z'),
    );

    expect(farSide.fetches).toHaveLength(1);
    expect(farSide.fetches[0]).toEqual({
      repository: 'https://example.test/owner/repo',
      commit: COMMIT,
      credential,
    });
    expect(farSide.puts).toEqual([
      {
        bytes: BYTES,
        digest: DIGEST,
        retention: 'ephemeral',
      },
    ]);
    expect((farSide.puts[0] as { bytes: Uint8Array }).bytes).not.toBe(BYTES);
    expect(result.bundle).toEqual({
      digest: DIGEST,
      location: `bundles/${DIGEST}.tar`,
      retention: 'ephemeral',
      commit: HEADLINE,
    });
    expect(result.receiptLocation).toBe(`receipts/${DIGEST}.json`);
    expect(result.receipt.statement.predicate.source).toEqual({
      kind: 'git',
      repository: 'https://example.test/owner/repo',
      commit: COMMIT,
    });
    expect(result.receipt.statement.predicate.principal).toEqual({
      kind: 'githubApp',
      subject: 'installation:42',
    });
    expect(farSide.storedReceipts).toEqual([result.receipt]);

    // The fetch credential reaches only the fetcher. Neither the result nor the
    // bytes handed to the signer retain it.
    expect(JSON.stringify(result)).not.toContain(credential.token);
    expect(new TextDecoder().decode(farSide.signedPayloads[0])).not.toContain(
      credential.token,
    );
  });

  test.each([
    ['submodules', { hasSubmodules: true }, 'GIT_SUBMODULES_UNSUPPORTED'],
    ['Git LFS', { hasGitLfs: true }, 'GIT_LFS_UNSUPPORTED'],
  ] as const)(
    'refuses %s explicitly before staging',
    async (_name, flags, code) => {
      const farSide = harness(flags);

      const staged = stageSourceBundle(
        {
          kind: 'git',
          repository: 'https://example.test/owner/repo',
          commit: COMMIT,
          credential: { token: 'temporary' },
        },
        farSide,
        new Date(),
      );

      await expect(staged).rejects.toMatchObject({ code });
      expect(farSide.fetches).toHaveLength(1);
      expect(farSide.puts).toHaveLength(0);
      expect(farSide.signedPayloads).toHaveLength(0);
      expect(farSide.storedReceipts).toHaveLength(0);
    },
  );

  test('refuses a fetcher that returns a different revision', async () => {
    const farSide = harness({
      resolvedCommit: 'ffffffffffffffffffffffffffffffffffffffff',
    });

    const staged = stageSourceBundle(
      {
        kind: 'git',
        repository: 'https://example.test/owner/repo',
        commit: COMMIT,
        credential: { token: 'temporary' },
      },
      farSide,
      new Date(),
    );

    await expect(staged).rejects.toBeInstanceOf(SourceBundleError);
    await expect(staged).rejects.toMatchObject({
      code: 'FETCHED_COMMIT_MISMATCH',
    });
    expect(farSide.puts).toHaveLength(0);
    expect(farSide.storedReceipts).toHaveLength(0);
  });
});

describe('archive bundle staging', () => {
  test('stages uploads durably under the same receipt predicate', async () => {
    const farSide = harness();

    const result = await stageSourceBundle(
      {
        kind: 'upload',
        bytes: BYTES,
        name: 'site.zip',
        principal: { id: 'user-7', displayName: 'Operator' },
      },
      farSide,
      new Date('2026-07-28T12:00:00.000Z'),
    );

    expect(farSide.fetches).toHaveLength(0);
    expect(farSide.puts).toEqual([
      { bytes: BYTES, digest: DIGEST, retention: 'durable' },
    ]);
    expect(result.receipt.statement.predicate).toEqual({
      source: { kind: 'upload', name: 'site.zip' },
      principal: { kind: 'user', subject: 'user-7' },
      stagedAt: '2026-07-28T12:00:00.000Z',
    });
  });

  test('the signed receipt joins the build provenance on the bundle digest', async () => {
    const farSide = harness();
    const staged = await stageSourceBundle(
      {
        kind: 'upload',
        bytes: BYTES,
        name: 'source.zip',
        principal: { id: 'user-7', displayName: 'Operator' },
      },
      farSide,
      new Date(),
    );
    const provenance: BuildProvenance = {
      bundleDigest: staged.bundle.digest,
      claimedLevel: 2,
      statement: { builder: 'far-side' },
    };

    expect(receiptJoinsProvenance(staged.receipt, provenance)).toBe(true);
    expect(
      receiptJoinsProvenance(staged.receipt, {
        ...provenance,
        bundleDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(staged.receipt.statement.subject.digest).toBe(
      provenance.bundleDigest,
    );
  });
});

describe('what a bundle keeps of the commit beyond its sha', () => {
  test('the headline is the first line, and an upload has none', async () => {
    const farSide = harness();
    const git = await stageSourceBundle(
      {
        kind: 'git',
        repository: 'owner/repo',
        commit: COMMIT,
        credential: { token: 'never-store-this' },
      },
      farSide,
      new Date(),
    );
    expect(git.bundle.commit).toEqual(HEADLINE);

    const upload = await stageSourceBundle(
      {
        kind: 'upload',
        bytes: BYTES,
        name: 'site.tar',
        principal: { id: 'user-1', displayName: 'Operator' },
      },
      farSide,
      new Date(),
    );
    expect(upload.bundle.commit).toBeUndefined();
  });

  test('a host that reports no message or author stages a bundle that says so', async () => {
    const farSide = harness({ message: null, author: null });
    const staged = await stageSourceBundle(
      {
        kind: 'git',
        repository: 'owner/repo',
        commit: COMMIT,
        credential: { token: 'never-store-this' },
      },
      farSide,
      new Date(),
    );
    expect(staged.bundle.commit).toEqual({
      message: null,
      author: null,
      authoredAt: AUTHORED_AT,
    });
  });

  test.each([
    ['  spaced subject  \nbody', 'spaced subject'],
    ['\n\nleading blank lines', null],
    ['', null],
    [null, null],
    ['x'.repeat(COMMIT_HEADLINE_LIMIT + 50), 'x'.repeat(COMMIT_HEADLINE_LIMIT)],
  ])(
    'commitHeadlineOf(%j) is the trimmed, capped first line',
    (message, expected) => {
      expect(commitHeadlineOf(message)).toBe(expected);
    },
  );
});
