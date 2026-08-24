import { describe, expect, setSystemTime, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { leaderboard } from '../src/ledger.ts';
import { PRICES } from '../src/prices.ts';

// Offline fake facilitator: the middleware syncs /supported before answering
// the first paid request, so serve the two kinds PayAI advertises.
const HOSTILE_PAYER = '"><img src=x onerror=alert(1)>';
const HOSTILE_TX = '"><b>tx</b>';
let facilitatorCalls = 0;
const facilitator = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/verify' || path === '/settle') facilitatorCalls++;
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
// Canned brain + chain RPC: never a real provider, never a real node.
let brainStatus = 200;
const brain = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/chat/completions') {
      const body = (await req.json()) as { messages: { content: string }[] };
      return Response.json(
        {
          choices: [
            { message: { content: `canned: ${body.messages[1]?.content}` } },
          ],
        },
        { status: brainStatus },
      );
    }
    const rpc = (await req.json()) as { method: string };
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        rpc.method === 'eth_getBalance'
          ? '0xde0b6b3a7640000'
          : `0x${'0'.repeat(58)}1e8480`,
    });
  },
});

process.env.PAY_TO_EVM = '0x0000000000000000000000000000000000000001';
process.env.PAY_TO_SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
process.env.FACILITATOR_URL = `http://localhost:${facilitator.port}`;
process.env.BASE_RPC_URL = `http://localhost:${brain.port}/rpc`;
delete process.env.DATABASE_URL;
delete process.env.LLM_BASE_URL;
delete process.env.LLM_MODEL;
const withBrain = () => {
  process.env.LLM_BASE_URL = `http://localhost:${brain.port}`;
  process.env.LLM_MODEL = 'canned-1';
};
const withoutBrain = () => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
};

const { app } = await import('../src/server.ts');

const atomic = (price: string) =>
  String(Math.round(Number(price.slice(1)) * 1e6));
const fill = (path: string) =>
  path
    .replace(':name', 'alice')
    .replace(':key', 'greeting')
    .replace(':address', '0x0000000000000000000000000000000000000002') +
  (path === '/ask' ? '?q=hi' : '');

async function challenge(path: string, init: RequestInit = {}) {
  const res = await app.request(path, init);
  expect(res.status).toBe(402);
  const header = res.headers.get('payment-required');
  expect(header).toBeTruthy();
  return JSON.parse(atob(header as string));
}

function payload(body: {
  resource: unknown;
  accepts: Record<string, string>[];
}) {
  const accepted = body.accepts.find((a) => a.network === 'eip155:8453');
  if (!accepted) throw new Error('no base accept');
  return {
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
  };
}

