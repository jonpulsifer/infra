/**
 * Stages one immutable source bundle, from a repository commit or an upload,
 * and signs its source receipt. The Git credential stays inside
 * {@link ExactCommitFetcher.fetchExactCommit}; no staged or signed type holds it.
 */

import type { Principal } from '../commands/types.ts';
import {
  type ReceiptSigner,
  type SignedSourceReceipt,
  type SourcePrincipal,
  type SourceReceiptStore,
  signSourceReceipt,
  sourceReceiptStatement,
} from '../supply-chain/receipt.ts';
import type { RepositoryRef } from './repository.ts';

export type BundleRetention = 'ephemeral' | 'durable';

/**
 * What the host said about a commit beyond its sha, kept so a Build row reads
 * without a second lookup. `message` is the headline only.
 */
export interface CommitHeadline {
  readonly message: string | null;
  /** The host's login for the author where it knows one, else the name on the commit. */
  readonly author: string | null;
  readonly authoredAt: Date | null;
}

export interface StagedSourceBundle {
  readonly digest: string;
  readonly location: string;
  readonly retention: BundleRetention;
  /** Present for a repository commit; an upload has none. */
  readonly commit?: CommitHeadline;
}

/** Keeps any real headline whole and cuts a pasted stack trace. */
export const COMMIT_HEADLINE_LIMIT = 200;

/** The first line, trimmed and capped. A blank message reads as `null`. */
export function commitHeadlineOf(message: string | null): string | null {
  const line = message?.split('\n', 1)[0]?.trim() ?? '';
  return line.length === 0 ? null : line.slice(0, COMMIT_HEADLINE_LIMIT);
}

/** The only result this interface exposes; credentials cannot fit in it. */
export interface StagedSource {
  readonly bundle: StagedSourceBundle;
  readonly receipt: SignedSourceReceipt;
  /** Durable address of the signed evidence, keyed by the bundle digest. */
  readonly receiptLocation: string;
}

/**
 * Fetches, stores and attests one exact commit as one far-side capability; the
 * command receives only the immutable bundle.
 */
export interface RepositorySourceStager {
  stageRepository(input: {
    readonly ref: RepositoryRef;
    readonly repository: string;
    readonly commit: string;
    readonly stagedAt: Date;
  }): Promise<StagedSourceBundle>;
}

/**
 * Submodules and LFS are refused before storage: one immutable bundle cannot
 * reproduce either checkout for a builder.
 */
export interface FetchedCommit {
  readonly bytes: Uint8Array;
  readonly resolvedCommit: string;
  readonly hasSubmodules: boolean;
  readonly hasGitLfs: boolean;
  /** `null` where the host reported none. Core keeps only the headline. */
  readonly message: string | null;
  readonly author: string | null;
  readonly authoredAt: Date | null;
  /** Authenticated by the fetching client, never asserted by the caller. */
  readonly principal: Extract<SourcePrincipal, { kind: 'githubApp' }>;
}

/** Far-side repository client. `Credential` remains opaque to core. */
export interface ExactCommitFetcher<Credential> {
  fetchExactCommit(input: {
    readonly repository: string;
    readonly commit: string;
    readonly credential: Credential;
  }): Promise<FetchedCommit>;
}

/**
 * Core computes the digest. A depot may reuse an object already at that digest
 * but must never replace its bytes.
 */
export interface BundleDepot {
  putImmutable(input: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly retention: BundleRetention;
  }): Promise<{ readonly location: string }>;
}

export type SourceBundleInput<Credential> =
  | {
      readonly kind: 'git';
      readonly repository: string;
      readonly commit: string;
      readonly credential: Credential;
    }
  | {
      readonly kind: 'upload';
      readonly bytes: Uint8Array;
      readonly name: string;
      /** From the session, never a subject the caller chose. */
      readonly principal: Principal;
    };

export type SourceBundleErrorCode =
  | 'FETCHED_COMMIT_MISMATCH'
  | 'GIT_SUBMODULES_UNSUPPORTED'
  | 'GIT_LFS_UNSUPPORTED';

/** A closed, user-readable refusal from source staging. */
export class SourceBundleError extends Error {
  constructor(
    readonly code: SourceBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceBundleError';
  }
}

export interface SourceBundleDeps<Credential> {
  readonly fetcher: ExactCommitFetcher<Credential>;
  readonly depot: BundleDepot;
  readonly signer: ReceiptSigner;
  readonly receipts: SourceReceiptStore;
}

/**
 * Bad Git input is refused before storage, and a receipt is signed only after
 * the depot accepts the bytes its digest names.
 */
export async function stageSourceBundle<Credential>(
  input: SourceBundleInput<Credential>,
  deps: SourceBundleDeps<Credential>,
  stagedAt: Date,
): Promise<StagedSource> {
  const prepared =
    input.kind === 'git'
      ? await prepareGitBundle(input, deps.fetcher)
      : {
          bytes: input.bytes,
          retention: 'durable' as const,
          source: { kind: 'upload' as const, name: input.name },
          principal: {
            kind: 'user' as const,
            subject: input.principal.id,
          },
          commit: undefined,
        };

  // One owned copy feeds both digest and storage, so a buffer mutated during
  // hashing cannot be stored under another digest.
  const bytes = Uint8Array.from(prepared.bytes);
  const digest = await sha256(bytes);
  const stored = await deps.depot.putImmutable({
    bytes,
    digest,
    retention: prepared.retention,
  });
  const statement = sourceReceiptStatement({
    bundleDigest: digest,
    source: prepared.source,
    principal: prepared.principal,
    stagedAt,
  });
  const receipt = await signSourceReceipt(statement, deps.signer);
  const recorded = await deps.receipts.putImmutable(receipt);

  return {
    bundle: {
      digest,
      location: stored.location,
      retention: prepared.retention,
      ...(prepared.commit === undefined ? {} : { commit: prepared.commit }),
    },
    receipt,
    receiptLocation: recorded.location,
  };
}

async function prepareGitBundle<Credential>(
  input: Extract<SourceBundleInput<Credential>, { kind: 'git' }>,
  fetcher: ExactCommitFetcher<Credential>,
) {
  // A client may resolve a branch or tag, so the returned revision is checked.
  const fetched = await fetcher.fetchExactCommit({
    repository: input.repository,
    commit: input.commit,
    credential: input.credential,
  });

  if (fetched.resolvedCommit !== input.commit) {
    throw new SourceBundleError(
      'FETCHED_COMMIT_MISMATCH',
      `the repository returned ${fetched.resolvedCommit} instead of requested commit ${input.commit}`,
    );
  }
  if (fetched.hasSubmodules) {
    throw new SourceBundleError(
      'GIT_SUBMODULES_UNSUPPORTED',
      'Git submodules are not supported in v1',
    );
  }
  if (fetched.hasGitLfs) {
    throw new SourceBundleError(
      'GIT_LFS_UNSUPPORTED',
      'Git LFS is not supported in v1',
    );
  }

  return {
    bytes: fetched.bytes,
    retention: 'ephemeral' as const,
    source: {
      kind: 'git' as const,
      repository: input.repository,
      commit: fetched.resolvedCommit,
    },
    principal: fetched.principal,
    commit: {
      message: commitHeadlineOf(fetched.message),
      author: fetched.author,
      authoredAt: fetched.authoredAt,
    } satisfies CommitHeadline,
  };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes.buffer),
  );
  const hex = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}
