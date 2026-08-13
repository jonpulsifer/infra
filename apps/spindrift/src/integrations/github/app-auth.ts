/**
 * The GitHub App's own authentication: JWT signing and installation tokens.
 *
 * The App's private key is the only long-lived credential, and it never
 * leaves. Everything else is minted from it per call — an App JWT good for
 * minutes, an installation token good for an hour — so the thing core passes
 * around as a "credential" is an `InstallationRef`, which is a number in a
 * database column and grants nothing on its own.
 *
 * **Identity is resolved per mint, never captured at construction**, from two
 * places in order: the installation Secret (`SPINDRIFT_GITHUB_APP_ID` +
 * `SPINDRIFT_GITHUB_APP_PRIVATE_KEY` — the adopt path for an App that already
 * exists, registered by hand with no conversion response to seal), then the
 * sealed `github_app` row the manifest-flow conversion writes. The row starts
 * empty and is populated mid-flight by the setup route while the pod keeps
 * running; a construction-time capture would keep answering "no App identity"
 * until a restart nobody was told to run. This mirrors the per-call pattern
 * every other sealed row in this process already follows.
 *
 * The key arrives PKCS#1 (`BEGIN RSA PRIVATE KEY` is what the conversion
 * endpoint and GitHub's key generator emit) or PKCS#8. WebCrypto imports only
 * PKCS#8, so `node:crypto`'s `createPrivateKey` parses whichever arrived and
 * re-exports PKCS#8 DER — no operator ceremony, no openssl incantation.
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
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long a manifest-flow `state` nonce stays presentable. */
const SETUP_STATE_LIFETIME_MS = 15 * 60 * 1000;

/** What the conversion endpoint answers with — the only place the key is plaintext. */
const conversionResponse = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  client_id: z.string().min(1),
  pem: z.string().min(1),
  /**
   * Typed `string | null` by the REST schema. Null is handled as the
   * refuse-all-deliveries posture — the same behaviour as no App existing at
   * all — not sealed and later crashed on, and not a failed setup.
   */
  webhook_secret: z.string().min(1).nullable().catch(null),
});

const setupState = z
  .object({ userId: z.string().min(1), issuedAt: z.number().int() })
  .strict();

/** Raised when the setup route must refuse rather than convert. */
export class GitHubAppSetupError extends Error {
  override readonly name = 'GitHubAppSetupError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The public half of the App identity — never the key. */
export interface GitHubAppIdentity {
  readonly appId: string;
  readonly slug: string;
  readonly clientId: string;
}

// --- The adopt-existing path: identity from the installation Secret --------
//
// An App that already exists was registered by hand, so there is no
// conversion response to seal: the operator pastes its id and private key
// into the installation Secret instead, and these take precedence over any
// sealed `github_app` row. Both must be set for the pair to count — half a
// pair is a misconfiguration, and it reads as "no App identity" rather than
// as an identity with a guessed half.

/** Numeric App id of an adopted App. */
export const GITHUB_APP_ID_VAR = 'SPINDRIFT_GITHUB_APP_ID';
/** The adopted App's private key, PEM — PKCS#1 (GitHub's own export) or PKCS#8. */
export const GITHUB_APP_PRIVATE_KEY_VAR = 'SPINDRIFT_GITHUB_APP_PRIVATE_KEY';
/**
 * The App-level webhook secret, for an adopted App whose webhook the operator
 * configures directly in GitHub's settings. Absent keeps the
 * refuse-all-deliveries posture.
 */
export const GITHUB_WEBHOOK_SECRET_VAR = 'SPINDRIFT_GITHUB_WEBHOOK_SECRET';

/** Whether the installation Secret supplies an adopted App identity. */
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
  /**
   * Opens the sealed `github_app` row. `null` disables the conversion-stored
   * path entirely — an adopted identity from the environment needs no keyring.
   */
  readonly keyring: CredentialKeyring | null;
  /** Where the adopt-path variables are read from. Always passed explicitly. */
  readonly env: Record<string, string | undefined>;
  /** Base URL of the repository host's REST API, without a trailing slash. */
  readonly apiBaseUrl: string;
  /** The host's web origin — where the manifest-POST form targets. */
  readonly webBaseUrl: string;
  /** The control plane's own origin, for the manifest's redirect/setup URLs. */
  readonly controlPlaneHostname: string;
  /** Pre-fills the suggested App name on the creation page. */
  readonly installationName: string;
  /**
   * The adopted App's slug — public, declared in the manifest so the install
   * link (`…/apps/<slug>/installations/new`) can be composed. The
   * manifest-flow conversion stores its own slug and ignores this.
   */
  readonly appSlug?: string | null;
  /**
   * Where the created App's webhooks are delivered — the tunnel hostname's
   * full URL, never the control plane's LAN name, which GitHub's delivery
   * servers cannot reach. Null declares no webhook at all.
   */
  readonly webhookUrl: string | null;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/** A minted installation access token and the moment it stops working. */
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

/** Whichever PEM arrived, as the PKCS#8 DER WebCrypto imports. */
function pkcs8Der(pem: string): Uint8Array {
  return new Uint8Array(
    createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' }),
  );
}

/**
 * Everything minted from the App's sealed identity.
 *
 * One object rather than a function per call because the two caches — the
 * imported signing key and the per-installation token — are what keep a loop
 * over a dozen repositories from minting a dozen JWTs a minute, and a cache
 * that is not owned by something is a module-level global. Both caches key on
 * what they were minted *from*, so a replaced key or a re-created App
 * invalidates them without a restart.
 */
export class GitHubAppAuth {
  private readonly tokens = new Map<string, InstallationToken>();
  private signingKey: { ciphertext: string; key: Promise<CryptoKey> } | null =
    null;

