/**
 * Stage one immutable source bundle before any build route sees it (§15).
 *
 * Repository and archive sources converge here. Core fetches an exact commit
 * once or accepts uploaded bytes, digests those bytes, stores them through a
 * content-addressed immutable depot, and signs the same source-receipt
 * predicate for both. The only deliberate storage difference is retention:
 * repository bundles are ephemeral and uploaded archives are durable.
 *
 * The Git credential is scoped to {@link ExactCommitFetcher.fetchExactCommit}.
 * It appears in no staged or signed type, which makes "store no token" a
 * structural property instead of a cleanup step.
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

/** A content-addressed bundle that every builder can fetch. */
export interface StagedSourceBundle {
  readonly digest: string;
  readonly location: string;
  readonly retention: BundleRetention;
}

/** The only result this seam exposes; credentials cannot fit in it. */
export interface StagedSource {
  readonly bundle: StagedSourceBundle;
  readonly receipt: SignedSourceReceipt;
  /** Durable address of the signed evidence, keyed by the bundle digest. */
  readonly receiptLocation: string;
}

/**
 * Fetch, store, and attest one exact repository commit as a single far-side
 * capability. The command receives only the immutable bundle; credentials and
 * receipt mechanics cannot leak into its transaction.
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
 * What the Git integration returns from one exact-revision fetch.
 *
 * Feature flags are facts learned while producing the archive. Core refuses
 * them before storage because v1 cannot reproduce a submodule or LFS checkout
 * from the single immutable bundle it promises builders.
 */
export interface FetchedCommit {
  readonly bytes: Uint8Array;
  readonly resolvedCommit: string;
  readonly hasSubmodules: boolean;
  readonly hasGitLfs: boolean;
  /**
   * Identity authenticated by the repository client that performed the fetch.
   * It comes back from the trusted integration instead of being asserted by the
   * caller asking core to stage a commit.
   */
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
 * Immutable object storage behind source staging.
 *
 * The digest is computed by core and handed to the depot with the bytes. A
 * production depot may reuse an object already present at that digest, but it
 * must never replace its bytes.
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
      /**
       * The application principal established by the session boundary, not a
       * receipt-shaped identity a caller may fill with an arbitrary subject.
       */
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
 * Fetch/upload → digest → immutable store → signed receipt.
 *
 * The sequence matters. Unsupported or incorrectly resolved Git input is
 * refused before storage, and a receipt is signed only after the depot accepted
 * the exact bytes its digest names.
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
        };

  // One owned snapshot feeds both digest and storage. Without it, an upload
  // buffer mutated while WebCrypto was running could be stored under the
  // digest of the bytes that existed a moment earlier.
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
    },
    receipt,
    receiptLocation: recorded.location,
  };
}

async function prepareGitBundle<Credential>(
  input: Extract<SourceBundleInput<Credential>, { kind: 'git' }>,
  fetcher: ExactCommitFetcher<Credential>,
) {
  // Exactly one fetch. The returned revision is checked rather than assuming a
  // client did not resolve a branch or tag after core asked for a commit.
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
