/**
 * The GitHub App this installation already has (§15).
 *
 * §15: "Reuse the existing selected-repository GitHub App and bot identity,
 * bootstrapped from a SOPS Secret." Two consequences run through this whole
 * file:
 *
 * - **The App's key is the only long-lived credential, and it never leaves.**
 *   Everything else is minted from it per call — an App JWT good for minutes,
 *   an installation token good for an hour — so the thing core passes around as
 *   a "credential" is an {@link InstallationRef}, which is a number in a
 *   database column and grants nothing on its own. That is what lets §15's
 *   "storing no token" be structural: there is no type in this module's public
 *   surface that a token fits into.
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
import type {
  ExactCommitFetcher,
  FetchedCommit,
} from '../../domain/source-bundle.ts';
import { type Fetcher, GitHubAccessError, GitHubHttp } from './http.ts';

/** How core names one installation of the App. Grants nothing by itself. */
export interface InstallationRef {
  /** The far side's installation id, opaque to core. */
  readonly installationId: string;
}

/** The App's own identity and signing key, from the installation Secret. */
export interface GitHubAppConfig {
  /** Numeric App id, as the manifest carries it. */
  readonly appId: string;
  /**
   * The App's private key, PEM, **PKCS#8**.
   *
   * WebCrypto imports PKCS#8 and nothing else, and this integration has no
   * ASN.1 code — so a PKCS#1 key (`BEGIN RSA PRIVATE KEY`, which is what the
   * GitHub UI hands you) is refused at construction with the conversion
   * command in the message. Refusing loudly beats a silent mis-parse that
   * surfaces as an unexplained `401` an hour later.
   */
  readonly privateKeyPem: string;
  readonly baseUrl: string;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/** Raised when the configured App key cannot be used to sign a JWT. */
export class GitHubAppKeyError extends Error {
  override readonly name = 'GitHubAppKeyError';
}

/** A minted installation access token and the moment it stops working. */
interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';
const PKCS1_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

/**
 * An App JWT is valid for ten minutes at most; nine leaves room for the clock
 * skew the far side tolerates without landing on its own limit.
 */
const APP_JWT_LIFETIME_SECONDS = 9 * 60;

/**
 * How long before an installation token expires it stops being reused.
 *
 * A token that expires mid-request is a `401` that reads exactly like lost
 * access, which is the one misclassification this integration must not make —
 * so the margin is generous rather than tight.
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Decode a PEM body to DER, refusing the key format WebCrypto cannot import. */
function pkcs8Der(pem: string): Uint8Array {
  const trimmed = pem.trim();
  if (trimmed.startsWith(PKCS1_HEADER)) {
    throw new GitHubAppKeyError(
      'the GitHub App key is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem` and store that',
    );
  }
  if (!trimmed.startsWith(PKCS8_HEADER)) {
    throw new GitHubAppKeyError(
      'the GitHub App key is not a PKCS#8 PEM private key',
    );
  }
  const body = trimmed
    .replaceAll(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replaceAll(/\s+/g, '');
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

/**
 * The App, and everything reached through one of its installations.
 *
 * One object rather than a function per call because the two caches — the
 * imported signing key and the per-installation token — are what keep a loop
 * over a dozen repositories from minting a dozen JWTs a minute, and a cache
 * that is not owned by something is a module-level global.
 */
export class GitHubApp implements ExactCommitFetcher<InstallationRef> {
  private readonly tokens = new Map<string, InstallationToken>();
  private signingKey: Promise<CryptoKey> | null = null;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The App's own JWT: proves *which App is asking*, and nothing about a
   * repository. It is only ever presented to the token endpoint.
   */
  async appJwt(): Promise<string> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    // Backdating by a minute is the documented remedy for the far side's clock
    // running slightly behind this one, which it rejects outright.
    const claims = {
      iat: issuedAt - 60,
      exp: issuedAt + APP_JWT_LIFETIME_SECONDS,
      iss: this.config.appId,
    };
    const signingInput = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson(claims)}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      await this.key(),
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
  }

  /**
   * A bearer value for one installation, minted or reused.
   *
   * Returned as a full `Authorization` value rather than a bare token so that
   * no caller has to know the scheme — and so that grepping this package for a
   * token-shaped string finds this method rather than a dozen call sites.
   */
  private authorizationFor(ref: InstallationRef): () => Promise<string> {
    return async () => `Bearer ${await this.installationToken(ref)}`;
  }

  private async installationToken(ref: InstallationRef): Promise<string> {
    const cached = this.tokens.get(ref.installationId);
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - this.now().getTime() >
        TOKEN_REFRESH_MARGIN_MS
    ) {
      return cached.token;
    }

    const jwt = await this.appJwt();
    const http = new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: () => `Bearer ${jwt}`,
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    const minted = await http.json<{ token: string; expires_at: string }>({
      method: 'POST',
      path: `/app/installations/${encodeURIComponent(ref.installationId)}/access_tokens`,
    });
    if (minted === null) {
      throw new TypeError('the token endpoint tolerates no status');
    }

    const token = {
      token: minted.token,
      expiresAt: new Date(minted.expires_at),
    };
    this.tokens.set(ref.installationId, token);
    return token.token;
  }

  private key(): Promise<CryptoKey> {
    this.signingKey ??= crypto.subtle.importKey(
      'pkcs8',
      pkcs8Der(this.config.privateKeyPem).buffer as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.signingKey;
  }

  /** A client scoped to one installation. */
  private http(ref: InstallationRef): GitHubHttp {
    return new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: this.authorizationFor(ref),
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
   * Authorized by the App's own JWT rather than an installation token, because
   * the answer is what an installation token would have to be minted *from* —
   * and it is why a build route can start from a repository name alone, without
   * core threading an installation id through the build contract.
   */
  async installationFor(fullName: string): Promise<InstallationRef> {
    const jwt = await this.appJwt();
    const http = new GitHubHttp({
      baseUrl: this.config.baseUrl,
      authorization: () => `Bearer ${jwt}`,
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    const installation = await http.json<{ id: number }>({
      method: 'GET',
      path: `/repos/${fullName}/installation`,
    });
    if (installation === null) {
      throw new TypeError('the installation endpoint tolerates no status');
    }
    return { installationId: String(installation.id) };
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
        subject: `installation:${credential.installationId}`,
      },
    };
  }
}

export type { GitHubAccessCode } from './http.ts';
export { GitHubAccessError };
