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

// The minted value is in no later response, so it must be on screen whole, as
// text: a copy button may not work in an insecure context.
describe('a token shown once is shown whole', () => {
  const SECRET = 'yGm4Qb2xTpL9vKcRfN8sWzA1dE7hJ0uYtX6oI3rB5nC';

  test('the minted value is on screen in full, not shortened', () => {
    const markup = screen({ minted: SECRET });
    expect(markup).toContain(SECRET);
  });

  test('and the screen says it will not be shown again', () => {
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
    expect(screen({ tokens: [row({ expired: true })] })).toContain('Expired');
    expect(screen({ tokens: [row({ expired: false })] })).toContain('Expires');
  });

  test('a load that has not answered yet is not an empty list', () => {
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
    // The caller sets `X-Forwarded-For` and `User-Agent`, so neither is proof.
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
    const markup = screen({
      tokens: [row({ lastUsedAt: '2026-08-25T09:00:00.000Z' })],
    });
    expect(markup).toContain('Last used');
    expect(markup).not.toContain('as reported');
  });
});
