/**
 * The GitHub App's own authentication: JWT signing and installation tokens.
 * Identity is read per mint, from the installation Secret first and then the
 * sealed `github_app` row, which the setup route fills while the pod runs.
 */
import { createPrivateKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../../commands/types.ts';
import type { CredentialKeyring } from '../../crypto/credential-envelope.ts';
import type { Database } from '../../db/client.ts';
import { githubApp } from '../../db/schema.ts';
import { RepositoryAuthorizationRequiredError } from '../../domain/repository.ts';
import type { InstallationRef } from './app.ts';
import { type Fetcher, GitHubHttp } from './http.ts';

const SINGLETON_ID = 1;

/** GitHub caps an App JWT at ten minutes; nine leaves room for clock skew. */
const APP_JWT_LIFETIME_SECONDS = 9 * 60;

/**
 * A token that expires mid-request returns a `401` that reads as lost access,
 * so a cached token is replaced this long before it expires.
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const SETUP_STATE_LIFETIME_MS = 15 * 60 * 1000;

const conversionResponse = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  client_id: z.string().min(1),
  pem: z.string().min(1),
  /**
   * GitHub types this `string | null`. Null is stored as no secret, which
   * refuses every delivery.
   */
  webhook_secret: z.string().min(1).nullable().catch(null),
});

const setupState = z
  .object({ userId: z.string().min(1), issuedAt: z.number().int() })
  .strict();

/** `status` is the HTTP status the setup route answers with. */
export class GitHubAppSetupError extends Error {
  override readonly name = 'GitHubAppSetupError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubAppIdentity {
  readonly appId: string;
  readonly slug: string;
  readonly clientId: string;
}

export const GITHUB_APP_ID_VAR = 'SPINDRIFT_GITHUB_APP_ID';
/** PEM, PKCS#1 or PKCS#8. */
export const GITHUB_APP_PRIVATE_KEY_VAR = 'SPINDRIFT_GITHUB_APP_PRIVATE_KEY';
export const GITHUB_WEBHOOK_SECRET_VAR = 'SPINDRIFT_GITHUB_WEBHOOK_SECRET';

export function hasGitHubAppEnvIdentity(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(
    env[GITHUB_APP_ID_VAR]?.trim() && env[GITHUB_APP_PRIVATE_KEY_VAR]?.trim(),
  );
}

export interface GitHubAppAuthOptions {
  readonly db: Database;
  readonly clock: Clock;
  /** `null` disables the sealed-row path; an adopted App needs no keyring. */
  readonly keyring: CredentialKeyring | null;
  readonly env: Record<string, string | undefined>;
  /** No trailing slash. */
  readonly apiBaseUrl: string;
  /** GitHub's web origin, which the manifest form posts to. */
  readonly webBaseUrl: string;
  readonly controlPlaneHostname: string;
  readonly installationName: string;
  /** Read only on the adopt path; the manifest flow stores GitHub's slug. */
  readonly appSlug?: string | null;
  /**
   * Must be reachable from GitHub: the tunnel URL, never the LAN name. `null`
   * declares no webhook.
   */
  readonly webhookUrl: string | null;
  readonly fetch?: Fetcher;
}

interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** GitHub issues PKCS#1 keys; WebCrypto imports only PKCS#8. */
function pkcs8Der(pem: string): Uint8Array {
  return new Uint8Array(
    createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' }),
  );
}

export class GitHubAppAuth {
  private readonly tokens = new Map<string, InstallationToken>();
  private signingKey: { ciphertext: string; key: Promise<CryptoKey> } | null =
    null;

  constructor(private readonly options: GitHubAppAuthOptions) {}

  private envIdentity(): (GitHubAppIdentity & { pem: string }) | null {
    const appId = this.options.env[GITHUB_APP_ID_VAR]?.trim();
    const pem = this.options.env[GITHUB_APP_PRIVATE_KEY_VAR]?.trim();
    if (!appId || !pem) return null;
    return {
      appId,
      slug: this.options.appSlug?.trim() || `app-${appId}`,
      // GitHub accepts the App id as a JWT `iss`, and the Secret has no client id.
      clientId: appId,
      pem,
    };
  }

  /** `null` until an App exists. */
  async identity(): Promise<GitHubAppIdentity | null> {
    const adopted = this.envIdentity();
    if (adopted !== null) {
      return {
        appId: adopted.appId,
        slug: adopted.slug,
        clientId: adopted.clientId,
      };
    }
    const row = await this.row();
    return row === null
      ? null
      : { appId: row.appId, slug: row.slug, clientId: row.clientId };
  }

  async status(): Promise<
    | { readonly state: 'unauthorized' }
    | { readonly state: 'authorized'; slug: string; appId: string }
  > {
    const identity = await this.identity();
    return identity === null
      ? { state: 'unauthorized' }
      : { state: 'authorized', slug: identity.slug, appId: identity.appId };
  }

