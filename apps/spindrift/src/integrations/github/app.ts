/**
 * Repository, Git data, source archive and Actions operations for GitHub.
 * Callers pass an {@link InstallationRef}; the bearer value is resolved per
 * request and never returned.
 */

import type { AvailableRepository } from '../../domain/repository.ts';
import type {
  ExactCommitFetcher,
  FetchedCommit,
} from '../../domain/source-bundle.ts';
import {
  type AuthorizationProvider,
  type Fetcher,
  GitHubAccessError,
  GitHubHttp,
} from './http.ts';

/** Names an installation; grants nothing by itself. */
export interface InstallationRef {
  readonly installationId: string;
}

export interface GitHubAppConfig {
  readonly baseUrl: string;
  /** An installation token, as a full `Authorization` value. */
  readonly authorization: (ref: InstallationRef) => string | Promise<string>;
  /**
   * An App JWT, for the endpoints that identify the App: listing installations
   * and finding the one that covers a repository.
   */
  readonly appAuthorization: AuthorizationProvider;
  /**
   * A public App can be installed by strangers. When set, installations on other
   * accounts are filtered out and refused; absent means no filter.
   */
  readonly recognizedAccounts?: readonly string[];
  /** `GitHubEndpoint.onUnauthorized`, per installation. */
  readonly onUnauthorized?: (
    ref: InstallationRef,
    authorization: string,
  ) => 'retry' | Error | Promise<'retry' | Error>;
  /** The subject recorded on source receipts. */
  readonly principalSubject?: (
    ref: InstallationRef,
  ) => string | Promise<string>;
  readonly fetch?: Fetcher;
}

const PAGE_SIZE = 100;

async function paged<Value>(
  http: GitHubHttp,
  pageRequest: (page: number) => {
    readonly path: string;
    readonly values: (body: unknown) => readonly Value[];
  },
): Promise<Value[]> {
  const all: Value[] = [];
  for (let page = 1; ; page += 1) {
    const request = pageRequest(page);
    const body = await http.json<unknown>({
      method: 'GET',
      path: request.path,
    });
    if (body === null) {
      throw new TypeError('the paginated endpoint tolerates no status');
    }
    const values = request.values(body);
    all.push(...values);
    if (values.length < PAGE_SIZE) return all;
  }
}

export class GitHubApp implements ExactCommitFetcher<InstallationRef> {
  constructor(private readonly config: GitHubAppConfig) {}

  private authorizationFor(ref: InstallationRef): () => Promise<string> {
    const { authorization } = this.config;
    return async () => await authorization(ref);
  }

