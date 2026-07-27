/**
 * Enrolment (§"First run and identity" stories 1, 2, and 4).
 *
 * Three claims, and each one is a fact about rows rather than about a return
 * value:
 *
 * 1. A first visit enrols a passkey against the token that shipped with the
 *    installation, and comes out fully privileged.
 * 2. **The token is consumed on use**, so the window in which anyone else could
 *    claim the installation closes the moment the first operator finishes.
 * 3. Recovery is rotating the token and replacing every passkey — so a *new*
 *    token enrols, and doing so leaves none of the old credentials behind.
 *
 * Real Postgres, because (2) rests on a unique index and not on a check
 * somebody remembered to write, and a fake store cannot falsify that.
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

/** Run a whole enrolment the way a browser would: begin, ceremony, complete. */
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

    // A session token comes back exactly once — this is the only moment the
    // value exists outside the browser.
    expect(completed.value.token).toBeString();
    expect(completed.value.principal.id).toBeString();

    const [user] = await deps.db.select().from(users);
    expect(user).toBeDefined();

    const stored = await deps.db.select().from(credentials);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe(user!.id);
    // The public key is stored as the browser parsed it; there is no CBOR
    // decoder in this codebase and this is the row that proves it is not needed.
    expect(stored[0]?.publicKey).toBeString();
    expect(stored[0]?.algorithm).toBe(-7);
  });

  test('offers the challenge only against the shipped token', async () => {
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: 'a guess' });

    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.failure.code).toBe('TOKEN_INVALID');

    // Nothing was minted for a caller who could not name the token.
    expect(await deps.db.select().from(users)).toHaveLength(0);
  });

  test('is impossible on an installation that shipped no token', async () => {
    // An installation whose Secret is missing the key cannot be claimed at all,
    // which is the correct posture: the alternative is an open enrolment.
    const deps = depsWith(null);
    const begun = await beginEnrolment(deps, { token: '' });

    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.failure.code).toBe('TOKEN_INVALID');
  });
});

describe('the enrolment token is consumed on use', () => {
  test('a second enrolment with the same token is refused', async () => {
    // Story 2, stated as the window closing. This is the assertion the whole
    // `enrolments` table exists for.
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
    // The check that matters is the one next to the write: a caller who held a
    // challenge from before the first enrolment must not be able to spend it
    // afterwards. `begin` is a courtesy; this is the boundary.
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
    // The token is not in the row — only its hash, the same posture §10 takes
    // with config values.
    expect(JSON.stringify(spent[0])).not.toContain(SHIPPED_TOKEN);
  });
});

describe('recovery is rotating the token', () => {
  test('a rotated token enrols and replaces every passkey', async () => {
    // Story 4: "recovery to mean rotating the token and replacing every
    // passkey, so that losing a device does not lose the installation." One
    // act, not two — the operator edits the Secret and enrols again.
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
    // The lost device's passkey is gone rather than joined by a second one.
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  test('and every session the lost device held', async () => {
    // A recovery that left the stolen browser's session alive would recover
    // nothing: the session is the credential §"First run" story 3 is worried
    // about.
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
    // Exactly the one the recovery itself opened.
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

    // v1 is single-operator (§ Out of Scope), so recovery restores the account
    // rather than accumulating one per rotation.
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

    // Replayed byte for byte. It fails on the challenge rather than on the
    // token, which is the check that would still hold if the token had been
    // rotated between the two attempts.
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
    // A begin that offered Ed25519 would produce credentials no sign-in could
    // check — the failure would land a ceremony later, on the operator.
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.value.algorithms).toEqual([-7, -257]);
  });

  test('asks for a discoverable credential, so signing in needs no username', async () => {
    // v1 has one operator and no username field anywhere. A non-resident key
    // would make sign-in need a credential id the browser has no way to supply.
    const deps = depsWith();
    const begun = await beginEnrolment(deps, { token: SHIPPED_TOKEN });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.value.residentKey).toBe('required');
  });
});
