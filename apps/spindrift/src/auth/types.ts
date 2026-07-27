/**
 * What enrolment and sign-in share (Task 37).
 *
 * **Nothing here is a `Command`, and that is a decision rather than an
 * oversight.** A {@link CommandContext} carries a `Principal`
 * (`src/commands/types.ts`), and these are the acts that *produce* one — a
 * pre-session act cannot ride a surface §21 makes session-authenticated only.
 * So auth gets its own deps object and its own routes, and it is the only thing
 * in this application that does.
 *
 * The shape is deliberately the command layer's shape anyway: an explicit input,
 * an explicit deps object, a typed result, and a **closed** failure code. That
 * is what keeps the seam the same to test against — § Testing's "a failure test
 * asserts the sentence the user reads" needs the failure to have an identity,
 * and it needs it here more than anywhere, because a refusal here is the only
 * thing standing between a stranger and the installation.
 */
import type { Clock } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import type { WebAuthnRejection } from './webauthn.ts';

/**
 * The relying party a ceremony is performed for.
 *
 * `id` is the domain a passkey is scoped to and `origin` is what the browser
 * puts in `clientDataJSON`; they are carried separately because they are
 * genuinely two facts — the origin has a scheme and a port and the relying
 * party id has neither, and deriving one from the other is how an installation
 * behind a non-default port stops being able to sign in.
 */
export interface RelyingParty {
  readonly id: string;
  /** What the browser shows in the passkey prompt. */
  readonly name: string;
  readonly origin: string;
}

/** Everything an auth act may reach. The mirror of `CommandContext`. */
export interface AuthDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly relyingParty: RelyingParty;
}

/**
 * Why an auth act refused.
 *
 * Split finer than a single "no" because these are read by different people:
 * `TOKEN_SPENT` tells an operator their installation is already claimed,
 * `CHALLENGE_UNKNOWN` tells them to press the button again, and
 * `CEREMONY_REFUSED` is the one that carries a
 * {@link WebAuthnRejection} worth putting in a log.
 */
export type AuthFailureCode =
  /** Not the token this installation shipped — or it shipped none. */
  | 'TOKEN_INVALID'
  /** §"First run" story 2: this token has already claimed the installation. */
  | 'TOKEN_SPENT'
  /** Never issued, already spent, or expired. One code, because from the
   * caller's side they are one situation: start the ceremony again. */
  | 'CHALLENGE_UNKNOWN'
  /** The ceremony did not hold. Carries the reason from `webauthn.ts`. */
  | 'CEREMONY_REFUSED'
  /** An assertion for a credential this installation has never seen. */
  | 'CREDENTIAL_UNKNOWN'
  /** Signing in to an installation nobody has enrolled against yet. */
  | 'NOT_ENROLLED';

export interface AuthFailure {
  readonly code: AuthFailureCode;
  /** The sentence the operator reads. */
  readonly message: string;
  /** Present only on `CEREMONY_REFUSED`, where there is more to say. */
  readonly rejection?: WebAuthnRejection;
}

export type AuthResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: AuthFailure };

export function authOk<Value>(value: Value): AuthResult<Value> {
  return { ok: true, value };
}

export function authFailed<Value>(
  code: AuthFailureCode,
  message: string,
  rejection?: WebAuthnRejection,
): AuthResult<Value> {
  return {
    ok: false,
    failure:
      rejection === undefined
        ? { code, message }
        : { code, message, rejection },
  };
}