  constructor(private readonly options: GitHubAppAuthOptions) {}

  /**
   * The adopted identity from the installation Secret, or `null`.
   *
   * `iss` on a JWT may be the client id or the app id; an adopted App's
   * Secret carries only the id, so the id is the issuer. The slug is public
   * display-and-links material and comes from the manifest (`appSlug`).
   */
  private envIdentity(): (GitHubAppIdentity & { pem: string }) | null {
    const appId = this.options.env[GITHUB_APP_ID_VAR]?.trim();
    const pem = this.options.env[GITHUB_APP_PRIVATE_KEY_VAR]?.trim();
    if (!appId || !pem) return null;
    return {
      appId,
      slug: this.options.appSlug?.trim() || `app-${appId}`,
      clientId: appId,
      pem,
    };
  }

  /** The identity's public half, or `null` before the App exists. */
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
   * Combined App/installation identity recorded on source receipts.
   *
   * Read through `identity()`, which knows both homes an App id lives in — an
   * adopted App has no sealed row, and a receipt that only consulted the row
   * failed a staging fetch that had already succeeded.
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

  /**
   * The App's own JWT: proves *which App is asking*, and nothing about a
   * repository. Presented to the token endpoint and to the two enumeration
   * endpoints that identify the App itself.
   */
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
    // Backdating by a minute is the documented remedy for the far side's clock
    // running slightly behind this one, which it rejects outright.
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

  /** A JWT `Authorization` value, for the App-identifying endpoints. */
  async appAuthorization(): Promise<string> {
    return `Bearer ${await this.appJwt()}`;
  }

  /**
   * A bearer value for one installation, minted or reused.
   *
   * Returned as a full `Authorization` value rather than a bare token so that
   * no caller has to know the scheme — and so that grepping this package for a
   * token-shaped string finds this method rather than a dozen call sites.
   */
  async authorization(ref: InstallationRef): Promise<string> {
    return `Bearer ${await this.installationToken(ref)}`;
  }

  /**
   * A `401` on an installation token: drop the cached value and say retry.
   *
   * The transport retries a send at most once, so the sequence is bounded —
   * the retried request mints fresh, and a second `401` classifies as
   * `ACCESS_LOST` like any other. Nothing durable is deleted, because nothing
   * durable was spent: an installation token is an hour-lived mint, not the
   * credential Device Flow used to erase here.
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

  // --- The manifest flow, which is how the identity above comes to exist ---

  /**
   * The create-the-App form for one operator.
   *
   * The `state` nonce is the keyring sealing `{userId, issuedAt}` rather than
   * a stored row: the callback opens it, checks the same operator is behind
   * the session, and refuses anything older than its window. The conversion
   * code itself is single-use on the far side, and conversion is refused
   * outright once a row exists, so a replay buys nothing.
   */
  async setup(userId: string): Promise<{ action: string; manifest: string }> {
    if (this.options.keyring === null) {
      // Unreachable through the UI — with no keyring and no adopted identity
      // the connector is `unavailable` — but this method must not silently
      // hand out a form whose conversion could never seal anything.
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
   * The `code=` leg of the setup route: convert, seal, store — once.
   *
   * Replacing an existing App identity is a deliberate, re-auth-gated act,
   * not a side effect of resubmitting the create flow, so an existing row
   * refuses the conversion before the far side is ever asked. The `pem` is
   * sealed immediately and never rendered back; `client_secret` is discarded —
   * nothing in this process makes user-to-server calls.
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
      // Two conversions raced; the first one's identity stands.
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
    // No keyring means the sealed columns can never be opened, so a row is a
    // credential this process cannot use — absent, not half-present.
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

  /**
   * The sealed key's plaintext, with the keyring-rotation rewrite on the way
   * through — an envelope sealed under a legacy keyring key is re-sealed
   * under the active one, which is what keeps additive rotation able to
   * finish.
   */
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
   * The imported signing key, cached against the material it came from — the
   * env PEM itself on the adopt path, the envelope's ciphertext on the
   * sealed path — so a replaced key misses the cache and imports fresh.
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
 * The App-level webhook secret, read per delivery.
 *
 * A standalone reader rather than a method because the webhook route is wired
 * before any registry exists and must see an App created mid-flight without a
 * restart. The installation Secret wins — an adopted App's webhook is
 * configured directly in GitHub's settings and its secret pasted beside the
 * key — and the sealed row answers for a manifest-created App. `null` — no
 * secret anywhere, or a conversion whose response carried none — is the
 * refuse-all-deliveries posture the route already has for it.
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
