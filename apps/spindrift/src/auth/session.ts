/**
 * Sessions and sign-in (§"First run and identity" stories 3 and 5).
 *
 * > As an operator, I want to sign in with a passkey and get an **opaque
 * > session that lasts a day**, so that a stolen browser artifact is not a
 * > permanent credential.
 *
 * Both adjectives are mechanisms here rather than descriptions:
 *
 * - **Opaque** — the cookie is 32 random bytes and the row holds only its
 *   SHA-256. There is nothing in the token to decode and nothing in the
 *   database to present. This is the same posture §10 takes with config values,
 *   and it is worth the one cost it has: a session cannot be looked up by
 *   anything except the token, so there is no "list my sessions" screen without
 *   a second index somebody would have to decide to add.
 * - **Lasts a day** — {@link SESSION_LIFETIME_MS}, checked against the injected
 *   clock at every read rather than trusted from the cookie's own `Max-Age`,
 *   which the browser owns and an attacker replaying a stolen token does not
 *   have to respect.
 *
 * Story 5's linked Gateway identity is a *column on the user*
 * (`users.gatewayIdentity`) and never a way in: §"First run" is explicit that
 * the front door's identity "does not become the user model", so nothing here
 * reads a header from the proxy.
 */
import { and, eq, gt } from 'drizzle-orm';
import type { Principal } from '../commands/types.ts';
import { credentials, sessions, users } from '../db/schema.ts';
import { issueChallenge, spendChallenge } from './challenge.ts';
import { type AuthDeps, type AuthResult, authFailed, authOk } from './types.ts';
import {
  base64urlDecode,
  base64urlEncode,
  isNewerSignCount,
  verifyAssertion,
} from './webauthn.ts';

export const SESSION_COOKIE = 'spindrift_session';

/** §"First run" story 3: a day. Stated once, asserted against once. */
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** 32 bytes: the same width as a challenge, and past any brute force. */
const TOKEN_BYTES = 32;

/** What the database stores in place of a token. Never reversible, never logged. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * The `Set-Cookie` value a session travels in.
 *
 * `HttpOnly` keeps it away from script, `Secure` keeps it off plaintext, and
 * `SameSite=Lax` keeps a cross-site form from carrying it — which matters
 * because every command is a POST, and `Lax` is exactly the setting that
 * withholds a cookie from a cross-site POST while still sending it when the
 * operator follows a link to the UI.
 */
export function sessionCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/**
 * The `Set-Cookie` that ends one.
 *
 * `Max-Age=0` rather than an empty value, because a blank cookie is still a
 * cookie the browser will keep sending — only an expiry makes it forget.
 */
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

/** Pull the session token out of a request's `Cookie` header, if it has one. */
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

/** A minted session: the token exists here and never again. */
export interface OpenedSession {
  readonly token: string;
  readonly expiresAt: Date;
  readonly principal: Principal;
}

/** Mint a session for an enrolled user. */
export async function openSession(
  deps: AuthDeps,
  user: { id: string; displayName: string },
): Promise<OpenedSession> {
  const token = base64urlEncode(
    crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)),
  );
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

  await deps.db.insert(sessions).values({
    userId: user.id,
    tokenHash: await hashToken(token),
    createdAt: now,
    expiresAt,
  });

  return {
    token,
    expiresAt,
    principal: { id: user.id, displayName: user.displayName },
  };
}

/**
 * Who is calling, or nobody.
 *
 * This is what `src/web/serve.ts` hands the dispatch surface, so "nobody" here
 * is what every 401 on that surface means. It returns `null` for a missing
 * cookie, an unknown token, and an expired session alike — the boundary above
 * has one answer for all three and inventing three would give a caller a way to
 * probe which tokens exist.
 */
export async function resolveSession(
  request: Request,
  deps: AuthDeps,
): Promise<Principal | null> {
  const token = sessionTokenOf(request);
  if (token === null) return null;

  const [row] = await deps.db
    .select({ id: users.id, displayName: users.displayName })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, await hashToken(token)),
        gt(sessions.expiresAt, deps.clock.now()),
      ),
    );

  return row === undefined
    ? null
    : { id: row.id, displayName: row.displayName };
}

/**
 * End the session a request carries.
 *
 * Deletes the row rather than only clearing the cookie: a cookie a browser
 * forgets is still a token somebody who copied it can present, so signing out
 * has to be a fact on the server or it is not one at all.
 */
export async function closeSession(
  request: Request,
  deps: AuthDeps,
): Promise<void> {
  const token = sessionTokenOf(request);
  if (token === null) return;
  await deps.db
    .delete(sessions)
    .where(eq(sessions.tokenHash, await hashToken(token)));
}

/**
 * Whether anybody has enrolled here yet.
 *
 * The front door needs it to know which of its two states to render, and it is
 * readable without a session on purpose. That is not a leak worth closing:
 * `beginSignIn` already answers `NOT_ENROLLED` to an anonymous caller, so the
 * fact is public either way, and withholding it here would only mean the UI had
 * to discover it by failing a ceremony.
 */
export async function isClaimed(deps: AuthDeps): Promise<boolean> {
  const [any] = await deps.db
    .select({ id: credentials.id })
    .from(credentials)
    .limit(1);
  return any !== undefined;
}

/** What the browser needs to run `navigator.credentials.get()`. */
export interface SignInChallenge {
  readonly challenge: string;
  readonly rpId: string;
}

/**
 * Begin a sign-in.
 *
 * No `allowCredentials` list comes back: enrolment asks for a **discoverable**
 * credential, so the browser can find the passkey for this relying party on its
 * own. That is what makes sign-in usernameless, which v1 needs because it has
 * one operator and no username field anywhere to type into.
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

/** What a browser posts back from `navigator.credentials.get()`. */
export interface SignInResponse {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/**
 * Complete a sign-in.
 *
 * Order matters and is not incidental: the **challenge is spent first**, so a
 * captured ceremony is dead before any key material is looked at, and a replay
 * cannot be distinguished from a challenge that never existed by how long the
 * answer took.
 */
export async function completeSignIn(
  deps: AuthDeps,
  response: SignInResponse,
): Promise<AuthResult<OpenedSession>> {
  const clientData = readChallenge(response.clientDataJSON);
  if (
    clientData === null ||
    !(await spendChallenge(deps, clientData, 'sign_in'))
  ) {
    return authFailed(
      'CHALLENGE_UNKNOWN',
      'that sign-in was not one this installation had open — try again',
    );
  }

  const [credential] = await deps.db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, response.credentialId));

  if (credential === undefined) {
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
    // WebAuthn's clone check. It binds only when the authenticator is actually
    // counting — see `isNewerSignCount` — so a synced passkey reporting zero
    // forever never lands here.
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

  if (user === undefined) {
    // Not reachable through the foreign key, and refusing beats asserting: a
    // credential with no user is a database somebody has been editing by hand.
    return authFailed(
      'CREDENTIAL_UNKNOWN',
      'that passkey has no account behind it',
    );
  }

  return authOk(await openSession(deps, user));
}

/**
 * Read the challenge a ceremony claims to answer, before anything is verified.
 *
 * This is *not* a check — `verifyAssertion` compares the same field against the
 * challenge this server issued, and that comparison is the one that counts.
 * What it buys is the ability to spend the row before doing any work, so the
 * single-use property does not depend on the verification succeeding.
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
