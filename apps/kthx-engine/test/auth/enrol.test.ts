/**
 * Enrolment against the installation's shipped token, and recovery by rotating
 * it. Real Postgres, because spending the token rests on a unique index.
 */
import { describe, expect, test } from 'bun:test';
import {
  beginEnrolment,
  completeEnrolment,
  type EnrolmentDeps,
} from '../../src/auth/enrol.ts';
import {
  credentials,
  enrolments,
  sessions,
  users,
} from '../../src/db/schema.ts';
import { createAuthenticator } from '../harness/authenticator.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

const RELYING_PARTY = {
  id: 'spindrift.example.test',
  name: 'Spindrift',
  origin: 'https://spindrift.example.test',
} as const;

const SHIPPED_TOKEN = 'the-token-in-the-installation-secret';

function depsWith(token: string | null = SHIPPED_TOKEN): EnrolmentDeps {
  return {
    db: database().db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    relyingParty: RELYING_PARTY,
    enrolmentToken: token,
  };
}

async function enrol(deps: EnrolmentDeps, token = SHIPPED_TOKEN) {
  const begun = await beginEnrolment(deps, { token });
  if (!begun.ok) return { begun, completed: null };

  const authenticator = await createAuthenticator({
    rpId: RELYING_PARTY.id,
    origin: RELYING_PARTY.origin,
  });
  const completed = await completeEnrolment(deps, {
    token,
    ...(await authenticator.register(begun.value.challenge)),
  });
  return { begun, completed, authenticator };
}

describe('a first visit', () => {
  test('enrols a passkey and opens a session', async () => {
    const deps = depsWith();
    const { completed } = await enrol(deps);

    expect(completed?.ok).toBe(true);
    if (!completed?.ok) return;

    // This session token is returned once; the row keeps only its hash.
    expect(completed.value.token).toBeString();
    expect(completed.value.principal.id).toBeString();

    const [user] = await deps.db.select().from(users);
    expect(user).toBeDefined();

    const stored = await deps.db.select().from(credentials);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe(user!.id);
    // The public key is stored as the browser parsed it, so no CBOR decoder
    // is needed.
    expect(stored[0]?.publicKey).toBeString();
    expect(stored[0]?.algorithm).toBe(-7);
  });

  test('offers the challenge only against the shipped token', async () => {
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: 'a guess' });

    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.failure.code).toBe('TOKEN_INVALID');

    expect(await deps.db.select().from(users)).toHaveLength(0);
  });

  test('is impossible on an installation that shipped no token', async () => {
    // A Secret without the key must not leave enrolment open.
    const deps = depsWith(null);
    const begun = await beginEnrolment(deps, { token: '' });

    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.failure.code).toBe('TOKEN_INVALID');
  });
});

describe('the enrolment token is consumed on use', () => {
  test('a second enrolment with the same token is refused', async () => {
    const deps = depsWith();
    const first = await enrol(deps);
    expect(first.completed?.ok).toBe(true);

    const second = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe('TOKEN_SPENT');

    expect(await deps.db.select().from(credentials)).toHaveLength(1);
  });

  test('and is refused at completion too, not only at the start', async () => {
    // The boundary is at the write: a challenge issued before the first
    // enrolment must not be spendable after it.
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await enrol(deps);

    const authenticator = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });
    const late = await completeEnrolment(deps, {
      token: SHIPPED_TOKEN,
      ...(await authenticator.register(begun.value.challenge)),
    });

    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.failure.code).toBe('TOKEN_SPENT');
    expect(await deps.db.select().from(credentials)).toHaveLength(1);
  });

  test('and the record of spending it survives the enrolment', async () => {
    const deps = depsWith();
    await enrol(deps);

    const spent = await deps.db.select().from(enrolments);
    expect(spent).toHaveLength(1);
    expect(JSON.stringify(spent[0])).not.toContain(SHIPPED_TOKEN);
  });
});

describe('recovery is rotating the token', () => {
  test('a rotated token enrols and replaces every passkey', async () => {
    const deps = depsWith();
    await enrol(deps);

    const before = await deps.db.select().from(credentials);
    expect(before).toHaveLength(1);

    const rotated: EnrolmentDeps = {
      ...deps,
      enrolmentToken: 'the token after the Secret was rotated',
    };
    const again = await enrol(rotated, rotated.enrolmentToken!);
    expect(again.completed?.ok).toBe(true);

    const after = await deps.db.select().from(credentials);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  test('and every session the lost device held', async () => {
    // A stolen browser's session is itself a credential.
    const deps = depsWith();
    const first = await enrol(deps);
    expect(first.completed?.ok).toBe(true);

    expect(await deps.db.select().from(sessions)).toHaveLength(1);

    const rotated: EnrolmentDeps = {
      ...deps,
      enrolmentToken: 'the token after the Secret was rotated',
    };
    await enrol(rotated, rotated.enrolmentToken!);

    const open = await deps.db.select().from(sessions);
    // The one the recovery itself opened.
    expect(open).toHaveLength(1);
  });

  test('and the installation keeps one operator, not two', async () => {
    const deps = depsWith();
    await enrol(deps);
    const rotated: EnrolmentDeps = {
      ...deps,
      enrolmentToken: 'the token after the Secret was rotated',
    };
    await enrol(rotated, rotated.enrolmentToken!);

    // An installation has one operator, so recovery restores that account.
    expect(await deps.db.select().from(users)).toHaveLength(1);
  });
});

describe('the ceremony itself', () => {
  test('is refused when it answers a challenge nobody issued', async () => {
    const deps = depsWith();
    const authenticator = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });

    const completed = await completeEnrolment(deps, {
      token: SHIPPED_TOKEN,
      ...(await authenticator.register('a challenge of my own')),
    });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.code).toBe('CHALLENGE_UNKNOWN');
    expect(await deps.db.select().from(credentials)).toHaveLength(0);
  });

  test('spends its challenge, so the same ceremony cannot be replayed', async () => {
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const authenticator = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });
    const response = await authenticator.register(begun.value.challenge);

    expect(
      (await completeEnrolment(deps, { token: SHIPPED_TOKEN, ...response })).ok,
    ).toBe(true);

    // Replayed byte for byte, it fails on the challenge, a check that holds
    // even if the token is rotated between attempts.
    const replay = await completeEnrolment(deps, {
      token: SHIPPED_TOKEN,
      ...response,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.failure.code).toBe('CHALLENGE_UNKNOWN');
  });

  test('is refused when it was performed for another origin', async () => {
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const authenticator = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });
    const completed = await completeEnrolment(deps, {
      token: SHIPPED_TOKEN,
      ...(await authenticator.register(begun.value.challenge, {
        origin: 'https://evil.example',
      })),
    });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.code).toBe('CEREMONY_REFUSED');
    expect(completed.failure.rejection).toBe('ORIGIN_MISMATCH');
    expect(await deps.db.select().from(credentials)).toHaveLength(0);
  });

  test('offers only the algorithms this installation can verify', async () => {
    // Offering Ed25519 would enrol credentials no sign-in can verify.
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.value.algorithms).toEqual([-7, -257]);
  });

  test('asks for a discoverable credential, so signing in needs no username', async () => {
    // With no username field, sign-in cannot supply the credential id a
    // non-resident key needs.
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.value.residentKey).toBe('required');
  });
});