/** Drive verify → handler → settle offline; returns the paid response. */
async function pay(path: string, init: RequestInit = {}) {
  const body = await challenge(path, init);
  const header = btoa(JSON.stringify(payload(body)));
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      'payment-signature': header,
    },
  });
}
const ledgerEntries = async () =>
  (
    (await (await app.request('/ledger')).json()) as {
      entries: Record<string, string>[];
    }
  ).entries;

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

  test('every priced route challenges with its atomic amount', async () => {
    withBrain();
    for (const [key, [price]] of Object.entries(PRICES)) {
      const [method, path] = key.split(' ') as [string, string];
      const body = await challenge(fill(path), { method });
      expect(body.accepts).toHaveLength(2);
      for (const accept of body.accepts)
        expect(accept.amount).toBe(atomic(price));
    }
    withoutBrain();
  });

  test('ledger starts empty', async () => {
    const res = await app.request('/ledger');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [],
      leaderboard: [],
      tips: [],
      stats: { count: 0, total: '0', payers: 0 },
    });
  });

  test('index renders tiles, every price row, and reduced-motion', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of ['s-count', 's-total', 's-payers'])
      expect(html).toContain(`id="${id}"`);
    for (const key of Object.keys(PRICES))
      expect(html).toContain(`<code>${key}</code>`);
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('.shine{animation:none}');
    expect(html).toContain('no brain configured');
  });

  test('a settled payment serves content, lands on the ledger, and is escaped on /', async () => {
    const res = await pay('/fortune');
    expect(res.status).toBe(200);
    const paid = (await res.json()) as { fortune: string; payer: string };
    expect(paid.fortune).toBeTruthy();
    expect(paid.payer).toBe(HOSTILE_PAYER);

    const entries = await ledgerEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
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
    expect(await ledgerEntries()).toHaveLength(1);
  });

  test('dice is deterministic for a given payment header', async () => {
    const header = btoa(JSON.stringify(payload(await challenge('/dice'))));
    const roll = async () =>
      (await (
        await app.request('/dice', { headers: { 'payment-signature': header } })
      ).json()) as { roll: number; seed: string };
    const a = await roll();
    const b = await roll();
    expect(a).toEqual(b);
    expect(a.roll).toBeGreaterThanOrEqual(1);
    expect(a.roll).toBeLessThanOrEqual(20);
    expect(a.seed).toMatch(/^[0-9a-f]{12}$/);
  });

  test('premium fortune and oracle and whoami sums', async () => {
    const premium = (await (await pay('/premium/fortune')).json()) as {
      tier: string;
    };
    expect(premium.tier).toBe('premium');
    const oracle = (await (await pay('/oracle')).json()) as { answer: string };
    expect(oracle.answer).toBeTruthy();
    const me = (await (await pay('/whoami')).json()) as Record<string, unknown>;
    // fortune 1000 + dice 2×1000 + premium 100000 + oracle 500; whoami's own
    // settlement lands after its handler answers.
    expect(me).toMatchObject({
      payer: HOSTILE_PAYER,
      total: '103500',
      count: 5,
    });
    expect(me.first).toBeTruthy();
    expect(me.last).toBeTruthy();
  });

  test('tips land on the ticker; a bad name is refused before payment', async () => {
    const before = facilitatorCalls;
    const bad = await app.request('/tip/bad%20name!');
    expect(bad.status).toBe(400);
    expect(facilitatorCalls).toBe(before);
    expect((await pay('/tip/alice')).status).toBe(200);
    const ledger = (await (await app.request('/ledger')).json()) as {
      tips: string[];
    };
    expect(ledger.tips).toEqual(['alice']);
    expect(await (await app.request('/')).text()).toContain(
      '<span class="chip">alice</span>',
    );
  });

  test('kv round-trips per payer, 404 when absent, 413 over 4 KiB before payment', async () => {
    expect(
      (
        await app.request('/kv/greeting', {
          headers: { 'payment-signature': 'x' },
        })
      ).status,
    ).toBe(402);
    const missing = await pay('/kv/nothing');
    expect(missing.status).toBe(404);
    const put = await pay('/kv/greeting', {
      method: 'PUT',
      body: 'hello clanker',
    });
    expect(put.status).toBe(200);
    const get = await pay('/kv/greeting');
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hello clanker');
    const before = facilitatorCalls;
    const big = await app.request('/kv/greeting', {
      method: 'PUT',
      body: 'x'.repeat(4097),
    });
    expect(big.status).toBe(413);
    expect((await app.request('/kv/bad key')).status).toBe(400);
    expect(facilitatorCalls).toBe(before);
  });

  test('account mints a bearer pass that skips payment and the ledger; expired is 402', async () => {
    const res = await pay('/account', { method: 'POST' });
    expect(res.status).toBe(200);
    const { token, expires_at } = (await res.json()) as {
      token: string;
      expires_at: string;
    };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000,
    );
    const rows = (await ledgerEntries()).length;
    const before = facilitatorCalls;
    const free = await app.request('/fortune', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(free.status).toBe(200);
    expect(((await free.json()) as { payer: string }).payer).toBe(
      HOSTILE_PAYER,
    );
    expect(facilitatorCalls).toBe(before);
    expect(await ledgerEntries()).toHaveLength(rows);
    // A pass never mints a pass: that route stays behind the paywall.
    expect(
      (
        await app.request('/account', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(402);
    // A pass-holder committed no payment, so the die is chance, not a replay.
    const roll = async () =>
      (
        (await (
          await app.request('/dice', {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { seed: string }
      ).seed;
    expect(await roll()).not.toBe(await roll());
    expect(
      (
        await app.request('/fortune', {
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(402);
    setSystemTime(new Date(Date.now() + 25 * 3600_000));
    try {
      expect(
        (
          await app.request('/fortune', {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(402);
    } finally {
      setSystemTime();
    }
  });

  test('ask: 503 before payment without a brain, canned answer with one, 503 when it is out', async () => {
    const before = facilitatorCalls;
    const res = await app.request('/ask?q=hi');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no brain configured' });
    expect(facilitatorCalls).toBe(before);
    withBrain();
    try {
      expect((await app.request('/ask')).status).toBe(400);
      expect((await app.request(`/ask?q=${'x'.repeat(501)}`)).status).toBe(400);
      const paid = await pay('/ask?q=what%20is%20a%20clanker');
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({
        answer: 'canned: what is a clanker',
      });
      brainStatus = 500;
      const rows = (await ledgerEntries()).length;
      const out = await pay('/ask?q=hi');
      expect(out.status).toBe(503);
      expect(await out.json()).toEqual({ error: 'the brain is out to lunch' });
      expect(await ledgerEntries()).toHaveLength(rows);
    } finally {
      brainStatus = 200;
      withoutBrain();
    }
  });

  test('roast reads balances over RPC and hands them to the brain', async () => {
    withBrain();
    try {
      expect((await app.request('/roast/nope')).status).toBe(400);
      const res = await pay(
        '/roast/0x0000000000000000000000000000000000000002',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        roast: string;
        balances: { native: string; usdc: string };
        chain: string;
      };
      expect(body.chain).toBe('base');
      expect(body.balances).toEqual({ native: '1', usdc: '2' });
      expect(body.roast).toContain('"native":"1"');
    } finally {
      withoutBrain();
    }
  });

  test('mcp lists four paid tools; unpaid returns accepts, paid settles and lands on the ledger', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: async (url, init) => app.request(url, init),
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask',
      'dice',
      'fortune',
      'oracle',
    ]);
    const unpaid = await client.callTool({ name: 'fortune', arguments: {} });
    const required = unpaid.structuredContent as {
      accepts: Record<string, string>[];
      resource: unknown;
    };
    expect(unpaid.isError).toBe(true);
    expect(required.accepts.map((a) => a.amount)).toEqual(['1000', '1000']);
    const rows = (await ledgerEntries()).length;
    const paid = await client.callTool({
      name: 'fortune',
      arguments: {},
      _meta: { 'x402/payment': payload(required) },
    });
    expect(paid.isError).toBeFalsy();
    expect((paid.content as { text: string }[])[0]?.text).toBeTruthy();
    expect(
      (paid._meta as Record<string, { success: boolean }>)[
        'x402/payment-response'
      ]?.success,
    ).toBe(true);
    const entries = await ledgerEntries();
    expect(entries).toHaveLength(rows + 1);
    expect(entries[0]).toMatchObject({
      route: 'mcp:fortune',
      amount: '1000',
      payer: HOSTILE_PAYER,
    });
    const noBrain = await client.callTool({
      name: 'ask',
      arguments: { q: 'hi' },
    });
    expect(noBrain.isError).toBe(true);
    expect(await ledgerEntries()).toHaveLength(rows + 1);
    await client.close();
  });

  test('the 402 quote advertises the public https origin', async () => {
    const body = (await challenge('/fortune')) as {
      resource: { url: string };
    };
    expect(body.resource.url).toBe('https://clankerbanker.ca/fortune');
  });

  test('one signed payment is served once while it is in flight', async () => {
    const header = btoa(JSON.stringify(payload(await challenge('/oracle'))));
    const rows = (await ledgerEntries()).length;
    const statuses = (
      await Promise.all(
        [1, 2, 3].map(() =>
          app.request('/oracle', { headers: { 'payment-signature': header } }),
        ),
      )
    )
      .map((r) => r.status)
      .sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(await ledgerEntries()).toHaveLength(rows + 1);
  });

  test('a refused paid request leaves no payer stranded', async () => {
    // 404 cancels the payment; the same header must then be usable again.
    const header = btoa(JSON.stringify(payload(await challenge('/kv/nope'))));
    const first = await app.request('/kv/nope', {
      headers: { 'payment-signature': header },
    });
    expect(first.status).toBe(404);
    const again = await app.request('/kv/nope', {
      headers: { 'payment-signature': header },
    });
    expect(again.status).toBe(404);
  });

  test('a pass does not cover metered routes or oversized kv bodies', async () => {
    const res = await pay('/account', { method: 'POST' });
    const { token } = (await res.json()) as { token: string };
    const bearer = { authorization: `Bearer ${token}` };
    withBrain();
    try {
      expect((await app.request('/ask?q=hi', { headers: bearer })).status).toBe(
        402,
      );
      expect(
        (
          await app.request('/kv/k9', {
            method: 'PUT',
            headers: bearer,
            body: 'v',
          })
        ).status,
      ).toBe(402);
      expect(
        (
          await app.request('/kv/k9', {
            method: 'PUT',
            headers: { ...bearer, 'content-length': '5000' },
            body: 'v',
          })
        ).status,
      ).toBe(413);
    } finally {
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_MODEL;
    }
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
