/**
 * Agent tokens: the credential an MCP client presents at `/mcp`.
 *
 * These are commands rather than auth routes, which is the opposite of where
 * `src/auth/` puts everything else, and the reason is the one distinction that
 * matters here: the acts in `src/auth/` are *pre-session* — they exist to
 * produce a principal, so they cannot ride a surface that requires one. These
 * three are the other way round. Minting an agent token is something an
 * already-signed-in operator does, so it belongs on the session-authenticated
 * command surface, and putting it there is what guarantees a passkey assertion
 * sits upstream of every token that exists.
 *
 * The token is returned exactly once, by {@link mintAgentToken}, and never
 * again by anything: `sessions.token_hash` is a SHA-256 and there is nothing to
 * read back. {@link listAgentTokens} answers with ids, dates and last use,
 * which is what {@link revokeAgentToken} needs an operator to be able to
 * decide on: a mint date alone cannot tell the machine in front of you from
 * the one you set up months ago and forgot.
 *
 * The session-layer functions are imported under different local names: a
 * command's exported identifier must equal the name it is registered under
 * (`test/commands/registry.test.ts`), so the command owns the plain name here
 * and the row-level helper is aliased.
 *
 * ponytail: no label column, so tokens are told apart by their mint date. Add
 * one when an operator has enough of them to care which machine is which.
 */
import { z } from 'zod';
import {
  listAgentTokens as agentTokenRows,
  openAgentToken,
  revokeAgentToken as revokeAgentTokenRow,
} from '../auth/session.ts';
import { type Command, failed, ok } from './types.ts';

export const mintAgentTokenInput = z.object({});
export type MintAgentTokenInput = z.infer<typeof mintAgentTokenInput>;

/** What a mint answers with: the value, once. */
export interface MintedAgentToken {
  /** The bearer value. Shown to the operator now or never. */
  readonly token: string;
  readonly expiresAt: string;
}

export const mintAgentToken: Command<
  MintAgentTokenInput,
  MintedAgentToken
> = async (_input, context) => {
  const minted = await openAgentToken(context, context.principal);
  return ok({
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
  });
};

export const listAgentTokensInput = z.object({});
export type ListAgentTokensInput = z.infer<typeof listAgentTokensInput>;

/** One token as a list prints it. No token material, because none is stored. */
export interface AgentTokenListItem {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Whether it is past its expiry — a dead row is still a row to clean up. */
  readonly expired: boolean;
  /**
   * When this token was last presented at `/mcp`, and what presented it.
   *
   * `null` throughout for a token nobody has used, which is one answer and not
   * three: a row with no last use has no address and no agent either, and
   * spelling that as three separate absences would ask the screen to
   * distinguish them.
   *
   * The address and the agent are the caller's own headers — they say which
   * machine, and they are not evidence. The screen renders them as such.
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
