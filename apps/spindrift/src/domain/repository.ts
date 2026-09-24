/**
 * The repository host as core names it. Core holds only a {@link RepositoryRef};
 * the installation credential stays inside the host, resolved at use, and no
 * repository command receives or returns it.
 */

export interface RepositoryRef {
  /** Opaque to core; meaningful only to the host that issued it. */
  readonly installationId: string;
}

export interface AvailableRepository {
  /** Stable far-side repository identity, useful as a UI selection key. */
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** Opaque installation identity; never accepted back from the browser. */
  readonly installationId: string;
}

/**
 * `authorized` names the App, not a user, because installation tokens act as
 * the App's bot identity.
 */
export type RepositoryAuthorizationStatus =
  | { readonly state: 'unauthorized' }
  | {
      readonly state: 'authorized';
      readonly slug: string;
      readonly appId: string;
    };

/** The durable repository connector has no App identity to mint from. */
export class RepositoryAuthorizationRequiredError extends Error {
  override readonly name = 'RepositoryAuthorizationRequiredError';
}

/**
 * The manifest-flow form that creates the App identity: one POST from the
 * operator's browser to the host, returning to the setup route with a code.
 */
export interface RepositoryAuthorizationSetup {
  /** Where the form POSTs — the host's create-from-manifest page, `state` included. */
  readonly action: string;
  /** The manifest document, as the `manifest` form field's value. */
  readonly manifest: string;
}

/** The optional identity half of a repository integration. */
export interface RepositoryAuthorization {
  status(): Promise<RepositoryAuthorizationStatus>;
  /** The create-the-App form, bound to the acting operator for CSRF. */
  setup(userId: string): Promise<RepositoryAuthorizationSetup>;
  repositories(): Promise<readonly AvailableRepository[]>;
  installationFor(fullName: string): Promise<RepositoryRef>;
}

export interface RepositoryReader {
  /**
   * Returns the current `fullName`: a renamed repository still answers under its
   * old name, so only the returned name reveals the rename.
   */
  repository(
    ref: RepositoryRef,
    fullName: string,
  ): Promise<{ readonly defaultBranch: string; readonly fullName: string }>;
  branchHead(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
  ): Promise<string>;
  /** `null` when the file is not at that commit. */
  readFile(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null>;
  /** Every file path at one commit, root-relative; directories are implied. */
  treePaths(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
  ): Promise<readonly string[]>;
  /**
   * A pull request that no longer exists answers `'closed'`, never throws: it is
   * as unmergeable as one closed by hand.
   */
  pullRequestState(
    ref: RepositoryRef,
    fullName: string,
    number: number,
  ): Promise<'open' | 'closed'>;
}

/**
 * Git's object model, so the configuration PR is one transaction and a
 * partially written configuration never exists.
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

export interface RepositoryHost extends RepositoryReader, RepositoryWriter {
  /**
   * Optional: a fake or non-GitHub host works from an already stored reference.
   * Connecting a new repository requires it.
   */
  installationFor?(fullName: string): Promise<RepositoryRef>;
}

export function repositoryRefOf(row: {
  readonly installationId: string;
}): RepositoryRef {
  return { installationId: row.installationId };
}

/**
 * `webBaseUrl` comes from the installation manifest, since an enterprise host
 * serves its own origin.
 */
export function cloneUrlFor(webBaseUrl: string, fullName: string): string {
  return `${webBaseUrl}/${fullName}.git`;
}
