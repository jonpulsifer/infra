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

import { base64urlDecode, base64urlEncode } from '../auth/bytes.ts';
import type {
  AddPasskeyChallenge,
  CredentialSettings,
} from '../auth/credential-admin.ts';
import { AUTH_PATH_PREFIX, type AuthAct } from '../auth/routes.ts';
import type { AuthFailure } from '../auth/types.ts';
import type { Principal } from '../commands/types.ts';

export type AuthClientResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: AuthFailure };

/** Decode a server challenge, which is always valid base64url on this boundary. */
function decode(value: string): Uint8Array<ArrayBuffer> {
  const bytes = base64urlDecode(value);
  if (bytes === null) {
    throw new Error('the server returned a malformed WebAuthn challenge');
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
  /** Whether passkey sign-in is needed before this Gateway can be linked. */
  readonly gatewayUnlinked: boolean;
}

/** Who the browser is, and whether this installation has been claimed. */
export async function readSession(): Promise<SessionState> {
  const result = await callAuth<SessionState>('session', { method: 'GET' });
  return result.ok
    ? result.value
    : { principal: null, claimed: false, gatewayUnlinked: false };
}

/** Raised when the operator dismisses the passkey prompt, or has no key. */
export class CeremonyAbandonedError extends Error {
  override readonly name = 'CeremonyAbandonedError';
}

interface RegistrationFields {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

interface AssertionFields {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

async function createPasskey(
  options: AddPasskeyChallenge,
): Promise<RegistrationFields> {
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: decode(options.challenge),
      rp: { id: options.rpId, name: options.rpName },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: options.userName,
        displayName: options.userName,
      },
      pubKeyCredParams: options.algorithms.map((alg) => ({
        type: 'public-key' as const,
        alg,
      })),
      authenticatorSelection: {
        residentKey: options.residentKey,
        userVerification: 'required',
      },
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
  return {
    credentialId: created.id,
    publicKey: base64urlEncode(publicKey),
    algorithm: response.getPublicKeyAlgorithm(),
    authenticatorData: base64urlEncode(response.getAuthenticatorData()),
    clientDataJSON: base64urlEncode(response.clientDataJSON),
  };
}

async function assertPasskey(
  challenge: string,
  rpId: string,
): Promise<AssertionFields> {
  const asserted = (await navigator.credentials.get({
    publicKey: {
      challenge: decode(challenge),
      rpId,
      userVerification: 'required',
    },
  })) as PublicKeyCredential | null;

  if (asserted === null) {
    throw new CeremonyAbandonedError('no passkey was offered');
  }

  const response = asserted.response as AuthenticatorAssertionResponse;
  return {
    credentialId: asserted.id,
    authenticatorData: base64urlEncode(response.authenticatorData),
    clientDataJSON: base64urlEncode(response.clientDataJSON),
    signature: base64urlEncode(response.signature),
  };
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

  return postAuth('enrol/complete', {
    token,
    ...(await createPasskey({
      ...begun.value,
      residentKey: 'required',
    })),
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

  return postAuth(
    'signin/complete',
    await assertPasskey(begun.value.challenge, begun.value.rpId),
  );
}

/** End the session, on the server as well as in the browser. */
export async function signOut(): Promise<void> {
  await postAuth('signout', {});
}

/** Read the current operator's authentication methods. */
export async function readCredentialSettings(): Promise<CredentialSettings> {
  const result = await callAuth<CredentialSettings>('credentials', {
    method: 'GET',
  });
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

async function freshAssertion(): Promise<AuthClientResult<AssertionFields>> {
  const begun = await postAuth<{ challenge: string; rpId: string }>(
    'credentials/verify/begin',
    {},
  );
  return begun.ok
    ? {
        ok: true,
        value: await assertPasskey(begun.value.challenge, begun.value.rpId),
      }
    : begun;
}

/** Add an additional passkey without replacing the existing account roots. */
export async function addPasskey(): Promise<AuthClientResult<unknown>> {
  const fresh = await freshAssertion();
  if (!fresh.ok) return fresh;
  const begun = await postAuth<AddPasskeyChallenge>(
    'passkeys/add/begin',
    fresh.value,
  );
  if (!begun.ok) return begun;
  return postAuth('passkeys/add/complete', await createPasskey(begun.value));
}

/** Remove one passkey. The server refuses the final account root. */
export async function removePasskey(
  credentialId: string,
): Promise<AuthClientResult<unknown>> {
  const fresh = await freshAssertion();
  return fresh.ok
    ? postAuth('passkeys/remove', {
        credentialId,
        assertion: fresh.value,
      })
    : fresh;
}

/** Link the identity asserted by the trusted Gateway on this request. */
export async function linkGateway(): Promise<AuthClientResult<unknown>> {
  const fresh = await freshAssertion();
  return fresh.ok ? postAuth('gateway/link', fresh.value) : fresh;
}

/** Remove the linked Gateway identity while retaining passkey access. */
export async function unlinkGateway(): Promise<AuthClientResult<unknown>> {
  const fresh = await freshAssertion();
  return fresh.ok ? postAuth('gateway/unlink', fresh.value) : fresh;
}
