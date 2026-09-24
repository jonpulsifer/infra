/**
 * Single-use WebAuthn challenges, stored as rows that are deleted when spent so
 * a captured ceremony cannot be replayed.
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import { webauthnChallenges } from '../db/schema.ts';
import type { AuthDeps } from './types.ts';
import { base64urlEncode } from './webauthn.ts';

/** Long enough for a passkey prompt. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** WebAuthn asks for at least 16 random bytes. */
const CHALLENGE_BYTES = 32;

export type ChallengePurpose =
  | 'enrol'
  | 'sign_in'
  | 'credential_admin'
  | 'add_passkey';

export async function issueChallenge(
  deps: AuthDeps,
  purpose: ChallengePurpose,
  userId: string | null = null,
): Promise<string> {
  const challenge = base64urlEncode(
    crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)),
  );
  const now = deps.clock.now();

  // Expired rows are reaped on each issue, so no background collector runs.
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
 * Deletes and reads back in one statement, so two racing requests cannot both
 * spend a challenge. Returns `false` for never-issued, wrong-purpose, spent and
 * expired alike, so a stranger cannot tell which guess came closest.
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
  // An expired row is deleted above and refused here.
  return row.expiresAt.getTime() > deps.clock.now().getTime();
}
