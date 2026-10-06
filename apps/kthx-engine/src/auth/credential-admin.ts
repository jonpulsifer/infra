/**
 * Credential administration. A session alone cannot change how a User signs in:
 * every change spends a fresh User-bound passkey assertion.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Principal } from '../commands/types.ts';
import { credentials, users } from '../db/schema.ts';
import { issueChallenge, spendChallenge } from './challenge.ts';
import { assertedGatewayIdentity, type GatewayDeps } from './gateway.ts';
import {
  readChallenge,
  type SignInResponse,
  verifyPasskeyAssertion,
} from './session.ts';
import { type AuthResult, authFailed, authOk } from './types.ts';
import { SUPPORTED_ALGORITHMS, verifyRegistration } from './webauthn.ts';

export type CredentialAdminDeps = GatewayDeps;

export interface CredentialChangeChallenge {
  readonly challenge: string;
  readonly rpId: string;
}

export interface AddPasskeyChallenge {
  readonly challenge: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  readonly algorithms: readonly number[];
  readonly residentKey: 'required';
}

export interface AddPasskeyResponse {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

export interface CredentialSummary {
  readonly credentialId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface CredentialSettings {
  readonly passkeys: readonly CredentialSummary[];
  readonly gatewayLinked: boolean;
  readonly gatewayAvailable: boolean;
}

export async function credentialSettings(
  deps: CredentialAdminDeps,
  principal: Principal,
): Promise<CredentialSettings> {
  const passkeys = await deps.db
    .select({
      credentialId: credentials.credentialId,
      createdAt: credentials.createdAt,
      lastUsedAt: credentials.lastUsedAt,
    })
    .from(credentials)
    .where(eq(credentials.userId, principal.id));
  const [user] = await deps.db
    .select({ gatewayIdentity: users.gatewayIdentity })
    .from(users)
    .where(eq(users.id, principal.id));

  return {
    passkeys: passkeys.map((passkey) => ({
      credentialId: passkey.credentialId,
      createdAt: passkey.createdAt.toISOString(),
      lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    })),
    gatewayLinked: user?.gatewayIdentity !== null && user !== undefined,
    gatewayAvailable: deps.gateway !== null,
  };
}

export async function beginCredentialChange(
  deps: CredentialAdminDeps,
  principal: Principal,
): Promise<CredentialChangeChallenge> {
  return {
    challenge: await issueChallenge(deps, 'credential_admin', principal.id),
    rpId: deps.relyingParty.id,
  };
}

async function authorizeChange(
  deps: CredentialAdminDeps,
  principal: Principal,
  assertion: SignInResponse,
): Promise<AuthResult<Principal>> {
  return verifyPasskeyAssertion(deps, assertion, {
    purpose: 'credential_admin',
    userId: principal.id,
    unknownChallengeMessage:
      'that credential change was not one this installation had open — try again',
  });
}

export async function beginAddPasskey(
  deps: CredentialAdminDeps,
  principal: Principal,
  assertion: SignInResponse,
): Promise<AuthResult<AddPasskeyChallenge>> {
  const authorized = await authorizeChange(deps, principal, assertion);
  if (!authorized.ok) return authorized;

  return authOk({
    challenge: await issueChallenge(deps, 'add_passkey', principal.id),
    rpId: deps.relyingParty.id,
    rpName: deps.relyingParty.name,
    userName: principal.displayName,
    algorithms: SUPPORTED_ALGORITHMS,
    residentKey: 'required',
  });
}

export async function completeAddPasskey(
  deps: CredentialAdminDeps,
  principal: Principal,
  response: AddPasskeyResponse,
): Promise<AuthResult<CredentialSummary>> {
  const challenge = readChallenge(response.clientDataJSON);
  if (
    challenge === null ||
    !(await spendChallenge(deps, challenge, 'add_passkey', principal.id))
  ) {
    return authFailed(
      'CHALLENGE_UNKNOWN',
      'that passkey addition was not one this installation had open — try again',
    );
  }

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
    return authFailed(
      'CEREMONY_REFUSED',
      'that passkey uses an algorithm this installation cannot verify',
      'UNSUPPORTED_ALGORITHM',
    );
  }

  const [existing] = await deps.db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.credentialId, response.credentialId));
  if (existing !== undefined) {
    return authFailed(
      'CREDENTIAL_ALREADY_ENROLLED',
      'that passkey is already enrolled on this installation',
    );
  }

  const now = deps.clock.now();
  await deps.db.insert(credentials).values({
    userId: principal.id,
    credentialId: response.credentialId,
    publicKey: response.publicKey,
    algorithm: response.algorithm,
    signCount: verdict.signCount,
    createdAt: now,
  });
  return authOk({
    credentialId: response.credentialId,
    createdAt: now.toISOString(),
    lastUsedAt: null,
  });
}

export async function removePasskey(
  deps: CredentialAdminDeps,
  principal: Principal,
  input: {
    readonly credentialId: string;
    readonly assertion: SignInResponse;
  },
): Promise<AuthResult<null>> {
  const authorized = await authorizeChange(deps, principal, input.assertion);
  if (!authorized.ok) return authorized;

  return deps.db.transaction(async (tx) => {
    // Locks the User row so two removals cannot both see two passkeys.
    await tx.execute(
      sql`select id from ${users} where ${users.id} = ${principal.id} for update`,
    );
    const owned = await tx
      .select({ credentialId: credentials.credentialId })
      .from(credentials)
      .where(eq(credentials.userId, principal.id));
    if (!owned.some((item) => item.credentialId === input.credentialId)) {
      return authFailed(
        'CREDENTIAL_UNKNOWN',
        'that passkey is not enrolled for this operator',
      );
    }
    if (owned.length === 1) {
      return authFailed(
        'LAST_PASSKEY',
        'the final passkey is the account root and cannot be removed',
      );
    }

    await tx
      .delete(credentials)
      .where(
        and(
          eq(credentials.userId, principal.id),
          eq(credentials.credentialId, input.credentialId),
        ),
      );
    return authOk(null);
  });
}

export async function linkGatewayIdentity(
  deps: CredentialAdminDeps,
  principal: Principal,
  request: Request,
  assertion: SignInResponse,
): Promise<AuthResult<Principal>> {
  const authorized = await authorizeChange(deps, principal, assertion);
  if (!authorized.ok) return authorized;
  const identity = assertedGatewayIdentity(deps, request);
  if (!identity.ok) return identity;

  await deps.db
    .update(users)
    .set({ gatewayIdentity: identity.value })
    .where(eq(users.id, principal.id));
  return authOk(principal);
}

export async function unlinkGatewayIdentity(
  deps: CredentialAdminDeps,
  principal: Principal,
  assertion: SignInResponse,
): Promise<AuthResult<Principal>> {
  const authorized = await authorizeChange(deps, principal, assertion);
  if (!authorized.ok) return authorized;

  await deps.db
    .update(users)
    .set({ gatewayIdentity: null })
    .where(eq(users.id, principal.id));
  return authOk(principal);
}
