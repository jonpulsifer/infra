/**
 * Agent tokens: the credential that is not a passkey and not a cookie.
 *
 * It sits under Identity because that is what it is — a way in, belonging to
 * this operator — and beside the passkey card rather than inside it because the
 * two are minted by different means. A passkey change needs a fresh ceremony;
 * this needs only the session the operator already has, and pretending
 * otherwise would put a `navigator.credentials` prompt in front of an act that
 * does not need one.
 *
 * **The token is shown once.** `sessions.token_hash` is a SHA-256 and there is
 * nothing to read back, so the value lives in this component's state and dies
 * with it. That makes the reveal the one part of this screen with a real design
 * problem: a value that cannot be recovered has to be obviously
 * unrecoverable while it is on screen, or the operator closes the panel and
 * mints a second token to replace the one they did not copy. Hence the panel
 * says so in words, leads with the copy control, and does not disappear on its
 * own — it goes when the operator dismisses it, which is the only moment
 * anybody can be sure they are done with it.
 *
 * The rows carry dates and no nickname, because the row has no nickname column
 * (`src/commands/agent-tokens.ts`). Mint date is what separates them, which is
 * thin and is honest: it is the same argument the passkey card makes with
 * `lastUsedAt`, minus a column nobody has needed yet.
 */
import { KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentTokenListItem } from '../../../commands/agent-tokens.ts';
import { command } from '../../client.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';

type Running =
  | { readonly kind: 'mint' }
  | { readonly kind: 'revoke'; readonly id: string };

export function AgentTokens() {
  const [tokens, setTokens] = useState<readonly AgentTokenListItem[] | null>(
    null,
  );
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);

  const refresh = useCallback(async () => {
    const result = await command('listAgentTokens', {});
    if (!result.ok) {
      setError(result.failure.message);
      return;
    }
    setTokens(result.value.tokens);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError('Agent tokens could not be loaded.'));
  }, [refresh]);

  const act = async (next: Running, run: () => Promise<string | null>) => {
    setError(null);
    setRunning(next);
    try {
      const failure = await run();
      if (failure !== null) {
        setError(failure);
        return;
      }
      await refresh();
    } catch {
      setError('Agent tokens could not be changed.');
    } finally {
      setRunning(null);
    }
  };

  const onMint = () =>
    act({ kind: 'mint' }, async () => {
      const result = await command('mintAgentToken', {});
      if (!result.ok) return result.failure.message;
      setMinted(result.value.token);
      return null;
    });

  const onRevoke = (id: string) =>
    act({ kind: 'revoke', id }, async () => {
      const result = await command('revokeAgentToken', { id });
      return result.ok ? null : result.failure.message;
    });

  return (
    <AgentTokensView
      tokens={tokens}
      minted={minted}
      error={error}
      running={running}
      onMint={onMint}
      onRevoke={onRevoke}
      onDismissMinted={() => setMinted(null)}
    />
  );
}

export function AgentTokensView({
  tokens,
  minted,
  error,
  running,
  onMint,
  onRevoke,
  onDismissMinted,
}: {
  readonly tokens: readonly AgentTokenListItem[] | null;
  readonly minted: string | null;
  readonly error: string | null;
  readonly running: Running | null;
  readonly onMint: () => void;
  readonly onRevoke: (id: string) => void;
  readonly onDismissMinted: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <CardTitle>Agent tokens</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Bearer tokens for the MCP endpoint at <code>/mcp</code>. They are
            not session cookies and a cookie will not work there: this is a
            credential meant to live in a config file, so it is a separate row
            you can revoke without signing yourself out. Every tool behind it is
            an act.
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm text-terminal-destructive">
            {error}
          </p>
        )}

        {minted !== null && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-sm border border-border bg-muted/40 p-3"
          >
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <TriangleAlert aria-hidden="true" className="size-4" />
              Copy this now — it is not shown again.
            </p>
            <div className="flex items-center gap-2">
              {/* The value in full rather than shortened. A credential is the
                  one thing truncation must never touch, and `break-all` keeps
                  it inside the panel without hiding a character of it. */}
              <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">
                {minted}
              </code>
              <CopyButton value={minted} label="agent token" />
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={onDismissMinted}
            >
              Done
            </Button>
          </div>
        )}

        {tokens === null ? (
          <SkeletonRows rows={2} />
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent tokens. Nothing can reach <code>/mcp</code> until one is
            minted.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center gap-3 py-3 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-foreground">
                    {token.id.slice(0, 8)}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      Minted <Timestamp at={token.createdAt} />
                    </span>
                    <span aria-hidden="true">·</span>
                    {/* An expired token is dead but still a row, and the only
                        thing to do with it is remove it. Saying which it is
                        keeps `Revoke` from looking like it does something. */}
                    <span className="flex items-center gap-1">
                      {token.expired ? 'Expired' : 'Expires'}{' '}
                      <Timestamp at={token.expiresAt} />
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    running?.kind === 'revoke' && running.id === token.id
                  }
                  title="Revoke this agent token"
                  onClick={() => onRevoke(token.id)}
                >
                  <Trash2 aria-hidden="true" />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Button
          className="self-start"
          variant="outline"
          disabled={running !== null}
          onClick={onMint}
        >
          <Plus aria-hidden="true" />
          {running?.kind === 'mint' ? 'Minting…' : 'Mint an agent token'}
        </Button>
      </CardContent>
    </Card>
  );
}
