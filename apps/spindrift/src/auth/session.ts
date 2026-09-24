/**
 * Browser sessions, agent tokens and passkey sign-in. A token is 32 random
 * bytes; its row holds only the SHA-256.
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Clock, Principal, PrincipalKind } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { credentials, sessions, users } from '../db/schema.ts';
import {
  type ChallengePurpose,
  issueChallenge,
  spendChallenge,
} from './challenge.ts';
import { type AuthDeps, type AuthResult, authFailed, authOk } from './types.ts';
import {
  base64urlDecode,
  base64urlEncode,
  isNewerSignCount,
  verifyAssertion,
} from './webauthn.ts';

export const SESSION_COOKIE = 'spindrift_session';

/** Enforced by the row's expiry at every read, not the cookie's `Max-Age`. */
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * `browser` rows are read from `Cookie` and `agent` rows from `Authorization`
 * only, so a copied cookie cannot reach `/mcp` and a token cannot open the UI.
 */
export const SESSION_KINDS = ['browser', 'agent'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

const PRINCIPAL_KIND = {
  browser: 'human',
  agent: 'agent',
} as const satisfies Record<SessionKind, PrincipalKind>;

/**
 * Agent tokens are pasted into config files by hand, so they outlive a browser
 * session; an abandoned one still expires.
 *
 * ponytail: one lifetime for every agent token. Take it as a mint parameter if
 * an operator ever wants a short-lived one for a shared machine.
 */
export const AGENT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** Agent-token commands pass a `CommandContext`, which has no relying party. */
export interface SessionStore {
  readonly db: Database;
  readonly clock: Clock;
}

/** Past any brute force. */
const TOKEN_BYTES = 32;

/** What the database stores in place of a token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Every command is a POST, and `SameSite=Lax` withholds the cookie from a
 * cross-site POST while still sending it on a followed link.
 */
export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_LIFETIME_MS / 1000}`,
  ].join('; ');
}

/** A blank cookie is still sent; only `Max-Age=0` makes the browser drop it. */
export function clearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function sessionTokenOf(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return value === '' ? null : value;
    }
  }
  return null;
}

/** The only place the plaintext token exists; the database holds its hash. */
export interface OpenedSession {
  readonly token: string;
  readonly principal: Principal;
}

async function mint(
  deps: SessionStore,
  user: { id: string; displayName: string },
  kind: SessionKind,
  lifetimeMs: number,
): Promise<OpenedSession & { readonly expiresAt: Date }> {
  const token = base64urlEncode(
    crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)),
  );
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + lifetimeMs);

  await deps.db.insert(sessions).values({
    userId: user.id,
    tokenHash: await hashToken(token),
    kind,
    createdAt: now,
    expiresAt,
  });

  return {
    token,
    expiresAt,
    principal: {
      id: user.id,
      displayName: user.displayName,
      kind: PRINCIPAL_KIND[kind],
    },
  };
}

export function openSession(
  deps: AuthDeps,
  user: { id: string; displayName: string },
): Promise<OpenedSession> {
  return mint(deps, user, 'browser', SESSION_LIFETIME_MS);
}

/** Callers must hold a human principal; the mint command refuses an agent. */
export function openAgentToken(
  deps: SessionStore,
  user: { id: string; displayName: string },
): Promise<OpenedSession & { readonly expiresAt: Date }> {
  return mint(deps, user, 'agent', AGENT_TOKEN_LIFETIME_MS);
}

/** The kind is in the `where`, so no caller can forget to check it. */
async function resolveRow(
  deps: SessionStore,
  token: string,
  kind: SessionKind,
): Promise<{ sessionId: string; principal: Principal } | null> {
  const [row] = await deps.db
    .select({
      sessionId: sessions.id,
      id: users.id,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, await hashToken(token)),
        eq(sessions.kind, kind),
        gt(sessions.expiresAt, deps.clock.now()),
      ),
    );

  return row === undefined
    ? null
    : {
        sessionId: row.sessionId,
        principal: {
          id: row.id,
          displayName: row.displayName,
          kind: PRINCIPAL_KIND[kind],
        },
      };
}

async function resolveToken(
  deps: SessionStore,
  token: string,
  kind: SessionKind,
): Promise<Principal | null> {
  const resolved = await resolveRow(deps, token, kind);
  return resolved === null ? null : resolved.principal;
}

/** Never falls back to `Cookie`: each surface reads exactly one header. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ');
  return value === '' ? null : value;
}

/**
 * `null` for a missing cookie, an unknown token and an expired session alike,
 * so a caller cannot probe which tokens exist.
 */
export async function resolveSession(
  request: Request,
  deps: AuthDeps,
): Promise<Principal | null> {
  const token = sessionTokenOf(request);
  return token === null ? null : resolveToken(deps, token, 'browser');
}

/**
 * Only `agent` rows: a browser cookie pasted into a config file has lost the
 * protection `HttpOnly`, `Secure` and `SameSite` gave it.
 */
export async function resolveAgentToken(
  request: Request,
  deps: SessionStore,
): Promise<Principal | null> {
  const token = bearerTokenOf(request);
  if (token === null) return null;
  const resolved = await resolveRow(deps, token, 'agent');
  if (resolved === null) return null;
  await stampUse(deps, resolved.sessionId, request);
  return resolved.principal;
}

/** The longest textual IPv6 address. */
const IP_MAX = 45;
/** Enough of a `User-Agent` to tell two clients apart, and no more. */
const AGENT_MAX = 200;

/**
 * Caller-controlled headers, clipped before they reach a `text` column. The
 * result is a display label only; nothing authorises on it.
 */
function callerTrace(request: Request): {
  ip: string | null;
  agent: string | null;
} {
  const clip = (value: string | null | undefined, max: number) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  };
  return {
    ip: clip(request.headers.get('x-forwarded-for')?.split(',')[0], IP_MAX),
    agent: clip(request.headers.get('user-agent'), AGENT_MAX),
  };
}

/**
 * ponytail: a write on every `/mcp` call. If that gets costly, skip it while
 * `last_used_at` is under a minute old.
 */
async function stampUse(
  deps: SessionStore,
  sessionId: string,
  request: Request,
): Promise<void> {
  const { ip, agent } = callerTrace(request);
  await deps.db
    .update(sessions)
    .set({ lastUsedAt: deps.clock.now(), lastUsedIp: ip, lastUsedAgent: agent })
    .where(eq(sessions.id, sessionId));
}

export interface AgentTokenRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Null until the token is first presented. */
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly lastUsedAgent: string | null;
}

export async function listAgentTokens(
  deps: SessionStore,
  userId: string,
): Promise<readonly AgentTokenRow[]> {
  return deps.db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      lastUsedIp: sessions.lastUsedIp,
      lastUsedAgent: sessions.lastUsedAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'agent')))
    .orderBy(desc(sessions.createdAt));
}

/**
 * Scoped to the caller's `user_id` and to `agent` rows, so a row id cannot
 * revoke another user's token or a browser session.
 */
export async function revokeAgentToken(
  deps: SessionStore,
  userId: string,
  id: string,
): Promise<boolean> {
  const gone = await deps.db
    .delete(sessions)
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.userId, userId),
        eq(sessions.kind, 'agent'),
      ),
    )
    .returning({ id: sessions.id });
  return gone.length > 0;
}

/**
 * Deletes the row: a cookie the browser forgets is still a token anyone who
 * copied it can present.
 */
export async function closeSession(
  request: Request,
  deps: AuthDeps,
): Promise<void> {
  const token = sessionTokenOf(request);
  if (token === null) return;
  await deps.db.delete(sessions).where(
    and(
      eq(sessions.tokenHash, await hashToken(token)),
      // Signing out never revokes an agent token.
      eq(sessions.kind, 'browser'),
    ),
  );
}

/**
 * Revokes the row and returns the cookie that expires it; either half alone
 * leaves a credential alive.
 */
export async function endSession(
  request: Request,
  deps: AuthDeps,
): Promise<string> {
  await closeSession(request, deps);
  return clearedSessionCookie();
}

/** Readable without a session: `beginSignIn` tells anyone `NOT_ENROLLED`. */
export async function isClaimed(deps: AuthDeps): Promise<boolean> {
  const [any] = await deps.db
    .select({ id: credentials.id })
    .from(credentials)
    .limit(1);
  return any !== undefined;
}

export interface SignInChallenge {
  readonly challenge: string;
  readonly rpId: string;
}

/**
 * No `allowCredentials`: enrolled passkeys are discoverable, so sign-in needs
 * no username.
 */
export async function beginSignIn(
  deps: AuthDeps,
): Promise<AuthResult<SignInChallenge>> {
  const [enrolled] = await deps.db
    .select({ id: credentials.id })
    .from(credentials)
    .limit(1);
  if (enrolled === undefined) {
    return authFailed(
      'NOT_ENROLLED',
      'nobody has enrolled a passkey on this installation yet — enrol with the token from the installation Secret',
    );
  }

  return authOk({
    challenge: await issueChallenge(deps, 'sign_in'),
    rpId: deps.relyingParty.id,
  });
}

export interface SignInResponse {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/**
 * Spends the challenge before any key material is read. The row binds purpose
 * and User, so a sign-in assertion cannot approve a credential change.
 */
export async function verifyPasskeyAssertion(
  deps: AuthDeps,
  response: SignInResponse,
  {
    purpose,
    userId = null,
    unknownChallengeMessage,
  }: {
    readonly purpose: ChallengePurpose;
    readonly userId?: string | null;
    readonly unknownChallengeMessage: string;
  },
): Promise<AuthResult<Principal>> {
  const clientData = readChallenge(response.clientDataJSON);
  if (
    clientData === null ||
    !(await spendChallenge(deps, clientData, purpose, userId))
  ) {
    return authFailed('CHALLENGE_UNKNOWN', unknownChallengeMessage);
  }

  const [credential] = await deps.db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, response.credentialId));

  if (
    credential === undefined ||
    (userId !== null && credential.userId !== userId)
  ) {
    return authFailed(
      'CREDENTIAL_UNKNOWN',
      'that passkey is not enrolled on this installation',
    );
  }

  const verdict = await verifyAssertion({
    credential: {
      publicKey: credential.publicKey,
      algorithm: credential.algorithm,
    },
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    signature: response.signature,
    expected: {
      challenge: clientData,
      origin: deps.relyingParty.origin,
      rpId: deps.relyingParty.id,
    },
  });

  if (!verdict.ok) {
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey did not sign what this installation asked it to',
      verdict.rejection,
    );
  }

  if (!isNewerSignCount(credential.signCount, verdict.signCount)) {
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey reported a counter that went backwards, which means it has been cloned',
      'SIGNATURE_INVALID',
    );
  }

  const now = deps.clock.now();
  await deps.db
    .update(credentials)
    .set({ signCount: verdict.signCount, lastUsedAt: now })
    .where(eq(credentials.id, credential.id));

  const [user] = await deps.db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, credential.userId));

  return user === undefined
    ? authFailed('CREDENTIAL_UNKNOWN', 'that passkey has no account behind it')
    : authOk({ id: user.id, displayName: user.displayName });
}

export async function completeSignIn(
  deps: AuthDeps,
  response: SignInResponse,
): Promise<AuthResult<OpenedSession>> {
  const verified = await verifyPasskeyAssertion(deps, response, {
    purpose: 'sign_in',
    unknownChallengeMessage:
      'that sign-in was not one this installation had open — try again',
  });
  return verified.ok
    ? authOk(await openSession(deps, verified.value))
    : verified;
}

/**
 * Not a check: verification compares this field to the issued challenge later.
 * Reading it first lets the row be spent whether or not verification succeeds.
 */
export function readChallenge(clientDataJSON: string): string | null {
  const bytes = base64urlDecode(clientDataJSON);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const challenge = (parsed as { challenge?: unknown }).challenge;
    return typeof challenge === 'string' ? challenge : null;
  } catch {
    return null;
  }
}
