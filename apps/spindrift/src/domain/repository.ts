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
 * **The reference grants nothing.** §15 says Spindrift stores no token, so what
 * core holds and passes around is {@link RepositoryRef} — an installation
 * identity, which is a string in a database column. Every credential is minted
 * inside the host at the moment of use, which is what makes "storing no token"
 * a fact about the types rather than a rule somebody has to remember.
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
export interface RepositoryHost extends RepositoryReader, RepositoryWriter {}

/** The reference for a stored repository row. */
export function repositoryRefOf(row: {
  readonly installationId: string;
}): RepositoryRef {
  return { installationId: row.installationId };
}
