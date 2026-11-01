/**
 * The caller's Google Application Default Credentials: an access token for the
 * sites bucket, the email a site's marker names as its owner, and an ID token
 * the server checks against that email. A gcloud user's `authorized_user` file
 * and a workload's `external_account` file are read; no gcloud binary runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type FederationConfig,
  type Fetcher,
  workloadIdentityToken,
} from '@repo/archive/federation';
import { parseFederationCredential } from '@repo/archive/federation-credential';
import { KthxError } from './error.ts';

/** The `aud` a service account's ID token carries, which the server accepts. */
export const ID_AUDIENCE = 'https://kthx.dev';

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Re-mint this long before expiry, so a call never carries a dying token. */
const EARLY_MS = 60_000;

export interface Credentials {
  /** The file the credentials came from. */
  readonly source: string;
  accessToken(): Promise<string>;
  email(): Promise<string>;
  idToken(): Promise<string>;
}

type Env = Record<string, string | undefined>;

/** Where gcloud and Google's libraries look, in their order. */
export function adcPath(env: Env = process.env): string {
  const named = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (named) return named;
  const config =
    env.CLOUDSDK_CONFIG?.trim() || join(homedir(), '.config', 'gcloud');
  return join(config, 'application_default_credentials.json');
}

export function loadCredentials(
  env: Env = process.env,
  send: Fetcher = (request) => fetch(request),
): Credentials {
  const path = adcPath(env);
  if (!existsSync(path)) {
    throw new KthxError(
      'NO_CREDENTIALS',
      `no Application Default Credentials at ${path}; run gcloud auth application-default login`,
    );
  }
  const text = readFileSync(path, 'utf8');
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new KthxError(
      'NO_CREDENTIALS',
      `${path}: ${(cause as Error).message}`,
    );
  }
  if (document.type === 'authorized_user') {
    return userCredentials(path, document, send);
  }
  if (document.type === 'external_account') {
    let config: FederationConfig;
    try {
      config = parseFederationCredential(text, path);
    } catch (cause) {
      throw new KthxError('NO_CREDENTIALS', (cause as Error).message);
    }
    return workloadCredentials(path, config, send);
  }
  throw new KthxError(
    'NO_CREDENTIALS',
    `${path} is a ${String(document.type)} credential; kthx reads authorized_user (gcloud auth application-default login) and external_account`,
  );
}

interface Minted {
  readonly access: string;
  readonly id: string | null;
  readonly until: number;
}

/** The refresh-token grant answers an access token and, for gcloud's scopes, an ID token. */
function userCredentials(
  source: string,
  document: Record<string, unknown>,
  send: Fetcher,
): Credentials {
  const tokenUri =
    typeof document.token_uri === 'string'
      ? document.token_uri
      : GOOGLE_TOKEN_URI;
  let held: Minted | null = null;
  let minting: Promise<Minted> | null = null;

  const mint = async (): Promise<Minted> => {
    if (held !== null && Date.now() < held.until) return held;
    minting ??= (async () => {
      const response = await send(
        new Request(tokenUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: String(document.client_id ?? ''),
            client_secret: String(document.client_secret ?? ''),
            refresh_token: String(document.refresh_token ?? ''),
          }),
        }),
      ).catch((cause: Error) => {
        throw new KthxError('UNREACHABLE', `${tokenUri}: ${cause.message}`);
      });
      if (!response.ok) {
        throw new KthxError(
          'NO_CREDENTIALS',
          `${tokenUri} refused the credentials in ${source} (${response.status}); run gcloud auth application-default login`,
        );
      }
      const body = (await response.json()) as {
        access_token?: string;
        id_token?: string;
        expires_in?: number;
      };
      if (body.access_token === undefined) {
        throw new KthxError(
          'NO_CREDENTIALS',
          `${tokenUri} answered no access token`,
        );
      }
      held = {
        access: body.access_token,
        id: body.id_token ?? null,
        until: Date.now() + (body.expires_in ?? 3600) * 1000 - EARLY_MS,
      };
      return held;
    })().finally(() => {
      minting = null;
    });
    return minting;
  };

  let email: Promise<string> | null = null;
  return {
    source,
    accessToken: async () => (await mint()).access,
    async idToken() {
      const { id } = await mint();
      if (id === null) {
        throw new KthxError(
          'NO_ID_TOKEN',
          `the credentials in ${source} carry no ID token; run gcloud auth application-default login`,
        );
      }
      return id;
    },
    email() {
      email ??= (async () => {
        const minted = await mint();
        const claimed = minted.id === null ? null : claimsOf(minted.id).email;
        if (typeof claimed === 'string' && claimed !== '') {
          return claimed.toLowerCase();
        }
        return tokenInfoEmail(new URL(tokenUri).origin, minted.access, send);
      })();
      return email;
    },
  };
}

async function tokenInfoEmail(
  origin: string,
  access: string,
  send: Fetcher,
): Promise<string> {
  const response = await send(
    new Request(
      `${origin}/tokeninfo?access_token=${encodeURIComponent(access)}`,
    ),
  );
  const body = (await response.json().catch(() => ({}))) as { email?: string };
  if (!response.ok || typeof body.email !== 'string') {
    throw new KthxError(
      'NO_EMAIL',
      'these credentials name no email; run gcloud auth application-default login',
    );
  }
  return body.email.toLowerCase();
}

/**
 * A workload's federated credential, impersonating a service account whose
 * email is the owner. The ID token is minted with the federated token, which
 * `roles/iam.workloadIdentityUser` lets ask for one.
 */
function workloadCredentials(
  source: string,
  config: FederationConfig,
  send: Fetcher,
): Credentials {
  const impersonation = config.impersonationUrl;
  const account =
    impersonation === null
      ? null
      : (/\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(
          impersonation,
        )?.[1] ?? null);
  if (impersonation === null || account === null) {
    throw new KthxError(
      'NO_EMAIL',
      `${source} impersonates no service account, so it names no owner; set service_account_impersonation_url`,
    );
  }
  const access = workloadIdentityToken({ ...config, fetch: send });
  const federated = workloadIdentityToken({
    ...config,
    impersonationUrl: null,
    fetch: send,
  });
  const idUrl = impersonation.replace(
    /:generateAccessToken$/,
    ':generateIdToken',
  );
  let held: { token: string; until: number } | null = null;

  return {
    source,
    accessToken: async () => access(),
    email: async () => decodeURIComponent(account).toLowerCase(),
    async idToken() {
      if (held !== null && Date.now() < held.until) return held.token;
      const response = await send(
        new Request(idUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await federated()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ audience: ID_AUDIENCE, includeEmail: true }),
        }),
      );
      const body = (await response.json().catch(() => ({}))) as {
        token?: string;
      };
      if (!response.ok || typeof body.token !== 'string') {
        throw new KthxError(
          'NO_ID_TOKEN',
          `${idUrl} refused an ID token (${response.status})`,
        );
      }
      const exp = claimsOf(body.token).exp;
      held = {
        token: body.token,
        until:
          typeof exp === 'number'
            ? exp * 1000 - EARLY_MS
            : Date.now() + EARLY_MS,
      };
      return body.token;
    },
  };
}

/** Read, never trusted: the server is what verifies a token. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const value: unknown = JSON.parse(
      Buffer.from(part, 'base64url').toString('utf8'),
    );
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
