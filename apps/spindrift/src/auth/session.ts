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
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Clock, Principal } from '../commands/types.ts';
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

/** §"First run" story 3: a day. Stated once, asserted against once. */
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * What a `sessions` row is a credential *for*.
 *
 * Both kinds are 32 opaque bytes stored as a SHA-256, because that mechanism
 * was already right. What differs is the surface each is presented at and the
 * lifetime each carries, and those differences are only real if the lookup
 * enforces them: {@link resolveSession} reads `browser` rows from a `Cookie`
 * header and {@link resolveAgentToken} reads `agent` rows from `Authorization`,
 * and neither will accept the other's row no matter which header carries it.
 *
 * That is the whole reason this is a column rather than a convention. A copied
 * cookie in an agent's config file cannot reach `/mcp`, and a leaked agent
 * token cannot open the UI — by construction, not by review.
 */
export const SESSION_KINDS = ['browser', 'agent'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * How long an agent token lasts: ninety days.
 *
 * Longer than a browser session on purpose, and the reason is the honest one —
 * a credential pasted into a config file is re-pasted by hand, so a day would
 * mean an operator who re-mints daily forever, and an operator who automates
 * around that has built a worse credential than this one. Ninety days is short
 * enough that an abandoned token dies on its own and long enough that nobody is
 * tempted to route around it.
 *
 * ponytail: one lifetime for every agent token. Take it as a mint parameter if
 * an operator ever wants a short-lived one for a shared machine.
 */
export const AGENT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The narrow slice of {@link AuthDeps} a token read or write actually needs.
 *
 * Named separately because minting and revoking are *commands* — they run
 * against a `CommandContext`, which carries a db and a clock and no relying
 * party, since no ceremony happens at that point. A command that had to
 * construct a `RelyingParty` to write a row would be constructing a fact it has
 * no business knowing.
 */
export interface SessionStore {
  readonly db: Database;
  readonly clock: Clock;
}

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
  readonly principal: Principal;
}

/**
 * Mint a row of either kind. The token exists in the return value and nowhere
 * else, here and for {@link openAgentToken} alike.
 */
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
    principal: { id: user.id, displayName: user.displayName },
  };
}

/** Mint a browser session for an enrolled user. */
export function openSession(
  deps: AuthDeps,
  user: { id: string; displayName: string },
): Promise<OpenedSession> {
  return mint(deps, user, 'browser', SESSION_LIFETIME_MS);
}

/**
 * Mint an agent token for an enrolled user.
 *
 * Deliberately *not* reachable without an existing browser session: the command
 * that calls this runs on the session-authenticated dispatch surface, so a
 * passkey assertion is upstream of every token that exists. The token is what
 * an agent presents; the session is what authorises its creation, and the two
 * never swap roles.
 */
export function openAgentToken(
  deps: SessionStore,
  user: { id: string; displayName: string },
): Promise<OpenedSession & { readonly expiresAt: Date }> {
  return mint(deps, user, 'agent', AGENT_TOKEN_LIFETIME_MS);
}

/**
 * Look one token up, of one kind, unexpired.
 *
 * The kind is part of the `where` rather than something a caller checks
 * afterwards, because "afterwards" is where somebody eventually forgets.
 */
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
        principal: { id: row.id, displayName: row.displayName },
      };
}

/**
 * The principal alone, for the callers with no row to stamp.
 *
 * The row id exists on {@link resolveRow} because the agent path writes back to
 * the row it just matched. Browser sessions do not, so they get the narrower
 * answer rather than an id every caller would have to know to ignore.
 */
async function resolveToken(
  deps: SessionStore,
  token: string,
  kind: SessionKind,
): Promise<Principal | null> {
  const resolved = await resolveRow(deps, token, kind);
  return resolved === null ? null : resolved.principal;
}

