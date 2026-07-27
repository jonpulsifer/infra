/**
 * The browser half of enrolment and sign-in (Task 37).
 *
 * `client.ts` is the typed wrapper for commands so that no view hand-writes a
 * `fetch`; this is the same rule for the one surface that is not a command, and
 * it carries a second job on top of it: **it is the only place
 * `navigator.credentials` is called.** That matters more than the fetch
 * wrapping does, because the WebAuthn API is where the codebase's one real
 * simplification lives, and it lives on this side of the wire.
 *
 * `src/auth/webauthn.ts` has no CBOR decoder, which is only possible because
 * the browser is asked for the two things it can already parse:
 *
 * - `getPublicKey()` — the credential's key as SPKI, which is what
 *   `crypto.subtle.importKey` takes.
 * - `getAuthenticatorData()` — the authenticator data on its own, rather than
 *   wrapped in the CBOR `attestationObject`.
 *
 * Both are standard `AuthenticatorAttestationResponse` methods and both are
 * assumed present rather than felt for: an authenticator old enough to lack
 * them is one this installation would rather refuse than half-support.
 */
import { AUTH_PATH_PREFIX, type AuthAct } from '../auth/routes.ts';
import type { AuthFailure } from '../auth/types.ts';
import type { Principal } from '../commands/types.ts';

export type AuthClientResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: AuthFailure };

/**
 * Base64url over an `ArrayBuffer`, matching what the server decodes.
 *
 * Written here rather than imported from `src/auth/webauthn.ts` because that
 * module's helper takes a `Uint8Array` the server side already has, and the
 * browser has buffers — one conversion in one direction each, rather than a
 * shared helper that has to take both.
 */
function encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function callAuth<Value>(
  act: AuthAct,
  init: RequestInit,
): Promise<AuthClientResult<Value>> {
  const response = await fetch(`${AUTH_PATH_PREFIX}/${act}`, {
    // Same as `client.ts`: the session is a cookie, and `same-origin` is stated
    // rather than left to the default so nobody later widens it to `include`.
    credentials: 'same-origin',
    ...init,
  });

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object' || !('ok' in body)) {
    throw new Error(`${act} answered ${response.status} with no auth result`);
  }
  return body as AuthClientResult<Value>;
}

function postAuth<Value>(
  act: AuthAct,
  input: unknown,
): Promise<AuthClientResult<Value>> {
  return callAuth(act, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** What the shell needs before it can render anything. */
export interface SessionState {
  readonly principal: Principal | null;
  /** Whether anybody has enrolled here — which of the front door's two states. */
  readonly claimed: boolean;
}

/** Who the browser is, and whether this installation has been claimed. */
export async function readSession(): Promise<SessionState> {
  const result = await callAuth<SessionState>('session', { method: 'GET' });
  return result.ok ? result.value : { principal: null, claimed: false };
}

/** Raised when the operator dismisses the passkey prompt, or has no key. */
export class CeremonyAbandonedError extends Error {
  override readonly name = 'CeremonyAbandonedError';
}

/** Enrol a passkey against the token from the installation Secret. */
export async function enrol(
  token: string,
): Promise<AuthClientResult<{ principal: Principal }>> {
  const begun = await postAuth<{
    challenge: string;
    rpId: string;
    rpName: string;
    userName: string;
    algorithms: number[];
  }>('enrol/begin', { token });
  if (!begun.ok) return begun;

  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: decode(begun.value.challenge),
      rp: { id: begun.value.rpId, name: begun.value.rpName },
      user: {
        // The user handle is a random opaque value: it is stored *by the
        // authenticator*, and putting anything derived from the installation in
        // it would leak that name to every device the passkey syncs to.
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: begun.value.userName,
        displayName: begun.value.userName,
      },
      pubKeyCredParams: begun.value.algorithms.map((alg) => ({
        type: 'public-key' as const,
        alg,
      })),
      authenticatorSelection: {
        // Discoverable, so sign-in needs no username — v1 has one operator and
        // nowhere to type one.
        residentKey: 'required',
        userVerification: 'preferred',
      },
      // Not requested, and not read if it arrives: `src/auth/webauthn.ts`
      // carries why attestation proves nothing the enrolment token has not.
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;

  if (created === null) {
    throw new CeremonyAbandonedError('no passkey was created');
  }

  const response = created.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (publicKey === null) {
    throw new CeremonyAbandonedError(
      'that authenticator did not hand over a public key this browser could read',
    );
  }

  return postAuth('enrol/complete', {
    token,
    credentialId: created.id,
    publicKey: encode(publicKey),
    algorithm: response.getPublicKeyAlgorithm(),
    authenticatorData: encode(response.getAuthenticatorData()),
    clientDataJSON: encode(response.clientDataJSON),
  });
}

/** Sign in with a passkey already enrolled here. */
export async function signIn(): Promise<
  AuthClientResult<{ principal: Principal }>
> {
  const begun = await postAuth<{ challenge: string; rpId: string }>(
    'signin/begin',
    {},
  );
  if (!begun.ok) return begun;

  const asserted = (await navigator.credentials.get({
    publicKey: {
      challenge: decode(begun.value.challenge),
      rpId: begun.value.rpId,
      // No `allowCredentials`: the credential is discoverable, so the browser
      // finds it. A list here would need a credential id the operator has no
      // way to supply before signing in.
      userVerification: 'preferred',
    },
  })) as PublicKeyCredential | null;

  if (asserted === null) {
    throw new CeremonyAbandonedError('no passkey was offered');
  }

  const response = asserted.response as AuthenticatorAssertionResponse;
  return postAuth('signin/complete', {
    credentialId: asserted.id,
    authenticatorData: encode(response.authenticatorData),
    clientDataJSON: encode(response.clientDataJSON),
    signature: encode(response.signature),
  });
}

/** End the session, on the server as well as in the browser. */
export async function signOut(): Promise<void> {
  await postAuth('signout', {});
}
