/**
 * Deps and result types for auth acts. These run before a `Principal` exists,
 * so they are not commands, but they keep the command shape.
 */
import type { Clock, Principal } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import type { WebAuthnRejection } from './webauthn.ts';

/**
 * `id` is the domain a passkey is scoped to; `origin` adds the scheme and port.
 * Neither is derived from the other, so a non-default port still signs in.
 */
export interface RelyingParty {
  readonly id: string;
  /** What the browser shows in the passkey prompt. */
  readonly name: string;
  readonly origin: string;
}

export interface AuthDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly relyingParty: RelyingParty;
}

export type AuthFailureCode =
  /** Not the token this installation shipped — or it shipped none. */
  | 'TOKEN_INVALID'
  /** This token has already claimed the installation. */
  | 'TOKEN_SPENT'
  /** Never issued, already spent, or expired: start the ceremony again. */
  | 'CHALLENGE_UNKNOWN'
  /** Carries a {@link WebAuthnRejection}. */
  | 'CEREMONY_REFUSED'
  /** Not enrolled here, or not enrolled for this operator. */
  | 'CREDENTIAL_UNKNOWN'
  /** Signing in to an installation nobody has enrolled against yet. */
  | 'NOT_ENROLLED'
  /** Linking was requested without an assertion from the trusted Gateway. */
  | 'GATEWAY_ASSERTION_MISSING'
  /** The passkey being removed is the account's final root credential. */
  | 'LAST_PASSKEY'
  | 'CREDENTIAL_ALREADY_ENROLLED';

/**
 * `forbidden`: a trusted Gateway asserted an identity the operator has not
 * linked, so the UI can explain that instead of starting a passkey flow.
 */
export type RequestAuthentication =
  | { readonly kind: 'authenticated'; readonly principal: Principal }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'forbidden'; readonly message: string };

export interface AuthFailure {
  readonly code: AuthFailureCode;
  /** The sentence the operator reads. */
  readonly message: string;
  /** Present only on `CEREMONY_REFUSED`. */
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
