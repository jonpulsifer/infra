/**
 * mate's own GitHub credential. mate holds a GitHub App private key — the
 * `clanky-bot[bot]` App, installed on one repository — and mints a
 * short-lived installation access token from it per turn. The key never
 * leaves this process: a sandbox is handed a token and nothing else, so a
 * sandbox that is compromised is compromised for an hour against one repo,
 * not until a person remembers to rotate a personal token.
 *
 * The App id and the key file are configuration (`MATE_GITHUB_APP_ID`,
 * `MATE_GITHUB_APP_KEY_FILE`). The installation id is not: it is derived from
 * those two and changes whenever the App is removed and installed again, so
 * it is discovered here rather than written down anywhere.
 *
 * Nothing in here records a metric. The caller knows whether a mint was for a
 * turn, a preflight or a retry, which is the label the counters want, so the
 * counters live with the caller.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { Clock } from './clock.ts';
import { type Log, plain } from './log.ts';

const GITHUB_API = 'https://api.github.com';
/**
 * Long enough for GitHub on a bad day, short enough that a wedged call is not
 * a wedged turn. Every request here is bounded because Bun's `fetch` has no
 * happy-eyeballs fallback: an address it cannot reach hangs for minutes
 * rather than failing.
 */
const REQUEST_TIMEOUT_MS = 10_000;
/** Backdated against clock skew: GitHub rejects a JWT issued in its future. */
const JWT_SKEW_SECONDS = 60;
/** GitHub's ceiling is ten minutes from `iat`; this stays a minute under it. */
const JWT_LIFETIME_SECONDS = 540;
/**
 * How much life a held token must have left before it may be handed to
 * another turn: the whole of that turn, plus five minutes for the push at the
 * end of it. A token that expires mid-turn is work that finishes and then
 * fails to land, so this is a correctness rule and not an optimisation —
 * against a 45-minute turn cap and a 60-minute token it means a token is
 * reused only in its first ten minutes or so, and most turns mint their own.
 */
const REUSE_SLACK_MS = 5 * 60_000;
/**
 * Asked for at every mint rather than inherited from the App's own grant.
 * What the installation is allowed to do is a checkbox on a settings page
 * that anyone with the App can widen; narrowing here means a token in a
 * sandbox stays exactly this wide however that page is later edited.
 */
const TOKEN_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  // Read-only, and the one permission here the agent does not need to push:
  // it is what lets it read why its own pull request's checks failed instead
  // of asking the human to paste the log back.
  actions: 'read',
} as const;

/**
 * The username git wants when an installation token is the password over
 * HTTPS. GitHub ignores it entirely, so it is a fixed constant and not an
 * identity — the identity is in the token.
 */
export const GIT_HTTPS_USERNAME = 'x-access-token';

export class GithubAppError extends Error {
  override readonly name = 'GithubAppError';
  /**
   * `0` where the call never got an answer at all. The body is deliberately
   * not in here: GitHub's error bodies are not secret, but a token echoed
   * back in one would be, and this message reaches the log.
   */
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

/** What a preflight learned, for a log line and a readiness gauge. */
export interface GithubAppStatus {
  readonly installationId: number;
  readonly login: string;
  readonly expiresAt: number;
}

export interface GithubAppOptions {
  /** `MATE_GITHUB_APP_ID`. */
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
    // Parsed once, at construction, so a key that is not a key is a boot
    // failure with mate's own wording rather than an OpenSSL sentence at the
    // first push of the day. WebCrypto cannot do this at all: GitHub's
    // download is PKCS#1 and `importKey('pkcs8')` refuses it, which is why
    // this module is on node:crypto.
    try {
      this.key = createPrivateKey(options.privateKey);
    } catch {
      throw new GithubAppError(0, 'github app private key does not parse');
    }
    this.apiBase = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.reuseFloorMs = options.turnTimeoutMs + REUSE_SLACK_MS;
  }

  /** `clanky-bot[bot]`, once an installation has been read. */
  get login(): string {
    return this.slug ? `${this.slug}[bot]` : 'unknown[bot]';
  }

  /** A token with enough life left for a whole turn, minted if need be. */
  async token(): Promise<InstallationToken> {
    const held = this.held;
    if (held && held.expiresAt - this.options.clock.now() > this.reuseFloorMs) {
      return held;
    }
    this.held = await this.mint();
    return this.held;
  }

  /**
   * Hands the token back the moment the turn is done with it, so the window
   * in which a copy of it is worth anything is about the turn rather than the
   * hour. Authenticated with the token itself — there is nothing else that
   * can revoke one.
   *
   * It is not instant, and nothing here should be written as though it were.
   * Measured against GitHub: `DELETE` answers 204 immediately, the token
   * still authorises reads and writes at two seconds, and is refused with a
   * 401 by five. So this closes the window to seconds, not to zero, and a
   * copy taken during a turn outlives the turn briefly. What bounds it
   * absolutely is the hour on the token itself.
   */
  async revoke(token: string): Promise<void> {
    // A revoked token must never be handed out again, whoever asked for this.
    if (this.held?.token === token) this.held = null;
    const response = await this.call('/installation/token', token, {
      method: 'DELETE',
    });
    if (!response.ok) throw await this.failure(response, 'revoke token');
    await response.text().catch(() => '');
  }

  /**
   * One real mint, end to end: JWT, installation, token. Nothing short of it
   * proves the key on disk still matches a live installation, which is why it
   * runs at boot and on a timer rather than being inferred from the last
   * turn. The token it makes is kept rather than thrown away — the next turn
   * is entitled to it under the same reuse rule as any other.
   *
   * It answers with what it learned and says nothing itself, for the reason
   * this module records no metrics either: the caller is what publishes
   * `mate_github_app_ready`, and a line written here as well would be the
   * same news twice — which is exactly what it was, in the same millisecond,
   * on the first boot this shipped to.
   */
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
      // The App was removed and installed again, so the id cached at boot
      // names an installation that no longer exists. Discovering once more
      // costs one call and turns a permanent outage into a blip; a second
      // 404 is a real answer and is raised.
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

  /**
   * Which installation this App has on the one repository it is installed on.
   * Cached for the life of the process: it changes only when a person removes
   * and reinstalls the App, and `mint` re-reads it when that shows up as a
   * 404.
   */
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

  /**
   * The App's own credential: a short RS256 assertion signed by the private
   * key, good for reading the installation and minting against it and nothing
   * else. It is built per call rather than cached — signing is microseconds,
   * and a cached one is a secret with a lifetime to get wrong.
   */
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
      // No status, because there was no answer: a timeout, a DNS failure, a
      // refused connection. `plain` keeps it to one sentence and no stack.
      throw new GithubAppError(
        0,
        `github ${init.method ?? 'GET'} ${path}: ${plain(error)}`,
      );
    }
  }

  /**
   * The status and GitHub's request id, which is what a support question is
   * asked with. Never the body: a token can appear in one, and this goes to
   * the log.
   */
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
