import { describe, expect, test } from 'bun:test';
import { leaderboard } from '../src/ledger.ts';

// Offline fake facilitator: the middleware syncs /supported before answering
// the first paid request, so serve the two kinds PayAI advertises.
const HOSTILE_PAYER = '"><img src=x onerror=alert(1)>';
const HOSTILE_TX = '"><b>tx</b>';
const facilitator = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/verify')
      return Response.json({ isValid: true, payer: HOSTILE_PAYER });
    if (path === '/settle')
      return Response.json({
        success: true,
        transaction: HOSTILE_TX,
        network: 'eip155:8453',
        payer: HOSTILE_PAYER,
      });
    return path === '/supported'
      ? Response.json({
          kinds: [
            { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
            {
              x402Version: 2,
              scheme: 'exact',
              network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
              extra: {
                feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww',
              },
            },
          ],
          extensions: [],
          signers: {},
        })
      : new Response('not found', { status: 404 });
  },
});

process.env.PAY_TO_EVM = '0x0000000000000000000000000000000000000001';
process.env.PAY_TO_SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
process.env.FACILITATOR_URL = `http://localhost:${facilitator.port}`;
delete process.env.DATABASE_URL;

const { app } = await import('../src/server.ts');

async function challenge(path: string) {
  const res = await app.request(path);
  expect(res.status).toBe(402);
  const header = res.headers.get('payment-required');
  expect(header).toBeTruthy();
  return JSON.parse(atob(header as string));
}

describe('clankerbanker', () => {
  test('healthz is free', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('fortune answers 402 with both networks at $0.001', async () => {
    const body = await challenge('/fortune');
    expect(body.x402Version).toBe(2);
    const byNetwork = Object.fromEntries(
      body.accepts.map((a: Record<string, string>) => [a.network, a]),
    );
    const base = byNetwork['eip155:8453'];
    const sol = byNetwork['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
    for (const accept of [base, sol]) {
      expect(accept.scheme).toBe('exact');
      expect(accept.amount).toBe('1000');
    }
    expect(base.payTo).toBe('0x0000000000000000000000000000000000000001');
    expect(base.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(sol.payTo).toBe('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(sol.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  test('ping costs $0.0001', async () => {
    const body = await challenge('/ping');
    for (const accept of body.accepts) {
      expect(accept.amount).toBe('100');
    }
  });

  test('ledger starts empty', async () => {
    const res = await app.request('/ledger');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], leaderboard: [] });
  });

  test('index renders', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('clankerbanker');
  });

  test('a settled payment serves content, lands on the ledger, and is escaped on /', async () => {
    const body = await challenge('/fortune');
    const accepted = body.accepts.find(
      (a: { network: string }) => a.network === 'eip155:8453',
    );
    const header = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: body.resource,
        accepted,
        payload: {
          signature: '0xsig',
          authorization: {
            from: '0x0000000000000000000000000000000000000002',
            to: accepted.payTo,
            value: accepted.amount,
            validAfter: '0',
            validBefore: `${Math.floor(Date.now() / 1000) + 60}`,
            nonce: `0x${'00'.repeat(32)}`,
          },
        },
      }),
    );
    const res = await app.request('/fortune', {
      headers: { 'payment-signature': header },
    });
    expect(res.status).toBe(200);
    const paid = (await res.json()) as { fortune: string; payer: string };
    expect(paid.fortune).toBeTruthy();
    expect(paid.payer).toBe(HOSTILE_PAYER);

    const ledgerRes = (await (await app.request('/ledger')).json()) as {
      entries: Record<string, string>[];
    };
    expect(ledgerRes.entries).toHaveLength(1);
    expect(ledgerRes.entries[0]).toMatchObject({
      route: '/fortune',
      network: 'eip155:8453',
      payer: HOSTILE_PAYER,
      amount: '1000',
      tx: HOSTILE_TX,
    });

    const html = await (await app.request('/')).text();
    expect(html).not.toContain(HOSTILE_PAYER);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(HOSTILE_TX);
  });

  test('a garbage payment header is refused with 402', async () => {
    const res = await app.request('/fortune', {
      headers: { 'payment-signature': 'not-base64!' },
    });
    expect(res.status).toBe(402);
    const ledgerRes = (await (await app.request('/ledger')).json()) as {
      entries: unknown[];
    };
    expect(ledgerRes.entries).toHaveLength(1);
  });

  test('leaderboard sums BigInt amounts per payer', () => {
    const entry = (payer: string, amount: string) => ({
      at: '2026-08-23T00:00:00Z',
      route: '/fortune',
      network: 'eip155:8453',
      payer,
      amount,
      asset: 'USDC',
      tx: 'sig',
    });
    const top = leaderboard([
      entry('alice', '1000'),
      entry('bob', '100'),
      entry('alice', '9007199254740993'),
      entry('bob', '100'),
    ]);
    expect(top).toEqual([
      { payer: 'alice', total: '9007199254741993', count: 2 },
      { payer: 'bob', total: '200', count: 2 },
    ]);
  });
});
