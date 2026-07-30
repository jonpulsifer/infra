/**
 * Repository, Git data, source archive, and Actions operations for GitHub.
 *
 * The Device OAuth lifecycle supplies the authorization value. The thing core
 * passes around is an {@link InstallationRef}, which is a number in a database
 * column and grants nothing on its own. The bearer value remains behind the
 * per-request authorization provider.
 *
 * Two consequences run through this whole file:
 *
 * - **Authorization never enters the public operation surface.** Callers name
 *   an installation and repository; the provider resolves a bearer value at
 *   request time.
 * - **A selected-repository App can be un-selected at any time**, and the
 *   response when that happens is a `404` indistinguishable from a repository
 *   that never existed. So access is a *state* this module reports
 *   ({@link GitHubAccessError} with `ACCESS_LOST`) and the repo loop turns into
 *   a freeze, rather than an exception any single call site tries to interpret.
 *
 * This module also implements {@link ExactCommitFetcher}, which is the seam
 * `src/domain/source-bundle.ts` stages through. The credential type it is
 * generic over is instantiated here as the installation reference, so the token
 * is minted inside {@link GitHubApp.fetchExactCommit} and is unreachable from
 * the staged result.
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

/** How core names one installation of the App. Grants nothing by itself. */
export interface InstallationRef {
  /** The far side's installation id, opaque to core. */
  readonly installationId: string;
}

/** A GitHub App user token supplied by the Device OAuth lifecycle. */
export interface GitHubAppConfig {
  readonly baseUrl: string;
  readonly authorization: AuthorizationProvider;
  readonly onUnauthorized?: (authorization: string) => Error | Promise<Error>;
  /** Combined App/user identity recorded on source receipts. */
  readonly principalSubject?: (
    ref: InstallationRef,
  ) => string | Promise<string>;
  /** Injected so a test can stand a fake far side behind the real client. */
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

/**
 * The App, and everything reached through one of its installations.
 */
export class GitHubApp implements ExactCommitFetcher<InstallationRef> {
  constructor(private readonly config: GitHubAppConfig) {}

  /**
   * A bearer value for one installation, minted or reused.
   *
   * Returned as a full `Authorization` value rather than a bare token so that
   * no caller has to know the scheme — and so that grepping this package for a
   * token-shaped string finds this method rather than a dozen call sites.
   */
  private authorizationFor(): () => Promise<string> {
    const { authorization } = this.config;
    return async () => await authorization();
  }

  /** A client authorized for repository operations. */
  private http(_ref: InstallationRef): GitHubHttp {
    return new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.authorizationFor(),
      ...(this.config.onUnauthorized
        ? { onUnauthorized: this.config.onUnauthorized }
        : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
  }

  /**
   * The repository's own facts. §15 reads the default branch, never assumes it.
   *
   * Narrowed to that one field because it is the only one core has a use for —
   * a wider return would be a promise about a far side's response shape that
   * `RepositoryReader` does not make.
   */
  async repository(
    ref: InstallationRef,
    fullName: string,
  ): Promise<{ readonly defaultBranch: string }> {
    const repository = await this.http(ref).json<{ default_branch: string }>({
      method: 'GET',
      path: `/repos/${fullName}`,
    });
    if (repository === null) {
      throw new TypeError('the repository endpoint tolerates no status');
    }
    return { defaultBranch: repository.default_branch };
  }

  /**
   * The commit one branch currently points at.
   *
   * Only ever called for the default branch. §15 makes that the one ref whose
   * merge is authoritative, so resolving any other would be resolving something
   * the model has no place to put.
   */
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
   * One file at one exact commit, or `null` when it is not there.
   *
   * `404` is tolerated here and nowhere else in this module: a repository with
   * no `spindrift.yaml` in a scope is an ordinary, expected state, and the
   * commit was already reachable — the call that resolved it would have raised
   * `ACCESS_LOST` first if it were not.
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

  // --- The Git data API, which the configuration PR is written through -----
  //
  // These six exist so `openConfigurationPullRequest` can put the whole file
  // set in **one commit**. The contents API would have been fewer concepts and
  // one call per file, but each of those calls is a commit and each needs the
  // existing blob sha when the file is already there — so a repository that had
  // been connected before would take a different code path from one that had
  // not, for a transaction §15 says is one thing.

  /** The tree one commit points at. */
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

  /** Store one file's bytes and return the blob they are addressed by. */
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

  /** A tree layered over an existing one — everything else is left alone. */
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
          // A non-executable regular file. The configuration PR writes YAML and
          // nothing else, so no other mode is reachable.
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

  /** One commit over one tree. */
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
   * Point a branch at a commit, creating it if it is not there.
   *
   * Force is set on the update path because the only branch this is ever called
   * for is Spindrift's own configuration branch: re-running a connection should
   * replace what it wrote last time rather than fail on a non-fast-forward, and
   * the branch holds nothing a human authored.
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
      tolerate: [404],
    });
    if (updated !== null) return;

