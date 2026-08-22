/**
 * Repository, Git data, source archive, and Actions operations for GitHub.
 *
 * `app-auth.ts` supplies the authorization values — an installation token per
 * ref, an App JWT for the endpoints that identify the App itself. The thing
 * core passes around is an {@link InstallationRef}, which is a number in a
 * database column and grants nothing on its own. The bearer values remain
 * behind the per-request providers.
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

/** How this App authorizes, per installation and as itself. */
export interface GitHubAppConfig {
  readonly baseUrl: string;
  /** An installation-token `Authorization` value for one installation. */
  readonly authorization: (ref: InstallationRef) => string | Promise<string>;
  /**
   * An App-JWT `Authorization` value, for the two endpoints that identify
   * the App rather than an installation: enumerating installations and
   * resolving which installation covers a repository.
   */
  readonly appAuthorization: AuthorizationProvider;
  /**
   * Installation accounts the operator recognises as this installation's own.
   * A public App can be installed by strangers; stated, this filters their
   * installations out of {@link GitHubApp.availableRepositories} and refuses
   * them in {@link GitHubApp.installationFor} — never operated on, not merely
   * not rendered. Absent means no filter.
   */
  readonly recognizedAccounts?: readonly string[];
  /** See `GitHubEndpoint.onUnauthorized` — threaded per ref so the provider can drop its cache. */
  readonly onUnauthorized?: (
    ref: InstallationRef,
    authorization: string,
  ) => 'retry' | Error | Promise<'retry' | Error>;
  /** Combined App/installation identity recorded on source receipts. */
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
  private authorizationFor(ref: InstallationRef): () => Promise<string> {
    const { authorization } = this.config;
    return async () => await authorization(ref);
  }

  /** A client authorized for one installation's repository operations. */
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

  /** A client authorized as the App itself, for the JWT-side endpoints. */
  private appHttp(): GitHubHttp {
    return new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.config.appAuthorization,
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

  /**
   * Every blob path at one exact commit.
   *
   * One recursive call, which is what makes connect-time detection something
   * that happens while an operator is looking at the screen rather than a
   * clone they wait for. GitHub caps the response and says so in `truncated`;
   * a truncated listing is refused rather than returned, because detection
   * reading a partial tree would answer "no package.json here" about a
   * repository that has one, and a wrong answer written into a configuration
   * pull request is worse than an error the operator can see.
   *
   * `tree` entries with a `blob` type are files. Directories (`tree`) and
   * submodules (`commit`) are dropped: `SourceTree` names content, and a
   * submodule's content is in another repository this installation may not
   * even be able to see.
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
   *
   * **`422` is what a branch that is not there answers.** GitHub's ref-update
   * endpoint documents `200`, `409` and `422` and no `404` at all — a `404` is
   * what *reading* a missing ref answers, which is why `branchHead` is right to
   * expect one and this is not. Tolerating only `404` here made the create
   * below unreachable, so the first connection of every repository threw on the
   * branch it was about to cut, and `connectRepository`'s fail-open turned that
   * into a repository connected with no configuration pull request.
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
   * Open the pull request and return its number.
   *
   * A second connection force-updates the branch and then finds GitHub refusing
   * to open a second pull request for the same head. The existing one *is* the
   * answer — it now carries the commit just pushed — so it is found rather than
   * reported as a failure, and its title and body are rewritten to the
   * transaction that just landed on it. Leaving the prose alone would leave an
   * operator reviewing a description of the previous connection over the diff
   * of this one, which is the thing `connectRepository`'s own header promises
   * does not happen.
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
   * Find an open pull request for a given head branch.
   *
   * Asked of GitHub rather than filtered here: the unfiltered listing is thirty
   * newest-first, so a repository with a page of open dependency bumps answered
   * "no such pull request" about one that was sitting right there — and the
   * branch had already been force-updated by then, so the operator was told the
   * opposite of what had happened.
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
      // Return null on failure to fall through to original error
    }
    return null;
  }

  /**
   * Whether one pull request is still open (ticket 136).
   *
   * `404` is tolerated here for the same reason it is in `readFile`: a pull
   * request that has been deleted is exactly as unmergeable as one a human
   * closed, and the repository loop only ever asks this to decide whether
   * `configPullRequest` still names something worth merging.
   */
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

  // --- Actions, which the hosted build route runs on --------------------
  //
  // §4 puts the build on "hosted CI on the fast-pipe side" and §15 puts the run
  // in the connected repository, on its own minutes. Everything below is what
  // dispatching one and then *reading* it takes — there is no push endpoint
  // here, and that is the point: logs are read, not pushed (§4).

  /**
   * Which installation covers a repository, asked exactly.
   *
   * `GET /repos/{owner}/{repo}/installation` with the App JWT — one call,
   * answered by the host rather than filtered from an enumeration. A
   * repository no installation selects answers `404`, which the transport
   * already classifies as `ACCESS_LOST`; an installation on an account the
   * operator does not recognise is refused the same way, because a stranger's
   * repository must never be operated on however plainly it exists.
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
   * Repositories granted through this App's installations.
   *
   * Installations are enumerated with the App JWT; each installation's grant
   * is then read with that installation's own token, which is the shape the
   * host requires. GitHub paginates both dimensions independently — both are
   * walked so the UI never silently hides the 101st repository. Installations
   * on unrecognised accounts are filtered before their repositories are read
   * at all: a public App collects stranger installs, and a stranger's grant
   * must not flatten into anything connectable.
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
      // The page a human opens, served by the host rather than composed here:
      // the API knows its own web address and a hand-built one would be this
      // module guessing at a URL layout it does not own.
      htmlUrl: run.html_url ?? null,
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
   *
   * **The text is read without asking for a text media type**, which reads
   * backwards and is the whole point. The endpoint *negotiates* as JSON and
   * *answers* with a redirect to a plain-text blob, so it refuses
   * `Accept: text/plain` with a `415` — "Must accept 'application/json'" — and
   * serves the log to the module's default `application/vnd.github+json`. The
   * media type names what the endpoint speaks, not what comes back through it.
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
