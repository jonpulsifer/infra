/**
 * Enrolment — how an installation gets its operator (§"First run and identity").
 *
 * > 1. My first visit enrols a passkey against a token that shipped with the
 * >    installation, so I get a fully privileged account without standing up an
 * >    IdP first.
 * > 2. The enrolment token is **consumed on use**, so the window in which anyone
 * >    else could claim my installation closes the moment I finish.
 * > 4. Recovery means **rotating the token and replacing every passkey**, so
 * >    losing a device does not lose the installation.
 *
 * Those three are one mechanism, which is the thing worth understanding about
 * this file. There is one row per token ever spent (`enrolments`), and the
 * unique index on its hash is what makes story 2 true — not a check somebody
 * remembered to write, but a constraint the database enforces under
 * concurrency. Story 4 then costs nothing extra: a token whose hash is *not*
 * already in that table is by definition a rotated one, so consuming it clears
 * the credentials and sessions that came before it. **Editing the Secret is the
 * whole recovery procedure**, with no second act to remember and no reset
 * endpoint to protect.
 *
 * The token itself is never stored, only hashed — Spindrift never owned it. It
 * arrives in the installation Secret and is read from the environment
 * (`SPINDRIFT_ENROLMENT_TOKEN`), which is deliberately **not** the installation
 * manifest: the manifest describes an installation and is the document §20 asks
 * an operator to write by hand and hand around, while this is a credential that
 * claims one.
 */
import { eq } from 'drizzle-orm';
import { credentials, enrolments, sessions, users } from '../db/schema.ts';
import { equalText } from './bytes.ts';
import { issueChallenge, spendChallenge } from './challenge.ts';
import {
  hashToken,
  type OpenedSession,
  openSession,
  readChallenge,
} from './session.ts';
import { type AuthDeps, type AuthResult, authFailed, authOk } from './types.ts';
import { SUPPORTED_ALGORITHMS, verifyRegistration } from './webauthn.ts';

/** The display name a first operator gets. There is no field to type one into. */
const OPERATOR_NAME = 'Operator';

export interface EnrolmentDeps extends AuthDeps {
  /**
   * The token this installation shipped with, or `null` if it shipped none.
   *
   * `null` is a legitimate state and it makes enrolment impossible, which is
   * the correct posture: an installation whose Secret is missing the key cannot
   * be claimed by anybody, and the alternative — enrolment open to whoever
   * arrives first — is not a state worth being able to reach by omission.
   */
  readonly enrolmentToken: string | null;
}

/** What the browser needs to run `navigator.credentials.create()`. */
export interface EnrolmentChallenge {
  readonly challenge: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  /** The COSE algorithms to offer — exactly the ones sign-in can verify. */
  readonly algorithms: readonly number[];
  /**
   * `required`, so the credential is discoverable and sign-in needs no
   * username. v1 has one operator and nowhere to type one.
   */
  readonly residentKey: 'required';
}

/**
 * Whether a presented token is the shipped one, and whether it is still unspent.
 *
 * Both halves are checked at `begin` as a courtesy and again at `complete`
 * where it counts. The comparison is length-safe rather than a plain `===`
 * because the token is a bearer secret and an early-exit compare is a timing
 * oracle over its prefix.
 */
async function checkToken(
  deps: EnrolmentDeps,
  presented: string,
): Promise<{ ok: true; hash: string } | AuthResult<never>> {
  const shipped = deps.enrolmentToken;
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
 * Begin an enrolment.
 *
 * Refusing here rather than issuing a challenge to anyone who asks means a
 * wrong token fails at the first press instead of after a passkey prompt the
 * operator then has to be told was pointless. It is not the security boundary —
 * {@link completeEnrolment} re-checks next to the write — it is the one that
 * makes the wrong token a readable answer.
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

/** What a browser posts back from `navigator.credentials.create()`. */
export interface EnrolmentResponse {
  readonly token: string;
  readonly credentialId: string;
  /** SPKI from `getPublicKey()`, base64url — see `webauthn.ts` on why. */
  readonly publicKey: string;
  readonly algorithm: number;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

/**
 * Complete an enrolment: verify the ceremony, spend the token, open a session.
 *
 * The order is the design. The **challenge is spent first**, so a captured
 * ceremony is dead before anything else is read; the **token is re-checked**
 * next, so a challenge held from before somebody else's enrolment cannot be
 * cashed afterwards; and the writes then happen in **one transaction**, so an
 * installation is never left with the token marked spent and no passkey behind
 * it — which would be an installation nobody could ever claim.
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
    // A browser that ignored the offered list would otherwise leave a
    // credential enrolled that no sign-in could ever verify.
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey uses an algorithm this installation cannot verify',
      'UNSUPPORTED_ALGORITHM',
    );
  }

  const now = deps.clock.now();

  const user = await deps.db.transaction(async (tx) => {
    // §"First run" story 4, and the reason it needs no separate reset path: a
    // token that has not been spent before is a *rotated* token, so every
    // passkey and every session that preceded it goes. Cascades from `users`
    // would do the same thing by deleting the account, but the account is the
    // thing recovery is supposed to give back — v1 has one operator, and
    // accumulating one per rotation would be the wrong answer.
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

    // Last, and inside the transaction: the unique index on `token_hash` is
    // what makes "consumed on use" a fact under concurrency rather than a
    // check. Two enrolments racing the same token both reach here and exactly
    // one commits.
    await tx.insert(enrolments).values({
      tokenHash: token.hash,
      userId: operator.id,
      consumedAt: now,
    });

    return operator;
  });

  return authOk(await openSession(deps, user));
}
