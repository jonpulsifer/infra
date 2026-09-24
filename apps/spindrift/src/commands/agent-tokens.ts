/**
 * Agent tokens: the credential an MCP client presents at `/mcp`. Only a human
 * principal may mint one, so a passkey sign-in precedes every token. The token
 * is shown once; the session row stores only its SHA-256.
 *
 * ponytail: no label column, so tokens are told apart by their mint date. Add
 * one when an operator has enough of them to care which machine is which.
 */
import { z } from 'zod';
// Aliased: a command's export name must equal its registry name.
import {
  listAgentTokens as agentTokenRows,
  openAgentToken,
  revokeAgentToken as revokeAgentTokenRow,
} from '../auth/session.ts';
import { type Command, failed, ok } from './types.ts';

export const mintAgentTokenInput = z.object({});
export type MintAgentTokenInput = z.infer<typeof mintAgentTokenInput>;

export interface MintedAgentToken {
  /** The bearer value, returned only by this call. */
  readonly token: string;
  readonly expiresAt: string;
}

export const mintAgentToken: Command<
  MintAgentTokenInput,
  MintedAgentToken
> = async (_input, context) => {
  if (context.principal.kind !== 'human') {
    return failed(
      'FORBIDDEN',
      'an agent token cannot mint another — sign in and mint one from Settings',
    );
  }
  const minted = await openAgentToken(context, context.principal);
  return ok({
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
  });
};

export const listAgentTokensInput = z.object({});
export type ListAgentTokensInput = z.infer<typeof listAgentTokensInput>;

/** No token material, because none is stored. */
export interface AgentTokenListItem {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  /**
   * The last use at `/mcp`; all three are `null` for an unused token. The IP
   * and agent come from the caller's own headers, so they are unverified.
   */
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string | null;
  readonly lastUsedAgent: string | null;
}

export const listAgentTokens: Command<
  ListAgentTokensInput,
  { tokens: readonly AgentTokenListItem[] }
> = async (_input, context) => {
  const now = context.clock.now();
  const rows = await agentTokenRows(context, context.principal.id);
  return ok({
    tokens: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt <= now,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: row.lastUsedIp,
      lastUsedAgent: row.lastUsedAgent,
    })),
  });
};

export const revokeAgentTokenInput = z.object({
  id: z.uuid('an agent token is revoked by its id'),
});
export type RevokeAgentTokenInput = z.infer<typeof revokeAgentTokenInput>;

export const revokeAgentToken: Command<
  RevokeAgentTokenInput,
  Record<string, never>
> = async (input, context) => {
  const revoked = await revokeAgentTokenRow(
    context,
    context.principal.id,
    input.id,
  );
  return revoked
    ? ok({})
    : failed('NOT_FOUND', 'no agent token of yours has that id');
};
