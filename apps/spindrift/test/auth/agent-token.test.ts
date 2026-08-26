/**
 * Agent tokens, and the one property they exist for.
 *
 * A `sessions` row is now two credentials wearing one shape, and the whole
 * argument for that is that neither is accepted where the other belongs: the
 * cookie that opens the UI loses `HttpOnly`, `Secure` and `SameSite=Lax` the
 * moment somebody copies it into an agent's config file, so if pasting it there
 * *worked*, every operator would eventually do exactly that.
 *
 * So the assertions that matter are the crossed ones. A browser session
 * presented as a bearer token is nobody; an agent token presented as a cookie
 * is nobody. Everything else in this file — lifetime, listing, revocation — is
 * ordinary and is here because a credential you cannot enumerate is a
 * credential you cannot revoke.
 */
import { describe, expect, test } from 'bun:test';
import {
  beginEnrolment,
  completeEnrolment,
  type EnrolmentDeps,
} from '../../src/auth/enrol.ts';
import {
  AGENT_TOKEN_LIFETIME_MS,
  listAgentTokens,
  openAgentToken,
  resolveAgentToken,
  resolveSession,
  revokeAgentToken,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
} from '../../src/auth/session.ts';
import { createAuthenticator } from '../harness/authenticator.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

const RELYING_PARTY = {
  id: 'spindrift.example.test',
  name: 'Spindrift',
  origin: 'https://spindrift.example.test',
} as const;

const START = new Date('2026-01-01T00:00:00Z');

function movableClock(from = START) {
  let now = from;
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** An installation with one operator enrolled, and their browser session. */
async function enrolled(clock: { now: () => Date }): Promise<{
  deps: EnrolmentDeps;
  principal: { id: string; displayName: string };
  sessionToken: string;
}> {
  const deps: EnrolmentDeps = {
    db: database().db,
    clock,
    relyingParty: RELYING_PARTY,
    enrolmentToken: 'the-token-in-the-installation-secret',
  };
  const begun = await beginEnrolment(deps, { token: deps.enrolmentToken! });
  if (!begun.ok) throw new Error('the fixture could not begin an enrolment');

  const authenticator = await createAuthenticator({
    rpId: RELYING_PARTY.id,
    origin: RELYING_PARTY.origin,
  });
  const completed = await completeEnrolment(deps, {
    token: deps.enrolmentToken!,
    ...(await authenticator.register(begun.value.challenge)),
  });
  if (!completed.ok) throw new Error('the fixture could not enrol');

  return {
    deps,
    principal: completed.value.principal,
    sessionToken: completed.value.token,
  };
}

/** A request as an MCP client sends one. */
function bearer(token: string | null): Request {
  return new Request(RELYING_PARTY.origin, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** A request as a browser sends one. */
function cookie(token: string | null): Request {
  return new Request(RELYING_PARTY.origin, {
    headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe('neither key turns the other lock', () => {
  test('a browser session is not a bearer token', async () => {
    const clock = movableClock();
    const { deps, sessionToken } = await enrolled(clock);

    // It is a live session — the negative below is about the surface, not
    // about the row having expired.
    expect(await resolveSession(cookie(sessionToken), deps)).not.toBeNull();
    expect(await resolveAgentToken(bearer(sessionToken), deps)).toBeNull();
  });

  test('an agent token is not a session cookie', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);

    expect(await resolveAgentToken(bearer(token), deps)).not.toBeNull();
    expect(await resolveSession(cookie(token), deps)).toBeNull();
  });

  test('and putting an agent token in a cookie header does not help', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);

    // The kind is in the `where`, so the header a value arrives in cannot
    // launder it into the other kind.
    expect(await resolveSession(cookie(token), deps)).toBeNull();
  });
});

describe('an agent token resolves to the operator who minted it', () => {
  test('until it expires', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);

    const fresh = await resolveAgentToken(bearer(token), deps);
    expect(fresh?.id).toBe(principal.id);

    clock.advance(AGENT_TOKEN_LIFETIME_MS - 1000);
    expect(await resolveAgentToken(bearer(token), deps)).not.toBeNull();

    clock.advance(2000);
    expect(await resolveAgentToken(bearer(token), deps)).toBeNull();
  });

  test('and it outlives a browser session, which is the point of it', () => {
    expect(AGENT_TOKEN_LIFETIME_MS).toBeGreaterThan(SESSION_LIFETIME_MS);
  });

  test('a malformed Authorization header is nobody, not an error', async () => {
    const clock = movableClock();
    const { deps } = await enrolled(clock);

    for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc', 'garbage']) {
      const request = new Request(RELYING_PARTY.origin, {
        headers: { authorization: header },
      });
      expect(await resolveAgentToken(request, deps)).toBeNull();
    }
    expect(await resolveAgentToken(bearer(null), deps)).toBeNull();
  });

  test('the scheme is matched case-insensitively, as RFC 7235 requires', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);

    const request = new Request(RELYING_PARTY.origin, {
      headers: { authorization: `bearer ${token}` },
    });
    expect(await resolveAgentToken(request, deps)).not.toBeNull();
  });
});

describe('a token you cannot list is a token you cannot revoke', () => {
  test('listing names the rows and never the token', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    await openAgentToken(deps, principal);
    clock.advance(1000);
    const { token } = await openAgentToken(deps, principal);

    const rows = await listAgentTokens(deps, principal.id);
    expect(rows).toHaveLength(2);
    // Newest first, so the one just minted leads.
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(
      rows[1]!.createdAt.getTime(),
    );
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test('listing does not show the browser session beside them', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);

    // Enrolment already opened a browser session for this user.
    expect(await listAgentTokens(deps, principal.id)).toHaveLength(0);
  });

  test('revoking one kills it and says so; revoking it twice says so too', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);
    const [row] = await listAgentTokens(deps, principal.id);

    expect(await revokeAgentToken(deps, principal.id, row!.id)).toBe(true);
    expect(await resolveAgentToken(bearer(token), deps)).toBeNull();
    expect(await revokeAgentToken(deps, principal.id, row!.id)).toBe(false);
  });

  test('revoking is scoped to the caller, so an id is not enough', async () => {
    const clock = movableClock();
    const { deps, principal } = await enrolled(clock);
    const { token } = await openAgentToken(deps, principal);
    const [row] = await listAgentTokens(deps, principal.id);

    const someoneElse = crypto.randomUUID();
    expect(await revokeAgentToken(deps, someoneElse, row!.id)).toBe(false);
    expect(await resolveAgentToken(bearer(token), deps)).not.toBeNull();
  });
});
