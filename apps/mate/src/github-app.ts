/**
 * Mints a short-lived, one-repository installation token per turn from the
 * GitHub App's private key, which never leaves this process.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { Clock } from './clock.ts';
import { type Log, plain } from './log.ts';

const GITHUB_API = 'https://api.github.com';
// Bun's `fetch` has no happy-eyeballs fallback, so an unreachable address
// hangs for minutes unless the request is bounded.
const REQUEST_TIMEOUT_MS = 10_000;
/** Backdated against clock skew: GitHub rejects a JWT issued in its future. */
const JWT_SKEW_SECONDS = 60;
/** GitHub caps `exp` at ten minutes ahead; this stays a minute under it. */
const JWT_LIFETIME_SECONDS = 540;
// A reused token must outlast a full turn plus this, for the final push.
const REUSE_SLACK_MS = 5 * 60_000;
// Requested at every mint, so a token stays this narrow even if the App's
// own grant is widened later.
const TOKEN_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  // Lets the agent read why its pull request's checks failed.
  actions: 'read',
} as const;

/** GitHub ignores the username when the password is an installation token. */
export const GIT_HTTPS_USERNAME = 'x-access-token';

export class GithubAppError extends Error {
  override readonly name = 'GithubAppError';
  /** `status` is 0 when no answer arrived. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface InstallationToken {
  readonly token: string;
  /** Epoch milliseconds, from GitHub's own `expires_at`. */
  readonly expiresAt: number;
}

export interface GithubAppStatus {
  readonly installationId: number;
  readonly login: string;
  readonly expiresAt: number;
}

export interface GithubAppOptions {
  readonly appId: string;
  /** The PEM as GitHub hands it out, PKCS#1 `BEGIN RSA PRIVATE KEY`. */
  readonly privateKey: string;
  readonly owner: string;
  readonly repo: string;
  /** The turn cap the reuse rule is measured against. */
  readonly turnTimeoutMs: number;
  readonly clock: Clock;
  readonly log: Log;
  /** Overridden only by tests, which serve a GitHub of their own. */
  readonly apiBase?: string;
  readonly timeoutMs?: number;
}

interface InstallationResponse {
  id?: number;
  app_slug?: string;
}

interface TokenResponse {
  token?: string;
  expires_at?: string;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class GithubApp {
  private readonly key: KeyObject;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly reuseFloorMs: number;
  private installationId: number | null = null;
  private slug: string | null = null;
  private held: InstallationToken | null = null;

  constructor(private readonly options: GithubAppOptions) {
    // Parsed here so a bad key fails at boot. node:crypto, because WebCrypto's
    // `importKey('pkcs8')` refuses GitHub's PKCS#1 download.
    try {
      this.key = createPrivateKey(options.privateKey);
    } catch {
      throw new GithubAppError(0, 'github app private key does not parse');
    }
    this.apiBase = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.reuseFloorMs = options.turnTimeoutMs + REUSE_SLACK_MS;
  }

  get login(): string {
    return this.slug ? `${this.slug}[bot]` : 'unknown[bot]';
  }

  async token(): Promise<InstallationToken> {
    const held = this.held;
    if (held && held.expiresAt - this.options.clock.now() > this.reuseFloorMs) {
      return held;
    }
    this.held = await this.mint();
    return this.held;
  }

  // Only the token itself can revoke it. Revocation takes effect a few seconds
  // after the 204, so a copy briefly outlives the turn.
  async revoke(token: string): Promise<void> {
    // A revoked token must never be handed out again, whoever asked for this.
    if (this.held?.token === token) this.held = null;
    const response = await this.call('/installation/token', token, {
      method: 'DELETE',
    });
    if (!response.ok) throw await this.failure(response, 'revoke token');
    await response.text().catch(() => '');
  }

  // A real mint is the only proof the key still matches a live installation.
  // The caller logs and records the result.
  async preflight(): Promise<GithubAppStatus> {
    const minted = await this.mint();
    this.held = minted;
    return {
      installationId: this.installationId ?? 0,
      login: this.login,
      expiresAt: minted.expiresAt,
    };
  }

  private async mint(): Promise<InstallationToken> {
    const id = await this.installation();
    try {
      return await this.mintOn(id);
    } catch (error) {
      // A 404 means the App was reinstalled under a new id; rediscover once.
      if (!(error instanceof GithubAppError) || error.status !== 404)
        throw error;
      this.installationId = null;
      this.options.log.warn('github installation gone, rediscovering', {
        installationId: id,
      });
      return await this.mintOn(await this.installation());
    }
  }

  private async mintOn(id: number): Promise<InstallationToken> {
    const response = await this.call(
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
    if (!response.ok) throw await this.failure(response, 'mint token');
    const payload = (await response.json()) as TokenResponse;
    const expiresAt = Date.parse(payload.expires_at ?? '');
    if (!payload.token || Number.isNaN(expiresAt)) {
      throw new GithubAppError(
        response.status,
        'mint token: answer has no token',
      );
    }
    this.options.log.info('github token minted', {
      installationId: id,
      login: this.login,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return { token: payload.token, expiresAt };
  }

  // Cached: it changes only on a reinstall, which `mint` catches as a 404.
  private async installation(): Promise<number> {
    if (this.installationId !== null) return this.installationId;
    const { owner, repo } = this.options;
    const response = await this.call(
      `/repos/${owner}/${repo}/installation`,
      this.jwt(),
    );
    if (!response.ok) throw await this.failure(response, 'find installation');
    const payload = (await response.json()) as InstallationResponse;
    if (typeof payload.id !== 'number') {
      throw new GithubAppError(
        response.status,
        'find installation: answer has no id',
      );
    }
    this.installationId = payload.id;
    this.slug = payload.app_slug ?? null;
    this.options.log.info('github installation found', {
      installationId: payload.id,
      login: this.login,
      repository: `${owner}/${repo}`,
    });
    return payload.id;
  }

  // Signed per call: it costs microseconds, and a cached one can expire.
  private jwt(): string {
    const now = Math.floor(this.options.clock.now() / 1000);
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GithubAppError(
        0,
        `github ${init.method ?? 'GET'} ${path}: ${plain(error)}`,
      );
    }
  }

  // Never the body: it can echo a token, and this message reaches the log.
  private async failure(
    response: Response,
    what: string,
  ): Promise<GithubAppError> {
    await response.text().catch(() => '');
    const requestId = response.headers.get('x-github-request-id');
    const trailer = requestId ? ` (request ${requestId})` : '';
    return new GithubAppError(
      response.status,
      `${what}: github said ${response.status}${trailer}`,
    );
  }
}
