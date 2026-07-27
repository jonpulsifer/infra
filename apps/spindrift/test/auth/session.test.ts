/**
 * Sessions and sign-in (§"First run and identity" stories 3 and 5).
 *
 * Story 3 is the one with a number in it — "an opaque session that lasts a day,
 * so that a stolen browser artifact is not a permanent credential" — so the
 * expiry is asserted against an injected clock rather than by waiting, and
 * asserted at the boundary that reads a request rather than on a column.
 *
 * The other claim this file holds is that a session is **opaque**: the row
 * carries a hash and not the cookie's value, so a database somebody reads is
 * not a set of sessions somebody can present.
 */
import { describe, expect, test } from 'bun:test';
import {
  beginEnrolment,
  completeEnrolment,
  type EnrolmentDeps,
} from '../../src/auth/enrol.ts';
import {
  beginSignIn,
  clearedSessionCookie,
  closeSession,
  completeSignIn,
  resolveSession,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  sessionCookie,
} from '../../src/auth/session.ts';
import { credentials, sessions } from '../../src/db/schema.ts';
import {
  type Authenticator,
  createAuthenticator,
} from '../harness/authenticator.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

const RELYING_PARTY = {
  id: 'spindrift.example.test',
  name: 'Spindrift',
  origin: 'https://spindrift.example.test',
} as const;

const START = new Date('2026-01-01T00:00:00Z');

