/**
 * First-run enrolment: a passkey enrolled against the token the installation
 * shipped with. Each token is spent once; a new token replaces every passkey.
 */

import { equalText } from '@repo/archive/bytes';
import { eq } from 'drizzle-orm';
import { credentials, enrolments, sessions, users } from '../db/schema.ts';
import { issueChallenge, spendChallenge } from './challenge.ts';
import {
  hashToken,
  type OpenedSession,
  openSession,
  readChallenge,
} from './session.ts';
import { type AuthDeps, type AuthResult, authFailed, authOk } from './types.ts';
import { SUPPORTED_ALGORITHMS, verifyRegistration } from './webauthn.ts';

/** Every operator gets this name: enrolment has no name field. */
const OPERATOR_NAME = 'Operator';

export interface EnrolmentDeps extends AuthDeps {
  /** `null` when the Secret has no token, which makes enrolment impossible. */
  readonly enrolmentToken: string | null;
}

/** What the browser needs to run `navigator.credentials.create()`. */
export interface EnrolmentChallenge {
  readonly challenge: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  /** The COSE algorithms sign-in can verify. */
  readonly algorithms: readonly number[];
  /** Discoverable, so sign-in needs no username. */
  readonly residentKey: 'required';
}

async function checkToken(
  deps: EnrolmentDeps,
  presented: string,
): Promise<{ ok: true; hash: string } | AuthResult<never>> {
  const shipped = deps.enrolmentToken;
  // Not `===`: an early-exit compare leaks the token's prefix through timing.
  if (shipped === null || shipped === '' || !equalText(shipped, presented)) {
    return authFailed(
      'TOKEN_INVALID',
      'that is not the enrolment token this installation shipped with',
    );
  }

  const hash = await hashToken(presented);
  const [spent] = await deps.db
    .select({ id: enrolments.id })
    .from(enrolments)
    .where(eq(enrolments.tokenHash, hash));

  if (spent !== undefined) {
    return authFailed(
      'TOKEN_SPENT',
      'this installation has already been claimed with that token — to recover, rotate it in the installation Secret and enrol again',
    );
  }

  return { ok: true, hash };
}

/**
 * Checks the token so a wrong one fails before the passkey prompt. The security
 * check is the one {@link completeEnrolment} repeats next to the write.
 */
export async function beginEnrolment(
  deps: EnrolmentDeps,
  input: { readonly token: string },
): Promise<AuthResult<EnrolmentChallenge>> {
  const token = await checkToken(deps, input.token);
  if (!('hash' in token)) return token;

  return authOk({
    challenge: await issueChallenge(deps, 'enrol'),
    rpId: deps.relyingParty.id,
    rpName: deps.relyingParty.name,
    userName: OPERATOR_NAME,
    algorithms: SUPPORTED_ALGORITHMS,
    residentKey: 'required',
  });
}

export interface EnrolmentResponse {
  readonly token: string;
  readonly credentialId: string;
  /** SPKI from `getPublicKey()`, base64url. */
  readonly publicKey: string;
  readonly algorithm: number;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

/**
 * Spends the challenge first, then re-checks the token, then writes in one
 * transaction so a spent token always has a passkey behind it.
 */
export async function completeEnrolment(
  deps: EnrolmentDeps,
  response: EnrolmentResponse,
): Promise<AuthResult<OpenedSession>> {
  const challenge = readChallenge(response.clientDataJSON);
  if (challenge === null || !(await spendChallenge(deps, challenge, 'enrol'))) {
    return authFailed(
      'CHALLENGE_UNKNOWN',
      'that enrolment was not one this installation had open — try again',
    );
  }

  const token = await checkToken(deps, response.token);
  if (!('hash' in token)) return token;

  const verdict = await verifyRegistration({
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    expected: {
      challenge,
      origin: deps.relyingParty.origin,
      rpId: deps.relyingParty.id,
    },
  });

  if (!verdict.ok) {
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey was not enrolled against this installation',
      verdict.rejection,
    );
  }

  if (
    !SUPPORTED_ALGORITHMS.includes(
      response.algorithm as (typeof SUPPORTED_ALGORITHMS)[number],
    )
  ) {
    // A browser can ignore the offered list; sign-in could not verify the key.
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey uses an algorithm this installation cannot verify',
      'UNSUPPORTED_ALGORITHM',
    );
  }

  const now = deps.clock.now();

  const user = await deps.db.transaction(async (tx) => {
    // An unspent token is a rotated one: recovery replaces every passkey and
    // session but keeps the one operator account.
    await tx.delete(sessions);
    await tx.delete(credentials);

    const [existing] = await tx.select().from(users).limit(1);
    const operator =
      existing ??
      (
        await tx
          .insert(users)
          .values({ displayName: OPERATOR_NAME, createdAt: now })
          .returning()
      )[0]!;

    await tx.insert(credentials).values({
      userId: operator.id,
      credentialId: response.credentialId,
      publicKey: response.publicKey,
      algorithm: response.algorithm,
      signCount: verdict.signCount,
      createdAt: now,
    });

    // Last: the unique index on `token_hash` lets exactly one of two racing
    // enrolments commit.
    await tx.insert(enrolments).values({
      tokenHash: token.hash,
      userId: operator.id,
      consumedAt: now,
    });

    return operator;
  });

  return authOk(await openSession(deps, user));
}
