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
    // The default row is a token nobody has presented, because that is the
    // state every token is in the moment it is minted.
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedAgent: null,
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

describe('when a token was last used', () => {
  test('a token nobody has presented says so, rather than leaving a blank', () => {
    // The row an operator most wants to find, and the one an empty space where
    // a date goes hides — a gap reads as a screen that has not loaded.
    expect(screen()).toContain('Never used');
  });

  test('a used token names when, where from, and what', () => {
    const markup = screen({
      tokens: [
        row({
          lastUsedAt: '2026-08-25T09:00:00.000Z',
          lastUsedIp: '203.0.113.7',
          lastUsedAgent: 'claude-code/1.4.0',
        }),
      ],
    });
    expect(markup).not.toContain('Never used');
    expect(markup).toContain('Last used');
    expect(markup).toContain('203.0.113.7');
    expect(markup).toContain('claude-code/1.4.0');
  });

  test('and says the address is only what the caller reported', () => {
    // Whoever holds the token sets `X-Forwarded-For` and `User-Agent`. The
    // qualifier is the difference between a hint and a claim, and dropping it
    // would invite an operator to trust the one thing here that cannot be.
    expect(
      screen({
        tokens: [
          row({
            lastUsedAt: '2026-08-25T09:00:00.000Z',
            lastUsedIp: '203.0.113.7',
          }),
        ],
      }),
    ).toContain('as reported');
  });

  test('a used token with no headers to show still says when', () => {
    // A caller that sent neither header is not a caller that never came.
    const markup = screen({
      tokens: [row({ lastUsedAt: '2026-08-25T09:00:00.000Z' })],
    });
    expect(markup).toContain('Last used');
    expect(markup).not.toContain('as reported');
  });
});
