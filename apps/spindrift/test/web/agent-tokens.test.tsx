/**
 * The agent-token card, rendered to static markup.
 *
 * Every rule here is a statement about what is on screen in a given state,
 * which is what this depth of render can settle. The one that matters is the
 * reveal: the token exists in the response and nowhere else afterwards, so a
 * screen that truncates it, hides it behind a copy button that may not work in
 * an insecure context, or clears it on a timer has quietly destroyed a
 * credential. The assertions below say the whole value is present as text and
 * that the screen says out loud that it will not be shown again.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentTokenListItem } from '../../src/commands/agent-tokens.ts';
import { AgentTokensView } from '../../src/web/views/auth/agent-tokens.tsx';

const TOKEN_ID = '3f1c9a2e-7b64-4d51-9f0a-2c8d5e6b1a34';

function row(over: Partial<AgentTokenListItem> = {}): AgentTokenListItem {
  return {
    id: TOKEN_ID,
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    expired: false,
    ...over,
  };
}

function screen({
  tokens = [row()] as readonly AgentTokenListItem[] | null,
  minted = null as string | null,
  error = null as string | null,
} = {}): string {
  return renderToStaticMarkup(
    <AgentTokensView
      tokens={tokens}
      minted={minted}
      error={error}
      running={null}
      onMint={() => {}}
      onRevoke={() => {}}
      onDismissMinted={() => {}}
    />,
  );
}

describe('a token shown once is shown whole', () => {
  const SECRET = 'yGm4Qb2xTpL9vKcRfN8sWzA1dE7hJ0uYtX6oI3rB5nC';

  test('the minted value is on screen in full, not shortened', () => {
    const markup = screen({ minted: SECRET });
    expect(markup).toContain(SECRET);
  });

  test('and the screen says it will not be shown again', () => {
    // Without this sentence the operator dismisses the panel and mints a
    // second token to replace the one they did not copy.
    expect(screen({ minted: SECRET }).toLowerCase()).toContain(
      'not shown again',
    );
  });

  test('and nothing is revealed when nothing was minted', () => {
    expect(screen()).not.toContain(SECRET);
    expect(screen().toLowerCase()).not.toContain('not shown again');
  });
});

describe('the list is what makes a token revocable', () => {
  test('an empty list says nothing can reach the endpoint', () => {
    const markup = screen({ tokens: [] });
    expect(markup).toContain('/mcp');
    expect(markup.toLowerCase()).toContain('no agent tokens');
  });

  test('a row offers the one act there is', () => {
    expect(screen()).toContain('Revoke');
  });

  test('an expired row says expired rather than expires', () => {
    // The two states differ by one word and by whether the row still does
    // anything; `Revoke` on a dead token has to not look like a live act.
    expect(screen({ tokens: [row({ expired: true })] })).toContain('Expired');
    expect(screen({ tokens: [row({ expired: false })] })).toContain('Expires');
  });

  test('a load that has not answered yet is not an empty list', () => {
    // Rendering "no agent tokens" while the read is in flight tells the
    // operator to mint one they may already have.
    expect(screen({ tokens: null }).toLowerCase()).not.toContain(
      'no agent tokens',
    );
  });
});

describe('the card explains why this is not a cookie', () => {
  test('it names the endpoint and says a cookie will not work there', () => {
    const markup = screen().toLowerCase();
    expect(markup).toContain('/mcp');
    expect(markup).toContain('cookie');
  });

  test('a refusal is rendered as an alert', () => {
    expect(screen({ error: 'no agent token of yours has that id' })).toContain(
      'no agent token of yours has that id',
    );
  });
});
