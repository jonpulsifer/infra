/**
 * The repository host, as core names it (§15).
 *
 * §15 settles one host — "reuse the existing selected-repository GitHub App" —
 * but core still declares the far side rather than importing it, for the same
 * reason `target.ts` declares `TargetConnection` instead of speaking any
 * cluster's API: the command layer and the repo loop are the two things §20's
 * extraction contract has to keep portable, and neither of them should know
 * what a GitHub App is. `src/integrations/github/` implements these interfaces;
 * nothing in `src/commands/` or `src/reconciler/` imports it.
 *
 * **The reference grants nothing.** Core holds and passes around
 * {@link RepositoryRef}—an installation identity, which is a string in a
 * database column. The encrypted installation-level credential stays inside
 * the host and is resolved at the moment of use; no repository command can
 * receive or return it.
 */

/**
 * How core names one installation of whatever integration reaches a repository.
 *
 * A single field, and it stays an object anyway: what a host needs to reach a
 * repository is the kind of thing that grows (an enterprise's own endpoint, a
 * second app), and a bare string would make every one of those a change at
 * every call site.
 */
export interface RepositoryRef {
  /** Opaque to core; meaningful only to the host that issued it. */
  readonly installationId: string;
}

/** One repository the authorized account can reach through an installation. */
export interface AvailableRepository {
  /** Stable far-side repository identity, useful as a UI selection key. */
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** Opaque installation identity; never accepted back from the browser. */
  readonly installationId: string;
}

/** The browser-safe state of the installation's repository authorization. */
export type RepositoryAuthorizationStatus =
  | { readonly state: 'unauthorized' }
  | {
      readonly state: 'authorized';
      readonly login: string;
      readonly githubUserId: string;
    };

/** The durable repository connector needs the operator to authorize again. */
export class RepositoryAuthorizationRequiredError extends Error {
  override readonly name = 'RepositoryAuthorizationRequiredError';
}

/** What beginning a user-mediated repository authorization returns. */
export interface RepositoryAuthorizationChallenge {
  readonly attemptId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: Date;
  readonly intervalSeconds: number;
}

/** What polling that challenge may conclude. */
export type RepositoryAuthorizationPoll =
  | {
      readonly state: 'pending';
      readonly retryAfterSeconds: number;
      readonly expiresAt: Date;
    }
  | {
      readonly state: 'authorized';
      readonly login: string;
    }
  | {
      readonly state: 'expired' | 'denied';
    };

/**
 * The optional user-authorization half of a repository integration.
 *
 * Kept beside, not inside, {@link RepositoryHost}: reconciliation only needs
 * repository operations and should not gain browser ceremony methods merely
 * because the concrete GitHub adapter implements both.
 */
export interface RepositoryAuthorization {
  status(): Promise<RepositoryAuthorizationStatus>;
  begin(userId: string): Promise<RepositoryAuthorizationChallenge>;
  poll(userId: string, attemptId: string): Promise<RepositoryAuthorizationPoll>;
  repositories(): Promise<readonly AvailableRepository[]>;
  installationFor(fullName: string): Promise<RepositoryRef>;
}

/** What reconciliation reads (§15). */
export interface RepositoryReader {
  /** The repository's own facts. §15 reads the default branch, never assumes it. */
  repository(
    ref: RepositoryRef,
    fullName: string,
  ): Promise<{ readonly defaultBranch: string }>;
  /** The commit a branch currently points at. */
  branchHead(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
  ): Promise<string>;
  /** One file at one exact commit, or `null` when it is not there. */
  readFile(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null>;
  /**
   * Every file at one exact commit, root-relative.
   *
   * Detection needs to know what is in a directory before anything has been
   * checked out (§5), and this is the one call that answers it. Files only:
   * a tree's directories are implied by the paths inside them, and core has no
   * use for an entry that names a container rather than content.
   */
  treePaths(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
  ): Promise<readonly string[]>;
}

/**
 * What opening the configuration pull request writes (§15).
 *
 * Git's own object model rather than a "put this file" verb, because §15 makes
 * the whole PR one transaction: blobs, one tree over the default branch's, one
 * commit, one branch, one pull request. A per-file write verb would make the
 * transaction a sequence of commits and give a partially written configuration
 * a way to exist.
 */
export interface RepositoryWriter {
  /** The tree one commit points at. */
  commitTree(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
  ): Promise<string>;
  /** Store one file's bytes and return the blob they are addressed by. */
  createBlob(
    ref: RepositoryRef,
    fullName: string,
    contents: string,
  ): Promise<string>;
  /** A tree layered over an existing one — everything else is left alone. */
  createTree(
    ref: RepositoryRef,
    fullName: string,
    baseTree: string,
    entries: readonly { readonly path: string; readonly blob: string }[],
  ): Promise<string>;
  /** One commit over one tree. */
  createCommit(
    ref: RepositoryRef,
    fullName: string,
    input: {
      readonly message: string;
      readonly tree: string;
      readonly parent: string;
    },
  ): Promise<string>;
  /** Point a branch at a commit, creating it if it is not there. */
  setBranch(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
    commit: string,
  ): Promise<void>;
  /** Open the pull request and return its number. */
  openPullRequest(
    ref: RepositoryRef,
    fullName: string,
    input: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
    },
  ): Promise<number>;
}

/** Everything one repository host does. */
export interface RepositoryHost extends RepositoryReader, RepositoryWriter {
  /**
   * Resolve the opaque installation covering a repository.
   *
   * Optional because non-GitHub/fake repository hosts can operate from an
   * already persisted reference. Connecting a new repository requires it.
   */
  installationFor?(fullName: string): Promise<RepositoryRef>;
}

/** The reference for a stored repository row. */
export function repositoryRefOf(row: {
  readonly installationId: string;
}): RepositoryRef {
  return { installationId: row.installationId };
}
