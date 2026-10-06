/**
 * The browser side of enrolment and sign-in, and the only caller of
 * `navigator.credentials`. It sends the SPKI key and bare authenticator data,
 * so the server needs no CBOR decoder.
 */

import { base64urlDecode, base64urlEncode } from '@repo/archive/bytes';
import type {
  AddPasskeyChallenge,
  CredentialSettings,
} from '../auth/credential-admin.ts';
import type { AuthFailure } from '../auth/types.ts';
import type { Principal } from '../commands/types.ts';
import { AUTH_PATH_PREFIX, type AuthAct } from './auth-path.ts';

export type AuthClientResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: AuthFailure };

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
    // The session is a cookie. Stated so nobody widens it to `include`.
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

export interface SessionState {
  readonly principal: Principal | null;
  /** Whether anybody has enrolled here. */
  readonly claimed: boolean;
  /** Whether passkey sign-in is needed before this Gateway can be linked. */
  readonly gatewayUnlinked: boolean;
}

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

export async function signOut(): Promise<void> {
  await postAuth('signout', {});
}

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

/** The server refuses to remove the last account root. */
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

export async function unlinkGateway(): Promise<AuthClientResult<unknown>> {
  const fresh = await freshAssertion();
  return fresh.ok ? postAuth('gateway/unlink', fresh.value) : fresh;
}