/**
 * Pull a bearer token out of a request's `Authorization` header, if it has one.
 *
 * The mirror of {@link sessionTokenOf}, and separate from it on purpose: these
 * two functions are the only places a credential enters this module, and each
 * reads exactly one header. A single reader that fell back from one to the
 * other is how the two surfaces would quietly become one again.
 */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ');
  return value === '' ? null : value;
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
  return token === null ? null : resolveToken(deps, token, 'browser');
}

/**
 * Who is calling `/mcp`, or nobody.
 *
 * Reads `Authorization: Bearer` and `agent` rows, and nothing else. An operator
 * who pastes their browser cookie here gets 401, which is the point: the value
 * that opens the UI has `HttpOnly`, `Secure` and `SameSite=Lax` protecting it
 * inside a browser and none of them once it is sitting in a config file, so the
 * one thing worse than asking an operator to mint a second credential is
 * letting them not.
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

/** The longest an IPv6 address gets, written out in full. */
const IP_MAX = 45;
/** Enough of a `User-Agent` to tell two clients apart, and no more. */
const AGENT_MAX = 200;

/**
 * What the caller says it is, clipped to what a column should hold.
 *
 * Both values arrive in headers the caller controls, so both are bounded here
 * rather than trusted to be sane — a header has no length a client is obliged
 * to respect, and an unbounded write of one into a `text` column is the caller
 * choosing how much of the database to spend.
 *
 * `X-Forwarded-For` is read at its first hop, which is the client as the
 * nearest proxy saw it. Whether that proxy is trustworthy is a deployment
 * fact this module does not get to assert — which is exactly why nothing
 * authorises on the result. It is a label on a list row.
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
 * Record that this token was just presented, and by what.
 *
 * By primary key, on a row the select above already matched, so it is one
 * indexed write and it cannot touch a token that did not authenticate.
 *
 * ponytail: a write on every `/mcp` call, which is the right cost while an
 * agent makes a handful of tool calls at a time. If that stops being true,
 * the cheap next step is to skip the write when `last_used_at` is already
 * within a minute — not to drop it.
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

/** One agent token, as a screen or an operator lists them. */
export interface AgentTokenRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Null until it has been presented once. See `sessions.lastUsedAt`. */
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly lastUsedAgent: string | null;
}

/**
 * Every agent token this user holds, newest first.
 *
 * The header comment's "no list-my-sessions screen without a second index"
 * applies to *browser* sessions and stays true of them. An agent token is a
 * different object: it is long-lived, it lives in a file, and a credential you
 * cannot enumerate is a credential you cannot revoke — so this read exists, by
 * `user_id`, and returns no token material because there is none to return.
 */
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
 * Revoke one agent token by its row id.
 *
 * Scoped to the caller's own `user_id` as well as to `agent`, so the id — which
 * is the one thing about a token that *is* enumerable — cannot be spent against
 * somebody else's row or against a browser session. Returns whether a row went,
 * so a caller can tell "revoked" from "already gone".
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
  await deps.db.delete(sessions).where(
    and(
      eq(sessions.tokenHash, await hashToken(token)),
      // Signing out ends a browser session and never an agent token: the two
      // are revoked from different places on purpose, and a cookie header is
      // not where a token is meant to arrive anyway.
      eq(sessions.kind, 'browser'),
    ),
  );
}

/**
 * Perform the complete sign-out operation for the HTTP adapter.
 *
 * Revoking the server row and expiring the browser value are one operation:
 * doing only either half leaves a credential alive somewhere. Returning the
 * cookie string keeps that composition below the transport route.
 */
export async function endSession(
  request: Request,
  deps: AuthDeps,
): Promise<string> {
  await closeSession(request, deps);
  return clearedSessionCookie();
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
 * Verify one enrolled passkey assertion for a particular purpose and owner.
 *
 * Sign-in and credential administration share the cryptographic operation but
 * not the challenge namespace. The purpose and optional User binding are read
 * from the same single-use row, so an assertion begun for signing in cannot be
 * replayed as approval to change credentials.
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
