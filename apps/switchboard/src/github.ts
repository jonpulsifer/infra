import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { Log } from './log.ts';

/**
 * Opens the snapshot pull requests through a GitHub App: a short-lived
 * installation token per snapshot, the Contents API to write one file on a
 * fresh branch, and auto-merge armed on the pull request. No git binary.
 */

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const JWT_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
// Requested at every mint, so the token stays this narrow whatever the App
// is granted later.
const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write' };

export class GithubError extends Error {
  override readonly name = 'GithubError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GithubAppOptions {
  readonly appId: string;
  /** The PEM as GitHub hands it out. */
  readonly privateKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly log: Log;
  /** Overridden only by tests, which serve a GitHub of their own. */
  readonly apiBase?: string;
  readonly now?: () => number;
}

export interface Snapshot {
  /** Repo-relative path of the file to write. */
  readonly path: string;
  readonly content: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  /** The branch the pull request targets. */
  readonly base: string;
}

export interface SnapshotResult {
  readonly url: string;
  readonly number: number;
  /** False when the pull request exists but auto-merge could not be armed. */
  readonly autoMerge: boolean;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class GithubApp {
  private readonly key: KeyObject;
  private readonly apiBase: string;
  private readonly now: () => number;
  private installationId: number | null = null;
  private slug: string | null = null;

  constructor(private readonly options: GithubAppOptions) {
    // Parsed here so a bad key fails at boot. node:crypto, because WebCrypto's
    // `importKey('pkcs8')` refuses GitHub's PKCS#1 download.
    try {
      this.key = createPrivateKey(options.privateKey);
    } catch {
      throw new GithubError(0, 'github app private key does not parse');
    }
    this.apiBase = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
    this.now = options.now ?? (() => Date.now());
  }

  get login(): string {
    return this.slug ? `${this.slug}[bot]` : 'unknown[bot]';
  }

  /** The file's current content on `ref`, decoded, with its blob sha. */
  async readFile(
    path: string,
    ref: string,
  ): Promise<{ content: string; sha: string }> {
    const token = await this.token();
    const res = await this.call(
      `${this.repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (!res.ok) throw await this.failure(res, `read ${path}`);
    const payload = (await res.json()) as { content?: string; sha?: string };
    if (
      typeof payload.content !== 'string' ||
      typeof payload.sha !== 'string'
    ) {
      throw new GithubError(res.status, `read ${path}: answer has no content`);
    }
    return {
      content: Buffer.from(payload.content, 'base64').toString('utf8'),
      sha: payload.sha,
    };
  }

  /**
   * Writes `snapshot.content` to `snapshot.path` on a new branch cut from
   * `base`, opens the pull request and arms auto-merge. The branch name has
   * to be new; the caller makes it unique.
   */
  async openSnapshot(snapshot: Snapshot): Promise<SnapshotResult> {
    const token = await this.token();
    const head = await this.call(
      `${this.repoPath}/git/ref/heads/${encodePath(snapshot.base)}`,
      token,
    );
    if (!head.ok) throw await this.failure(head, `read ${snapshot.base}`);
    const headSha = ((await head.json()) as { object?: { sha?: string } })
      .object?.sha;
    if (!headSha) {
      throw new GithubError(head.status, `read ${snapshot.base}: no sha`);
    }

    const current = await this.readFile(snapshot.path, snapshot.base);
    if (current.content === snapshot.content) {
      throw new GithubError(
        0,
        `${snapshot.path} already matches on ${snapshot.base}`,
      );
    }

    const ref = await this.call(`${this.repoPath}/git/refs`, token, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${snapshot.branch}`,
        sha: headSha,
      }),
    });
    if (!ref.ok) throw await this.failure(ref, `create ${snapshot.branch}`);
    await ref.text().catch(() => '');

    const put = await this.call(
      `${this.repoPath}/contents/${encodePath(snapshot.path)}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: snapshot.title,
          content: Buffer.from(snapshot.content, 'utf8').toString('base64'),
          sha: current.sha,
          branch: snapshot.branch,
        }),
      },
    );
    if (!put.ok) throw await this.failure(put, `write ${snapshot.path}`);
    await put.text().catch(() => '');

    const pr = await this.call(`${this.repoPath}/pulls`, token, {
      method: 'POST',
      body: JSON.stringify({
        title: snapshot.title,
        body: snapshot.body,
        head: snapshot.branch,
        base: snapshot.base,
      }),
    });
    if (!pr.ok) throw await this.failure(pr, 'open pull request');
    const opened = (await pr.json()) as {
      html_url?: string;
      number?: number;
      node_id?: string;
    };
    if (!opened.html_url || !opened.number || !opened.node_id) {
      throw new GithubError(pr.status, 'open pull request: answer has no url');
    }

    let autoMerge = false;
    try {
      await this.armAutoMerge(opened.node_id, token);
      autoMerge = true;
    } catch (error) {
      this.options.log.warn('snapshot auto-merge not armed', {
        number: opened.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { url: opened.html_url, number: opened.number, autoMerge };
  }

  private async armAutoMerge(nodeId: string, token: string): Promise<void> {
    const res = await this.call('/graphql', token, {
      method: 'POST',
      body: JSON.stringify({
        query:
          'mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH}) { clientMutationId } }',
        variables: { id: nodeId },
      }),
    });
    if (!res.ok) throw await this.failure(res, 'arm auto-merge');
    const payload = (await res.json()) as { errors?: { message?: string }[] };
    if (payload.errors?.length) {
      throw new GithubError(
        200,
        `arm auto-merge: ${payload.errors[0]?.message ?? 'refused'}`,
      );
    }
  }

  private get repoPath(): string {
    return `/repos/${this.options.owner}/${this.options.repo}`;
  }

  private async token(): Promise<string> {
    const id = await this.installation();
    const res = await this.call(
      `/app/installations/${id}/access_tokens`,
      this.jwt(),
      {
        method: 'POST',
        body: JSON.stringify({
          repositories: [this.options.repo],
          permissions: TOKEN_PERMISSIONS,
        }),
      },
    );
    if (!res.ok) throw await this.failure(res, 'mint token');
    const payload = (await res.json()) as { token?: string };
    if (!payload.token) {
      throw new GithubError(res.status, 'mint token: answer has no token');
    }
    return payload.token;
  }

  // Cached: it changes only on a reinstall.
  private async installation(): Promise<number> {
    if (this.installationId !== null) return this.installationId;
    const res = await this.call(`${this.repoPath}/installation`, this.jwt());
    if (!res.ok) throw await this.failure(res, 'find installation');
    const payload = (await res.json()) as { id?: number; app_slug?: string };
    if (typeof payload.id !== 'number') {
      throw new GithubError(res.status, 'find installation: answer has no id');
    }
    this.installationId = payload.id;
    this.slug = payload.app_slug ?? null;
    this.options.log.info('github installation found', {
      installationId: payload.id,
      login: this.login,
    });
    return payload.id;
  }

  private jwt(): string {
    const now = Math.floor(this.now() / 1000);
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const claims = base64url({
      iat: now - JWT_SKEW_SECONDS,
      exp: now + JWT_LIFETIME_SECONDS,
      iss: this.options.appId,
    });
    const signed = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signed);
    return `${signed}.${signer.sign(this.key, 'base64url')}`;
  }

  private async call(
    path: string,
    bearer: string,
    init: { method?: string; body?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'x-github-api-version': '2022-11-28',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${this.apiBase}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const why = error instanceof Error ? error.name : 'error';
      throw new GithubError(0, `github ${init.method ?? 'GET'}: ${why}`);
    }
  }

  // Never the body: it can echo a token, and this message reaches the log.
  private async failure(res: Response, what: string): Promise<GithubError> {
    await res.text().catch(() => '');
    return new GithubError(res.status, `${what}: HTTP ${res.status}`);
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
