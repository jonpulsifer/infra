/**
 * Authentication through an optional trusted front-door Gateway.
 *
 * The adapter begins at normalized request headers. Provider OAuth/OIDC, token
 * validation, and claim mapping belong to the Gateway; Spindrift's trust
 * boundary is the non-bypassable hop from that Gateway to this process. A
 * header is never enough to create a User: it must match an identity an
 * already-authenticated operator explicitly linked.
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

/**
 * Stable storage key for one adapter/issuer/subject tuple.
 *
 * JSON encoding is unambiguous even when one field contains punctuation, and
 * keeps provider display claims out of the identity key.
 */
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
 * Resolve the request to the one stable Spindrift User.
 *
 * A local session wins so an operator arriving through a newly configured
 * Gateway can still reach Settings and link its assertion. Once no local
 * session exists, an asserted-but-unlinked identity is forbidden rather than
 * silently ignored or provisioned.
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
        principal: { id: user.id, displayName: user.displayName },
      };
}

export type SessionState = {
  readonly principal: Principal | null;
  readonly claimed: boolean;
  /**
   * The Gateway asserted an identity that still needs linking. This bootstrap
   * read remains available so the operator can sign in with the root passkey
   * and reach Settings; protected requests still receive 403.
   */
  readonly gatewayUnlinked: boolean;
};

/**
 * Compose the two reads needed by the browser shell below the HTTP route.
 *
 * Keeping this here leaves `auth/routes.ts` with transport only: it chooses
 * GET, calls one operation, and serializes the result.
 */
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

/**
 * Read the stable identity asserted on this request.
 *
 * This only parses the trusted adapter boundary; it does not mutate a User.
 * `credential-admin.ts` is the sole linking path and calls this only after a
 * fresh passkey assertion.
 */
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