  private http(ref: InstallationRef): GitHubHttp {
    const { onUnauthorized } = this.config;
    return new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.authorizationFor(ref),
      ...(onUnauthorized
        ? {
            onUnauthorized: (authorization: string) =>
              onUnauthorized(ref, authorization),
          }
        : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
  }

  private appHttp(): GitHubHttp {
    return new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.config.appAuthorization,
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
  }

  /**
   * `fullName` shows a rename: GitHub answers an old name with a `301` that
   * `fetch` follows silently.
   */
  async repository(
    ref: InstallationRef,
    fullName: string,
  ): Promise<{ readonly defaultBranch: string; readonly fullName: string }> {
    const repository = await this.http(ref).json<{
      default_branch: string;
      full_name: string;
    }>({
      method: 'GET',
      path: `/repos/${fullName}`,
    });
    if (repository === null) {
      throw new TypeError('the repository endpoint tolerates no status');
    }
    return {
      defaultBranch: repository.default_branch,
      fullName: repository.full_name,
    };
  }

  async branchHead(
    ref: InstallationRef,
    fullName: string,
    branch: string,
  ): Promise<string> {
    const head = await this.http(ref).json<{ object: { sha: string } }>({
      method: 'GET',
      path: `/repos/${fullName}/git/ref/heads/${branch}`,
    });
    if (head === null) {
      throw new TypeError('the ref endpoint tolerates no status');
    }
    return head.object.sha;
  }

  /**
   * `null` when the file is absent. Lost access surfaces earlier, from the call
   * that resolved the commit.
   */
  async readFile(
    ref: InstallationRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null> {
    const response = await this.http(ref).send({
      method: 'GET',
      path: `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(commit)}`,
      accept: 'application/vnd.github.raw',
      tolerate: [404],
    });
    return response === null ? null : await response.text();
  }

  /**
   * Blobs only, since a submodule's content is in another repository. A
   * truncated listing throws: detection on part of a tree answers wrongly.
   */
  async treePaths(
    ref: InstallationRef,
    fullName: string,
    commit: string,
  ): Promise<readonly string[]> {
    const tree = await this.http(ref).json<{
      truncated?: boolean;
      tree: readonly { path: string; type: string }[];
    }>({
      method: 'GET',
      path: `/repos/${fullName}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
    });
    if (tree === null) {
      throw new TypeError('the tree endpoint tolerates no status');
    }
    if (tree.truncated === true) {
      throw new Error(
        `${fullName} has more files at ${commit.slice(0, 7)} than one tree response carries, so detection cannot see all of it`,
      );
    }
    return tree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => entry.path);
  }

  async commitTree(
    ref: InstallationRef,
    fullName: string,
    commit: string,
  ): Promise<string> {
    const found = await this.http(ref).json<{ tree: { sha: string } }>({
      method: 'GET',
      path: `/repos/${fullName}/git/commits/${commit}`,
    });
    if (found === null) {
      throw new TypeError('the commit endpoint tolerates no status');
    }
    return found.tree.sha;
  }

  async createBlob(
    ref: InstallationRef,
    fullName: string,
    contents: string,
  ): Promise<string> {
    const blob = await this.http(ref).json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${fullName}/git/blobs`,
      body: { content: contents, encoding: 'utf-8' },
    });
    if (blob === null) {
      throw new TypeError('the blob endpoint tolerates no status');
    }
    return blob.sha;
  }

  async createTree(
    ref: InstallationRef,
    fullName: string,
    baseTree: string,
    entries: readonly { readonly path: string; readonly blob: string }[],
  ): Promise<string> {
    const tree = await this.http(ref).json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${fullName}/git/trees`,
      body: {
        base_tree: baseTree,
        tree: entries.map((entry) => ({
          path: entry.path,
          // A regular, non-executable file.
          mode: '100644',
          type: 'blob',
          sha: entry.blob,
        })),
      },
    });
    if (tree === null) {
      throw new TypeError('the tree endpoint tolerates no status');
    }
    return tree.sha;
  }

  async createCommit(
    ref: InstallationRef,
    fullName: string,
    input: {
      readonly message: string;
      readonly tree: string;
      readonly parent: string;
    },
  ): Promise<string> {
    const commit = await this.http(ref).json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${fullName}/git/commits`,
      body: {
        message: input.message,
        tree: input.tree,
        parents: [input.parent],
      },
    });
    if (commit === null) {
      throw new TypeError('the commit endpoint tolerates no status');
    }
    return commit.sha;
  }