  /**
   * The subject recorded on source receipts. It reads `identity()` because an
   * adopted App has no row.
   */
  async principalSubject(ref: InstallationRef): Promise<string> {
    const identity = await this.identity();
    if (identity === null) {
      throw new RepositoryAuthorizationRequiredError(
        'this installation has no GitHub App identity; create one from the Repositories screen',
      );
    }
    return `installation:${ref.installationId}/app:${identity.appId}`;
  }

  async appJwt(): Promise<string> {
    const adopted = this.envIdentity();
    let issuer: string;
    let key: CryptoKey;
    if (adopted !== null) {
      issuer = adopted.clientId;
      key = await this.key(adopted.pem, async () => adopted.pem);
    } else {
      const row = await this.requireRow();
      issuer = row.clientId;
      key = await this.key(row.encryptedPrivateKey, () =>
        this.openSealedKey(row.encryptedPrivateKey),
      );
    }
    const issuedAt = Math.floor(this.options.clock.now().getTime() / 1000);
    // Backdated a minute: GitHub rejects an `iat` ahead of its own clock.
    const claims = {
      iat: issuedAt - 60,
      exp: issuedAt + APP_JWT_LIFETIME_SECONDS,
      iss: issuer,
    };
    const signingInput = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson(claims)}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
  }

  async appAuthorization(): Promise<string> {
    return `Bearer ${await this.appJwt()}`;
  }

  async authorization(ref: InstallationRef): Promise<string> {
    return `Bearer ${await this.installationToken(ref)}`;
  }

  /**
   * Drops the cached token a `401` refused. The transport re-sends once, so a
   * second `401` classifies as `ACCESS_LOST`.
   */
  rejectedAuthorization(ref: InstallationRef, authorization: string): 'retry' {
    const cached = this.tokens.get(ref.installationId);
    if (cached !== undefined && authorization.endsWith(cached.token)) {
      this.tokens.delete(ref.installationId);
    }
    return 'retry';
  }

  private async installationToken(ref: InstallationRef): Promise<string> {
    const cached = this.tokens.get(ref.installationId);
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - this.options.clock.now().getTime() >
        TOKEN_REFRESH_MARGIN_MS
    ) {
      return cached.token;
    }

    const http = new GitHubHttp({
      baseUrl: this.options.apiBaseUrl,
      authorization: () => this.appAuthorization(),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
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

  /**
   * The create-the-App form. The `state` nonce seals the operator and issue
   * time, and the callback checks both.
   */
  async setup(userId: string): Promise<{ action: string; manifest: string }> {
    if (this.options.keyring === null) {
      throw new GitHubAppSetupError(
        503,
        'this installation has no credential keyring, so it has nowhere to seal an App key',
      );
    }
    const state = await this.options.keyring.seal(
      JSON.stringify({
        userId,
        issuedAt: this.options.clock.now().getTime(),
      }),
      'spindrift-github-setup-state',
    );
    const origin = `https://${this.options.controlPlaneHostname}`;
    const manifest = {
      name: `spindrift-${this.options.installationName}`,
      url: origin,
      public: true,
      redirect_url: `${origin}/internal/github/setup`,
      setup_url: `${origin}/internal/github/setup`,
      ...(this.options.webhookUrl === null
        ? {}
        : {
            hook_attributes: { url: this.options.webhookUrl, active: true },
          }),
      default_events: ['push'],
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        actions: 'write',
        workflows: 'write',
        administration: 'write',
      },
    };
    return {
      action: `${this.options.webBaseUrl}/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest),
    };
  }

  /**
   * An existing row refuses before GitHub is asked. `client_secret` is dropped
   * because nothing here makes user-to-server calls.
   */
  async convertManifestCode(input: {
    readonly code: string;
    readonly state: string | null;
    readonly userId: string;
  }): Promise<GitHubAppIdentity> {
    const adopted = this.envIdentity();
    if (adopted !== null) {
      throw new GitHubAppSetupError(
        409,
        `this installation's App identity (${adopted.slug}) arrives through the installation Secret; the manifest flow has nothing to store`,
      );
    }
    const keyring = this.options.keyring;
    if (keyring === null) {
      throw new GitHubAppSetupError(
        503,
        'this installation has no credential keyring, so it has nowhere to seal an App key',
      );
    }
    await this.checkSetupState(input.state, input.userId);
    const existing = await this.row();
    if (existing !== null) {
      throw new GitHubAppSetupError(
        409,
        `this installation already speaks as ${existing.slug}; replacing the App identity is a deliberate act, not a re-run of the create flow`,
      );
    }

    const send = this.options.fetch ?? ((request: Request) => fetch(request));
    const response = await send(
      new Request(
        `${this.options.apiBaseUrl}/app-manifests/${encodeURIComponent(input.code)}/conversions`,
        {
          method: 'POST',
          headers: { Accept: 'application/vnd.github+json' },
        },
      ),
    );
    if (!response.ok) {
      throw new GitHubAppSetupError(
        502,
        `the manifest conversion failed with ${response.status}: the code is single-use and expires after an hour — create the App again`,
      );
    }
    const converted = conversionResponse.parse(await response.json());

    const now = this.options.clock.now();
    const sealedKey = await keyring.seal(
      converted.pem,
      'spindrift-github-app-key',
    );
    const sealedSecret =
      converted.webhook_secret === null
        ? null
        : await keyring.seal(
            converted.webhook_secret,
            'spindrift-github-webhook-secret',
          );
    const [row] = await this.options.db
      .insert(githubApp)
      .values({
        id: SINGLETON_ID,
        appId: String(converted.id),
        slug: converted.slug,
        clientId: converted.client_id,
        encryptedPrivateKey: sealedKey,
        encryptedWebhookSecret: sealedSecret,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: githubApp.id })
      .returning();
    if (row === undefined) {
      throw new GitHubAppSetupError(
        409,
        'an App identity was stored while this conversion ran; the existing one stands',
      );
    }
    this.signingKey = null;
    this.tokens.clear();
    return { appId: row.appId, slug: row.slug, clientId: row.clientId };
  }

  private async checkSetupState(
    state: string | null,
    userId: string,
  ): Promise<void> {
    if (state === null) {
      throw new GitHubAppSetupError(
        400,
        'the manifest conversion arrived without its state nonce; start again from the Repositories screen',
      );
    }
    let opened: { userId: string; issuedAt: number };
    try {
      if (this.options.keyring === null) throw new Error('no keyring');
      const envelope = await this.options.keyring.open(
        state,
        'spindrift-github-setup-state',
      );
      opened = setupState.parse(JSON.parse(envelope.plaintext));
    } catch {
      throw new GitHubAppSetupError(
        400,
        'the state nonce is not one this installation issued; start again from the Repositories screen',
      );
    }
    const age = this.options.clock.now().getTime() - opened.issuedAt;
    if (opened.userId !== userId || age < 0 || age > SETUP_STATE_LIFETIME_MS) {
      throw new GitHubAppSetupError(
        400,
        'the state nonce belongs to another session or has expired; start again from the Repositories screen',
      );
    }
  }

  private async row() {
    // Without a keyring the sealed columns cannot be opened, so the row
    // counts as absent.
    if (this.options.keyring === null) return null;
    const row = await this.options.db.query.githubApp.findFirst({
      where: (app, { eq: equal }) => equal(app.id, SINGLETON_ID),
    });
    return row ?? null;
  }

  private async requireRow() {
    const row = await this.row();
    if (row === null) {
      throw new RepositoryAuthorizationRequiredError(
        'this installation has no GitHub App identity; create one from the Repositories screen',
      );
    }
    return row;
  }

  /** Re-seals a key sealed under a legacy keyring key, so rotation can finish. */
  private async openSealedKey(ciphertext: string): Promise<string> {
    const keyring = this.options.keyring;
    if (keyring === null) {
      throw new RepositoryAuthorizationRequiredError(
        'this installation has no credential keyring to open its App key with',
      );
    }
    const opened = await keyring.open(ciphertext, 'spindrift-github-app-key');
    if (opened.needsRotation) {
      await this.options.db
        .update(githubApp)
        .set({
          encryptedPrivateKey: await keyring.seal(
            opened.plaintext,
            'spindrift-github-app-key',
          ),
          updatedAt: this.options.clock.now(),
        })
        .where(eq(githubApp.id, SINGLETON_ID));
    }
    return opened.plaintext;
  }

  /**
   * Cached on the material it came from, the env PEM or the sealed
   * ciphertext, so a replaced key misses the cache.
   */
  private key(
    cacheKey: string,
    material: () => Promise<string>,
  ): Promise<CryptoKey> {
    if (this.signingKey?.ciphertext === cacheKey) return this.signingKey.key;
    const imported = (async () =>
      crypto.subtle.importKey(
        'pkcs8',
        pkcs8Der(await material()).buffer as ArrayBuffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      ))();
    this.signingKey = { ciphertext: cacheKey, key: imported };
    return imported;
  }
}

/**
 * Read per delivery, so the webhook route sees an App created after boot. The
 * installation Secret wins over the sealed row; `null` refuses every delivery.
 */
export async function githubAppWebhookSecret(
  db: Database,
  keyring: CredentialKeyring | null,
  env: Record<string, string | undefined> = Bun.env,
): Promise<string | null> {
  const supplied = env[GITHUB_WEBHOOK_SECRET_VAR]?.trim();
  if (supplied) return supplied;
  if (keyring === null) return null;
  const row = await db.query.githubApp.findFirst({
    where: (app, { eq: equal }) => equal(app.id, SINGLETON_ID),
  });
  if (row === undefined || row.encryptedWebhookSecret === null) return null;
  const opened = await keyring.open(
    row.encryptedWebhookSecret,
    'spindrift-github-webhook-secret',
  );
  if (opened.needsRotation) {
    await db
      .update(githubApp)
      .set({
        encryptedWebhookSecret: await keyring.seal(
          opened.plaintext,
          'spindrift-github-webhook-secret',
        ),
      })
      .where(eq(githubApp.id, SINGLETON_ID));
  }
  return opened.plaintext;
}