/** A clock a test moves by hand, so "a day later" costs no wall time. */
function movableClock(from = START) {
  let now = from;
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function depsWith(clock: { now: () => Date }): EnrolmentDeps {
  return {
    db: database().db,
    clock,
    relyingParty: RELYING_PARTY,
    enrolmentToken: 'the-token-in-the-installation-secret',
  };
}

/** An installation with one operator already enrolled, and their passkey. */
async function enrolled(clock: { now: () => Date }): Promise<{
  deps: EnrolmentDeps;
  authenticator: Authenticator;
  token: string;
}> {
  const deps = depsWith(clock);
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

  return { deps, authenticator, token: completed.value.token };
}

/** A request carrying a session cookie, as a browser would send one. */
function requestWith(token: string | null): Request {
  return new Request(RELYING_PARTY.origin, {
    headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe('a session lasts a day', () => {
  test('and resolves to the operator until it does not', async () => {
    const clock = movableClock();
    const { deps, token } = await enrolled(clock);

    const fresh = await resolveSession(requestWith(token), deps);
    expect(fresh).not.toBeNull();
    expect(fresh?.displayName).toBeString();

    // One second short of a day.
    clock.advance(SESSION_LIFETIME_MS - 1000);
    expect(await resolveSession(requestWith(token), deps)).not.toBeNull();

    clock.advance(2000);
    expect(await resolveSession(requestWith(token), deps)).toBeNull();
  });

  test('and the lifetime is a day, stated once', () => {
    expect(SESSION_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });

  test('and an expired session is not resurrected by asking again', async () => {
    const clock = movableClock();
    const { deps, token } = await enrolled(clock);

    clock.advance(SESSION_LIFETIME_MS + 1000);
    expect(await resolveSession(requestWith(token), deps)).toBeNull();
    expect(await resolveSession(requestWith(token), deps)).toBeNull();
  });
});

describe('a session is opaque', () => {
  test('so the row holds a hash and never the cookie', async () => {
    const clock = movableClock();
    const { deps, token } = await enrolled(clock);

    const [row] = await deps.db.select().from(sessions);
    expect(row).toBeDefined();
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test('so a token nobody issued resolves to nobody', async () => {
    const clock = movableClock();
    const { deps } = await enrolled(clock);
    expect(
      await resolveSession(requestWith('a token I made up'), deps),
    ).toBeNull();
  });

  test('and no cookie at all is not an error, just nobody', async () => {
    const clock = movableClock();
    const { deps } = await enrolled(clock);
    expect(await resolveSession(requestWith(null), deps)).toBeNull();
  });
});

describe('the cookie it travels in', () => {
  test('is not reachable from script and does not leave the site', () => {
    // The three attributes that make a stolen artifact hard to steal in the
    // first place. Asserted because they are one typo from being absent and
    // nothing else would notice.
    const header = sessionCookie('a-token');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=86400');
  });

  test('and clearing it sends an expiry rather than a blank value', () => {
    // A blank cookie is still a cookie; a browser only forgets one it is told
    // has expired.
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });
});

describe('signing out', () => {
  test('ends the session rather than only clearing the browser', async () => {
    // Clearing the cookie alone would leave a row a stolen token still matches.
    const clock = movableClock();
    const { deps, token } = await enrolled(clock);

    await closeSession(requestWith(token), deps);

    expect(await resolveSession(requestWith(token), deps)).toBeNull();
    expect(await deps.db.select().from(sessions)).toHaveLength(0);
  });

  test('is harmless when there was no session', async () => {
    const clock = movableClock();
    const { deps } = await enrolled(clock);
    await closeSession(requestWith(null), deps);
    // The one real session is untouched.
    expect(await deps.db.select().from(sessions)).toHaveLength(1);
  });
});

describe('signing in with the enrolled passkey', () => {
  test('verifies the assertion and opens a second session', async () => {
    const clock = movableClock();
    const { deps, authenticator } = await enrolled(clock);

    const begun = await beginSignIn(deps);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const completed = await completeSignIn(deps, {
      ...(await authenticator.assert(begun.value.challenge)),
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    expect(
      await resolveSession(requestWith(completed.value.token), deps),
    ).not.toBeNull();
    expect(await deps.db.select().from(sessions)).toHaveLength(2);
  });

  test('records that the passkey was used', async () => {
    const clock = movableClock();
    const { deps, authenticator } = await enrolled(clock);

    const begun = await beginSignIn(deps);
    if (!begun.ok) return;
    clock.advance(60_000);
    await completeSignIn(deps, {
      ...(await authenticator.assert(begun.value.challenge)),
    });

    const [credential] = await deps.db.select().from(credentials);
    expect(credential?.lastUsedAt).not.toBeNull();
  });

  test('refuses a signature the enrolled passkey did not make', async () => {
    const clock = movableClock();
    const { deps, authenticator } = await enrolled(clock);

    const impostor = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });

    const begun = await beginSignIn(deps);
    if (!begun.ok) return;

    const forged = await impostor.assert(begun.value.challenge);
    const completed = await completeSignIn(deps, {
      // The enrolled credential's id, somebody else's signature — the shape an
      // attacker who read the database would produce.
      ...forged,
      credentialId: authenticator.credentialId,
    });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.code).toBe('CEREMONY_REFUSED');
    expect(completed.failure.rejection).toBe('SIGNATURE_INVALID');
  });

  test('refuses a credential nobody enrolled', async () => {
    const clock = movableClock();
    const { deps } = await enrolled(clock);
    const stranger = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });

    const begun = await beginSignIn(deps);
    if (!begun.ok) return;

    const completed = await completeSignIn(deps, {
      ...(await stranger.assert(begun.value.challenge)),
    });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.code).toBe('CREDENTIAL_UNKNOWN');
  });

  test('spends the challenge, so an assertion cannot be replayed', async () => {
    const clock = movableClock();
    const { deps, authenticator } = await enrolled(clock);

    const begun = await beginSignIn(deps);
    if (!begun.ok) return;
    const response = await authenticator.assert(begun.value.challenge);

    expect((await completeSignIn(deps, { ...response })).ok).toBe(true);

    const replay = await completeSignIn(deps, { ...response });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.failure.code).toBe('CHALLENGE_UNKNOWN');
  });

  test('is refused before anyone has enrolled', async () => {
    // An installation nobody has claimed has no passkey to check, and saying so
    // is more useful than issuing a challenge that could never be answered.
    const deps = depsWith(movableClock());
    const begun = await beginSignIn(deps);

    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.failure.code).toBe('NOT_ENROLLED');
  });
});

describe('expired challenges', () => {
  test('are refused rather than accepted late', async () => {
    const clock = movableClock();
    const { deps, authenticator } = await enrolled(clock);

    const begun = await beginSignIn(deps);
    if (!begun.ok) return;

    // A ceremony left open overnight is not a ceremony this server issued a
    // moment ago, which is the only thing a challenge attests to.
    clock.advance(60 * 60 * 1000);
    const completed = await completeSignIn(deps, {
      ...(await authenticator.assert(begun.value.challenge)),
    });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.code).toBe('CHALLENGE_UNKNOWN');
  });
});
