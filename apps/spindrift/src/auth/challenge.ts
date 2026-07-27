/**
 * Issuing and spending WebAuthn challenges (Task 37).
 *
 * A challenge attests to one thing: **this server asked for this ceremony, just
 * now, once.** All three words are load-bearing and each is a different
 * mechanism here — the random value covers "this server", {@link CHALLENGE_TTL_MS}
 * covers "just now", and deleting the row on read covers "once".
 *
 * That last one is why these live in a table rather than in a signed cookie. A
 * signed cookie proves the server issued the value and cannot prove it has not
 * already been answered, so a captured ceremony stays replayable for as long as
 * the cookie is valid. A row that is deleted when it is spent makes the second
 * attempt indistinguishable from a challenge that never existed, which is
 * exactly what the caller should be told.
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import { webauthnChallenges } from '../db/schema.ts';
import type { AuthDeps } from './types.ts';
import { base64urlEncode } from './webauthn.ts';

/**
 * How long a ceremony may stay open.
 *
 * Five minutes is generous for a passkey prompt and short enough that a
 * challenge left on a screen overnight is not one this server still recognises.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** 32 bytes, which is what every authenticator expects a challenge to be. */
const CHALLENGE_BYTES = 32;

export type ChallengePurpose =
  | 'enrol'
  | 'sign_in'
  | 'credential_admin'
  | 'add_passkey';

/** Mint a challenge for one ceremony and remember that it was issued. */
export async function issueChallenge(
  deps: AuthDeps,
  purpose: ChallengePurpose,
  userId: string | null = null,
): Promise<string> {
  const challenge = base64urlEncode(
    crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)),
  );
  const now = deps.clock.now();

  // Reap on the way past rather than on a loop: challenges are written at
  // exactly the rate they need collecting, so the write is the natural place,
  // and a table nobody has touched in a week needs no collector running.
  await deps.db
    .delete(webauthnChallenges)
    .where(lt(webauthnChallenges.expiresAt, now));

  await deps.db.insert(webauthnChallenges).values({
    challenge,
    purpose,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });

  return challenge;
}

/**
 * Spend a challenge, or refuse.
 *
 * Deletes first and reads what it deleted, so two requests racing the same
 * captured ceremony cannot both succeed: Postgres serialises the delete and
 * only one of them gets a row back.
 *
 * Returns `false` for never-issued, wrong-purpose, already-spent, and expired
 * alike. They are one situation from where the caller stands — begin the
 * ceremony again — and distinguishing them in the answer would tell a stranger
 * which of their guesses was closest.
 */
export async function spendChallenge(
  deps: AuthDeps,
  challenge: string,
  purpose: ChallengePurpose,
  userId: string | null = null,
): Promise<boolean> {
  const spent = await deps.db
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.purpose, purpose),
        userId === null
          ? isNull(webauthnChallenges.userId)
          : eq(webauthnChallenges.userId, userId),
      ),
    )
    .returning();

  const row = spent[0];
  if (row === undefined) return false;
  // An expired row is deleted by the statement above and then refused here,
  // which is the outcome the reaper would have reached more slowly.
  return row.expiresAt.getTime() > deps.clock.now().getTime();
}