  /**
   * Forced: callers pass only branches this app writes and no person edits.
   * GitHub answers an update to a missing branch with `422`, and then it is
   * created.
   */
  async setBranch(
    ref: InstallationRef,
    fullName: string,
    branch: string,
    commit: string,
  ): Promise<void> {
    const updated = await this.http(ref).send({
      method: 'PATCH',
      path: `/repos/${fullName}/git/refs/heads/${branch}`,
      body: { sha: commit, force: true },
      tolerate: [404, 422],
    });
    if (updated !== null) return;

    await this.http(ref).send({
      method: 'POST',
      path: `/repos/${fullName}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: commit },
    });
  }

  /**
   * When GitHub refuses a second pull request for the same head, the open one
   * is reused, with its title and body rewritten for the new commit.
   */
  async openPullRequest(
    ref: InstallationRef,
    fullName: string,
    input: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
    },
  ): Promise<number> {
    try {
      const pull = await this.http(ref).json<{ number: number }>({
        method: 'POST',
        path: `/repos/${fullName}/pulls`,
        body: input,
      });
      if (pull === null) {
        throw new TypeError('the pulls endpoint tolerates no status');
      }
      return pull.number;
    } catch (cause) {
      const existing = await this.findOpenPullRequest(
        ref,
        fullName,
        input.head,
      );
      if (existing === null) throw cause;
      await this.http(ref).send({
        method: 'PATCH',
        path: `/repos/${fullName}/pulls/${existing}`,
        body: { title: input.title, body: input.body },
      });
      return existing;
    }
  }

  /**
   * Filtered by `head` on GitHub's side, since an unfiltered page can miss the
   * pull request.
   */
  async findOpenPullRequest(
    ref: InstallationRef,
    fullName: string,
    headBranch: string,
  ): Promise<number | null> {
    const owner = fullName.slice(0, fullName.indexOf('/'));
    try {
      const pulls = await this.http(ref).json<
        Array<{ number: number; head: { ref?: string } }>
      >({
        method: 'GET',
        path: `/repos/${fullName}/pulls?state=open&per_page=${PAGE_SIZE}&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
      });
      if (Array.isArray(pulls)) {
        const match = pulls.find((p) => p.head?.ref === headBranch);
        if (match) return match.number;
      }
    } catch {
      // null lets openPullRequest rethrow its own error.
    }
    return null;
  }

  /** A deleted pull request (`404`) reads as closed. */
  async pullRequestState(
    ref: InstallationRef,
    fullName: string,
    number: number,
  ): Promise<'open' | 'closed'> {
    const pull = await this.http(ref).json<{ state: string }>({
      method: 'GET',
      path: `/repos/${fullName}/pulls/${number}`,
      tolerate: [404],
    });
    return pull !== null && pull.state === 'open' ? 'open' : 'closed';
  }

  /**
   * A repository no installation covers answers `404`, which is `ACCESS_LOST`.
   * An installation on an unrecognized account is refused the same way.
   */
  async installationFor(fullName: string): Promise<InstallationRef> {
    const installation = await this.appHttp().json<{
      id: number;
      account?: { login?: string } | null;
    }>({
      method: 'GET',
      path: `/repos/${fullName}/installation`,
    });
    if (installation === null) {
      throw new TypeError('the installation endpoint tolerates no status');
    }
    const account = installation.account?.login;
    if (
      this.config.recognizedAccounts !== undefined &&
      (account === undefined ||
        !this.config.recognizedAccounts.includes(account))
    ) {
      throw new GitHubAccessError(
        'ACCESS_LOST',
        'GET',
        `${this.config.baseUrl}/repos/${fullName}/installation`,
        404,
        `${fullName} is granted through an installation on ${account ?? 'an unknown account'}, which this installation does not recognise`,
      );
    }
    return { installationId: String(installation.id) };
  }

  /**
   * Installations on unrecognized accounts are dropped before their
   * repositories are read.
   */
  async availableRepositories(): Promise<readonly AvailableRepository[]> {
    const installations = await paged<{
      id: number;
      account?: { login?: string } | null;
    }>(this.appHttp(), (page) => ({
      path: `/app/installations?per_page=100&page=${page}`,
      values: (body) => (Array.isArray(body) ? body : []),
    }));
    const recognized = this.config.recognizedAccounts;
    const own =
      recognized === undefined
        ? installations
        : installations.filter((installation) => {
            const account = installation.account?.login;
            return account !== undefined && recognized.includes(account);
          });

    const repositories: AvailableRepository[] = [];
    for (const installation of own) {
      const ref = { installationId: String(installation.id) };
      const selected = await paged<{
        id: number;
        full_name: string;
        default_branch: string;
      }>(this.http(ref), (page) => ({
        path: `/installation/repositories?per_page=100&page=${page}`,
        values: (body) =>
          (
            body as {
              repositories?: {
                id: number;
                full_name: string;
                default_branch: string;
              }[];
            }
          ).repositories ?? [],
      }));
      for (const repository of selected) {
        repositories.push({
          repositoryId: String(repository.id),
          fullName: repository.full_name,
          defaultBranch: repository.default_branch,
          installationId: ref.installationId,
        });
      }
    }
    return repositories.sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    );
  }

  /**
   * Dispatch reads the workflow file from `branch`, so it cannot be a commit;
   * the commit to build travels in `inputs`.
   */
  async dispatchWorkflow(
    ref: InstallationRef,
    fullName: string,
    input: {
      readonly workflow: string;
      readonly branch: string;
      readonly inputs: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    await this.http(ref).send({
      method: 'POST',
      path: `/repos/${fullName}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
      body: { ref: input.branch, inputs: input.inputs },
    });
  }

  /**
   * Newest first. Dispatch answers `204` with no run id, so the caller finds
   * its run by the correlation stamped into the run name.
   */
  async workflowRuns(
    ref: InstallationRef,
    fullName: string,
    input: { readonly workflow: string; readonly branch: string },
  ): Promise<
    readonly {
      readonly id: number;
      readonly name: string | null;
      readonly status: string;
      readonly conclusion: string | null;
      readonly htmlUrl: string | null;
    }[]
  > {
    const runs = await this.http(ref).json<{
      workflow_runs?: {
        id: number;
        name?: string | null;
        status: string;
        conclusion: string | null;
        html_url?: string | null;
      }[];
    }>({
      method: 'GET',
      path:
        `/repos/${fullName}/actions/workflows/${encodeURIComponent(input.workflow)}/runs` +
        `?event=workflow_dispatch&branch=${encodeURIComponent(input.branch)}&per_page=30`,
    });
    if (runs === null) {
      throw new TypeError('the runs endpoint tolerates no status');
    }
    return (runs.workflow_runs ?? []).map((run) => ({
      id: run.id,
      name: run.name ?? null,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url ?? null,
    }));
  }

  async workflowRun(
    ref: InstallationRef,
    fullName: string,
    runId: number,
  ): Promise<{
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
  } | null> {
    return this.http(ref).json({
      method: 'GET',
      path: `/repos/${fullName}/actions/runs/${runId}`,
    });
  }

  /** `409` means the run already finished, which is what a cancel wants. */
  async cancelRun(
    ref: InstallationRef,
    fullName: string,
    runId: number,
  ): Promise<void> {
    await this.http(ref).send({
      method: 'POST',
      path: `/repos/${fullName}/actions/runs/${runId}/cancel`,
      body: {},
      tolerate: [409],
    });
  }

  /**
   * Step states are readable while a hosted run is going and its log text is
   * not, so the log is fetched at the end.
   */
  async runJobs(
    ref: InstallationRef,
    fullName: string,
    runId: number,
  ): Promise<
    readonly {
      readonly id: number;
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly steps?: readonly {
        readonly name: string;
        readonly status: string;
        readonly conclusion: string | null;
      }[];
    }[]
  > {
    const jobs = await this.http(ref).json<{
      jobs?: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        steps?: { name: string; status: string; conclusion: string | null }[];
      }[];
    }>({
      method: 'GET',
      path: `/repos/${fullName}/actions/runs/${runId}/jobs?per_page=100`,
    });
    if (jobs === null) {
      throw new TypeError('the jobs endpoint tolerates no status');
    }
    return jobs.jobs ?? [];
  }

  /**
   * `null` for a job that never started. The endpoint refuses a text `Accept`
   * with `415`, so the default JSON media type is sent and text comes back.
   */
  async jobLog(
    ref: InstallationRef,
    fullName: string,
    jobId: number,
  ): Promise<string | null> {
    const response = await this.http(ref).send({
      method: 'GET',
      path: `/repos/${fullName}/actions/jobs/${jobId}/logs`,
      tolerate: [404],
    });
    return response === null ? null : await response.text();
  }

  /**
   * Resolves the sha first and reports GitHub's answer, so the archive and both
   * probes read one commit and `stageSourceBundle` can refuse a mismatch.
   */
  async fetchExactCommit(input: {
    readonly repository: string;
    readonly commit: string;
    readonly credential: InstallationRef;
  }): Promise<FetchedCommit> {
    const { repository, commit, credential } = input;

    const resolved = await this.http(credential).json<{
      sha: string;
      commit?: {
        message?: string | null;
        author?: { name?: string | null; date?: string | null } | null;
      };
      /** Absent when GitHub matches no user to the author. */
      author?: { login?: string | null } | null;
    }>({
      method: 'GET',
      path: `/repos/${repository}/commits/${encodeURIComponent(commit)}`,
    });
    if (resolved === null) {
      throw new TypeError('the commit endpoint tolerates no status');
    }
    const authoredAt = resolved.commit?.author?.date
      ? new Date(resolved.commit.author.date)
      : null;

    const [bytes, gitmodules, gitattributes] = await Promise.all([
      this.http(credential).bytes({
        method: 'GET',
        path: `/repos/${repository}/tarball/${encodeURIComponent(resolved.sha)}`,
      }),
      this.readFile(credential, repository, resolved.sha, '.gitmodules'),
      this.readFile(credential, repository, resolved.sha, '.gitattributes'),
    ]);

    const principalSubject = this.config.principalSubject
      ? await this.config.principalSubject(credential)
      : `installation:${credential.installationId}`;
    return {
      bytes,
      resolvedCommit: resolved.sha,
      hasSubmodules: gitmodules !== null,
      // An LFS filter makes a checkout depend on a fetch nobody staged.
      hasGitLfs:
        gitattributes !== null && /filter\s*=\s*lfs/.test(gitattributes),
      message: resolved.commit?.message ?? null,
      author: resolved.author?.login ?? resolved.commit?.author?.name ?? null,
      authoredAt:
        authoredAt !== null && Number.isNaN(authoredAt.getTime())
          ? null
          : authoredAt,
      principal: {
        kind: 'githubApp',
        subject: principalSubject,
      },
    };
  }
}

export type { GitHubAccessCode } from './http.ts';
export { GitHubAccessError };
