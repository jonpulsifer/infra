/**
 * Authentication through an optional trusted Gateway's identity header. The
 * header never creates a User; it must match an identity the operator linked.
 */
import { eq } from 'drizzle-orm';
import type { Principal } from '../commands/types.ts';
import type { GatewayAuthConfig } from '../config/manifest.ts';
import { users } from '../db/schema.ts';
import { isClaimed, resolveSession } from './session.ts';
import {
  type AuthDeps,
  type AuthResult,
  authFailed,
  authOk,
  type RequestAuthentication,
} from './types.ts';

export interface GatewayDeps extends AuthDeps {
  readonly gateway: GatewayAuthConfig | null;
}

/** JSON-encoded so punctuation in a field cannot make two tuples collide. */
export function gatewayIdentityKey(
  config: GatewayAuthConfig,
  subject: string,
): string {
  return JSON.stringify([config.adapterKey, config.issuer, subject]);
}

function gatewaySubject(
  request: Request,
  gateway: GatewayAuthConfig,
): string | null {
  return request.headers.get(gateway.subjectHeader)?.trim() || null;
}

/**
 * A local session wins, so an operator behind a newly configured Gateway can
 * still reach Settings to link it. An unlinked asserted identity is forbidden.
 */
export async function authenticateRequest(
  request: Request,
  deps: GatewayDeps,
): Promise<RequestAuthentication> {
  const session = await resolveSession(request, deps);
  if (session !== null) {
    return { kind: 'authenticated', principal: session };
  }

  if (deps.gateway === null) return { kind: 'anonymous' };
  const subject = gatewaySubject(request, deps.gateway);
  if (subject === null) return { kind: 'anonymous' };

  const [user] = await deps.db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(
      eq(users.gatewayIdentity, gatewayIdentityKey(deps.gateway, subject)),
    );

  return user === undefined
    ? {
        kind: 'forbidden',
        message:
          'that Gateway identity is not linked to the operator on this installation',
      }
    : {
        kind: 'authenticated',
        principal: {
          id: user.id,
          displayName: user.displayName,
          kind: 'human',
        },
      };
}

export type SessionState = {
  readonly principal: Principal | null;
  readonly claimed: boolean;
  /** The Gateway asserted an unlinked identity; protected requests get 403. */
  readonly gatewayUnlinked: boolean;
};

export async function readSessionState(
  request: Request,
  deps: GatewayDeps,
): Promise<SessionState> {
  const authentication = await authenticateRequest(request, deps);

  return {
    principal:
      authentication.kind === 'authenticated' ? authentication.principal : null,
    claimed: await isClaimed(deps),
    gatewayUnlinked: authentication.kind === 'forbidden',
  };
}

/** Call only after a fresh passkey assertion, as `linkGatewayIdentity` does. */
export function assertedGatewayIdentity(
  deps: GatewayDeps,
  request: Request,
): AuthResult<string> {
  const subject =
    deps.gateway === null ? null : gatewaySubject(request, deps.gateway);
  if (deps.gateway === null || subject === null) {
    return authFailed(
      'GATEWAY_ASSERTION_MISSING',
      'the trusted Gateway did not supply an identity to link on this request',
    );
  }

  return authOk(gatewayIdentityKey(deps.gateway, subject));
}