    await this.http(ref).send({
      method: 'POST',
      path: `/repos/${fullName}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: commit },
    });
  }

  /** Open the pull request and return its number. */
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
    const pull = await this.http(ref).json<{ number: number }>({
      method: 'POST',
      path: `/repos/${fullName}/pulls`,
      body: input,
    });
    if (pull === null) {
      throw new TypeError('the pulls endpoint tolerates no status');
    }
    return pull.number;
  }

  // --- Actions, which the hosted build route runs on --------------------
  //
  // §4 puts the build on "hosted CI on the fast-pipe side" and §15 puts the run
  // in the connected repository, on its own minutes. Everything below is what
  // dispatching one and then *reading* it takes — there is no push endpoint
  // here, and that is the point: logs are read, not pushed (§4).

  /**
   * Which installation covers a repository.
   *
   * Derived from the repositories GitHub grants the authorized user through
   * this App. This is why neither the browser nor the manifest supplies an
   * installation id.
   */
  async installationFor(fullName: string): Promise<InstallationRef> {
    const repository = (await this.availableRepositories()).find(
      (candidate) => candidate.fullName === fullName,
    );
    if (repository === undefined) {
      throw new GitHubAccessError(
        'ACCESS_LOST',
        'GET',
        `${this.config.baseUrl}/user/installations`,
        404,
        `the authorized GitHub user has no installation selecting ${fullName}`,
      );
    }
    return { installationId: repository.installationId };
  }

  /**
   * Repositories granted to the authorized user through this GitHub App.
   *
   * GitHub paginates installations and each installation's repositories
   * independently. Walk both dimensions so the UI never silently hides the
   * 101st repository.
   */
  async availableRepositories(): Promise<readonly AvailableRepository[]> {
    const http = new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.config.authorization,
      ...(this.config.onUnauthorized
        ? { onUnauthorized: this.config.onUnauthorized }
        : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    const installations = await paged<{ id: number }>(http, (page) => ({
      path: `/user/installations?per_page=100&page=${page}`,
      values: (body) =>
        (body as { installations?: { id: number }[] }).installations ?? [],
    }));

    const repositories: AvailableRepository[] = [];
    for (const installation of installations) {
      const selected = await paged<{
        id: number;
        full_name: string;
        default_branch: string;
      }>(http, (page) => ({
        path:
          `/user/installations/${installation.id}/repositories` +
          `?per_page=100&page=${page}`,
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
          installationId: String(installation.id),
        });
      }
    }
    return repositories.sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    );
  }

  /**
   * Ask a workflow to run.
   *
   * `ref` is a **branch**, never a commit: the dispatch API only accepts a ref
   * a workflow file can be read from, so which commit gets *built* travels in
   * the inputs instead. That split is why the build route resolves the default
   * branch first and puts the exact commit in the spec.
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
   * Recent runs of one workflow on one branch, newest first.
   *
   * The dispatch API answers `204` and names no run, so the run has to be found
   * afterwards — which is the whole reason the caller workflow carries a
   * correlation input and stamps it into `run-name`. This returns the page; the
   * route matches on the name, because only the route knows what it sent.
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
    }[]
  > {
    const runs = await this.http(ref).json<{
      workflow_runs?: {
        id: number;
        name?: string | null;
        status: string;
        conclusion: string | null;
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
    }));
  }

  /** One run's current status. */
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

  /**
   * The jobs of one run and the steps inside them.
   *
   * This is the whole of `LIVE_STATUS` (§4): on a hosted runner the step
   * transitions are readable while the run is going, and the text is not — so
   * the route yields these as they change and fetches the log at the end.
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
   * One job's log as text, or `null` when the host has none for it.
   *
   * Per job rather than per run on purpose: the run-level endpoint answers with
   * a zip archive, and unpacking one to read text this endpoint already serves
   * as text would be a decompressor in the dependency graph for nothing.
   *
   * A `404` is tolerated because a job that never started has no log, and an
   * empty log is a truthful thing to show — unlike lost access, which every
   * other call in this module still classifies.
   */
  async jobLog(
    ref: InstallationRef,
    fullName: string,
    jobId: number,
  ): Promise<string | null> {
    const response = await this.http(ref).send({
      method: 'GET',
      path: `/repos/${fullName}/actions/jobs/${jobId}/logs`,
      accept: 'text/plain',
      tolerate: [404],
    });
    return response === null ? null : await response.text();
  }

  /**
   * §15's one fetch: "fetches the exact commit **once** and stages an immutable
   * source bundle for either builder, storing no token."
   *
   * **The revision is resolved before the archive is fetched, and reported as
   * the far side resolved it.** `stageSourceBundle` compares that against what
   * was asked for and refuses a mismatch, which is only a check worth having if
   * this method can actually disagree with its caller — echoing the input would
   * make it vacuous. Resolving first also means the archive and both feature
   * probes address one immutable sha, so a push landing mid-fetch cannot give
   * three calls three different trees.
   *
   * "Once" is about the archive, which is the expensive, ordering-sensitive
   * fetch; the metadata calls beside it are reads of an already-immutable
   * object.
   *
   * The two unsupported-feature flags are answered from the tree rather than
   * from the archive's contents, because the archive is the thing being handed
   * to a builder and by then it is too late to say no — §15 makes submodules
   * and LFS explicitly unsupported, and `stageSourceBundle` refuses them
   * *before* storage on the strength of what is reported here.
   */
  async fetchExactCommit(input: {
    readonly repository: string;
    readonly commit: string;
    readonly credential: InstallationRef;
  }): Promise<FetchedCommit> {
    const { repository, commit, credential } = input;

    const resolved = await this.http(credential).json<{ sha: string }>({
      method: 'GET',
      path: `/repos/${repository}/commits/${encodeURIComponent(commit)}`,
    });
    if (resolved === null) {
      throw new TypeError('the commit endpoint tolerates no status');
    }

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
      // A `.gitattributes` is ordinary; one that routes a path through the LFS
      // filter is what makes a checkout depend on a second fetch nobody staged.
      hasGitLfs:
        gitattributes !== null && /filter\s*=\s*lfs/.test(gitattributes),
      principal: {
        kind: 'githubApp',
        subject: principalSubject,
      },
    };
  }
}

export type { GitHubAccessCode } from './http.ts';
export { GitHubAccessError };
