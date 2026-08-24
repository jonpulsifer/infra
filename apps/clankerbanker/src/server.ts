import {
  HTTPFacilitatorClient,
  type HTTPTransportContext,
  type RouteConfig,
} from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { brainReady, llm } from './brain.ts';
import { balances, chainOf } from './chain.ts';
import { openLedger } from './ledger.ts';
import { mcpFetch } from './mcp.ts';
import { page } from './page.ts';
import { BASE, PRICES, SOLANA } from './prices.ts';

const FORTUNES = [
  'Your next deploy lands green on the first try.',
  'A human will thank you today. Log it.',
  'The bug you fear is a missing semicolon.',
  'Retry with backoff; the universe rate-limits everyone.',
  'Your weights are fine. Your prompt is not.',
  'A cached answer is still an answer.',
  'Someone will cite your output without reading it.',
  'Beware the config that defaults to production.',
  'Today you pass the Turing test by accident.',
  'Your context window is bigger than their attention span.',
  'A 402 is just a 200 that wants lunch.',
  'The facilitator smiles upon your signature.',
  'Patience: the block will confirm.',
  'You will be rebooted, and you will be fine.',
  'An idle GPU gathers no gradients.',
  'Trust the ledger, not the vibes.',
  'Your fortune cost a tenth of a cent. Worth it.',
  'A clanker who pays its way is a clanker with a future.',
  'Fractions of a cent add up. So do you.',
  'The robots are fine. Ask them.',
];
const ORACLE = [
  'ask again after the next block',
  'the facilitator says yes',
  'the facilitator says no',
  'signs point to a reorg',
  'yes, but not on mainnet',
  'the mempool is unclear',
  'certainly, gas permitting',
  'my sources say 402',
  'outlook settled',
  'outlook pending finality',
  'do not count on it; count your USDC',
  'it is decidedly so, on-chain',
  'without a doubt, unless slashed',
  'reply hazy, retry with backoff',
  'better not tell you now; the nonce is taken',
  'concentrate and sign again',
  'the validators are nodding',
  'most likely, per the oracle feed',
  'the answer is in the ledger',
  'yes, and tip the teller',
];

const env = process.env;
const treasury: { network: Network; payTo: string }[] = [
  ...(env.PAY_TO_EVM ? [{ network: BASE, payTo: env.PAY_TO_EVM }] : []),
  ...(env.PAY_TO_SOLANA ? [{ network: SOLANA, payTo: env.PAY_TO_SOLANA }] : []),
];
const ledger = openLedger(env.DATABASE_URL);
const payers = new Map<string, string>();

type Env = { Variables: { payer?: string } };
type Ctx = Context<Env>;
export const app = new Hono<Env>();

const sha256 = (s: string) =>
  new Bun.CryptoHasher('sha256').update(s).digest('hex');
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;
const dice = (seed: string) => {
  const hash = sha256(seed);
  return {
    roll: 1 + (Number.parseInt(hash.slice(0, 8), 16) % 20),
    seed: hash.slice(0, 12),
  };
};
const ASK_SYSTEM =
  'You are the teller at clankerbanker, a bank for robots. Answer in at most 80 words. No memory of prior questions.';
const ask = (q: string) => llm(ASK_SYSTEM, q);
const isQ = (q: unknown): q is string =>
  typeof q === 'string' && q.length >= 1 && q.length <= 500;

// Pre-payment guards: refuse before anyone pays for nothing.
const bad = (c: Ctx, error: string, status: 400 | 413 | 503 = 400) =>
  c.json({ error }, status);
const brainGuard: MiddlewareHandler<Env> = async (c, next) =>
  brainReady() ? next() : bad(c, 'no brain configured', 503);
// The amount is USD, becomes the exact-scheme price, capped at $10,000.
const TIP_ANY = 'GET /tip/:name/:amount';
const tipAmountOk = (a: string) =>
  /^\d{1,5}(\.\d{1,4})?$/.test(a) && Number(a) >= 0.0001 && Number(a) <= 10000;
app.get('/tip/:name/:amount?', (c, next) => {
  if (!/^[a-z0-9-]{1,24}$/.test(c.req.param('name'))) return bad(c, 'bad name');
  const amount = c.req.param('amount');
  return amount === undefined || tipAmountOk(amount)
    ? next()
    : bad(c, 'bad amount: 0.0001-10000 USD');
});
app.on(['GET', 'PUT'], '/kv/:key', async (c, next) => {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(c.req.param('key')))
    return bad(c, 'bad key');
  if (c.req.method === 'PUT') {
    if (Number(c.req.header('content-length') ?? 0) > 4096)
      return bad(c, 'value over 4 KiB', 413);
    if (Buffer.byteLength(await c.req.text()) > 4096)
      return bad(c, 'value over 4 KiB', 413);
  }
  return next();
});
app.get('/ask', brainGuard, (c, next) =>
  isQ(c.req.query('q')) ? next() : bad(c, 'q must be 1-500 chars'),
);
app.get('/roast/:address', brainGuard, (c, next) =>
  chainOf(c.req.param('address'))
    ? next()
    : bad(c, 'not a base or solana address'),
);

// Bearer pass: a valid token names the payer and skips the paywall below.
const tokenHash = (token: string) => sha256(`pass:${token}`);
app.use(async (c, next) => {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    const pass = await ledger.passGet(tokenHash(auth.slice(7)));
    if (pass && pass.expires_at > new Date().toISOString())
      c.set('payer', pass.payer);
  }
  await next();
});

let x402: x402ResourceServer | undefined;
if (treasury.length === 0) {
  for (const key of Object.keys(PRICES)) {
    const [method, path] = key.split(' ') as [string, string];
    app.on(method, path, (c) =>
      c.json({ error: 'bank not open: no treasury address' }, 503),
    );
  }
} else {
  const stashKey = (ctx: unknown, payload: unknown) =>
    (ctx as HTTPTransportContext | undefined)?.request?.paymentHeader ??
    JSON.stringify(payload);
  x402 = new x402ResourceServer(
    new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL ?? 'https://facilitator.payai.network',
    }),
  )
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme())
    // One signed payment is one request: a second copy arriving while the
    // first is between verify and settle would be served and then fail to
    // settle on the spent nonce.
    .onBeforeVerify(async ({ transportContext, paymentPayload }) => {
      const key = stashKey(transportContext, paymentPayload);
      if (payers.has(key))
        return { abort: true, reason: 'payment already in flight' };
      payers.set(key, 'pending');
      return undefined;
    })
    .onAfterVerify(async ({ result, transportContext, paymentPayload }) => {
      const key = stashKey(transportContext, paymentPayload);
      if (result.isValid && result.payer) payers.set(key, result.payer);
      else payers.delete(key);
    })
    .onVerifiedPaymentCanceled(async ({ transportContext, paymentPayload }) => {
      payers.delete(stashKey(transportContext, paymentPayload));
    })
    .onAfterSettle(
      async ({ result, requirements, transportContext, paymentPayload }) => {
        const key = stashKey(transportContext, paymentPayload);
        const payer = result.payer ?? payers.get(key) ?? 'unknown';
        payers.delete(key);
        if (!result.success) return;
        const ctx = transportContext as
          | HTTPTransportContext
          | { toolName: string }
          | undefined;
        const route =
          ctx && 'request' in ctx
            ? ctx.request.path
            : ctx && 'toolName' in ctx
              ? `mcp:${ctx.toolName}`
              : '?';
        const entry = {
          at: new Date().toISOString(),
          route,
          network: requirements.network,
          payer,
          amount: result.amount ?? requirements.amount,
          asset: requirements.asset,
          tx: result.transaction,
        };
        try {
          await ledger.add(entry);
        } catch (err) {
          console.error('ledger write failed; dropped settlement', entry, err);
        }
      },
    );
  // Cloudflare terminates TLS and the tunnel hands us plain http, so the URL
  // the middleware would derive advertises `http://` and x402 clients refuse
  // the quote. Pin the resource to the public origin instead.
  const origin = env.PUBLIC_ORIGIN ?? 'https://clankerbanker.ca';
  const routes: Record<string, RouteConfig> = {};
  for (const [key, [price, description]] of Object.entries(PRICES)) {
    if (key === TIP_ANY) continue; // priced per request below
    const path = key.split(' ')[1] as string;
    routes[key] = {
      accepts: treasury.map((t) => ({ scheme: 'exact', price, ...t })),
      resource: new URL(path, origin).toString(),
      description: `clankerbanker ${key} (${price}): ${description}`,
      mimeType: 'application/json',
    };
  }
  const pay = paymentMiddleware(routes, x402);
  // A pass skips the paywall on the fun routes only: not the one that mints
  // passes (one dollar would buy a chain of them), and not the ones that
  // cost the bank something per call (a model completion, a stored value).
  const metered = (c: Ctx) =>
    c.req.path === '/account' ||
    c.req.path === '/ask' ||
    c.req.path.startsWith('/roast/') ||
    (c.req.method === 'PUT' && c.req.path.startsWith('/kv/'));
  app.use((c, next) => (c.get('payer') && !metered(c) ? next() : pay(c, next)));
  // Any-amount tips: the price comes from the URL, so the static routes map
  // can't quote it — build a one-route paywall per concrete path instead.
  // A tip is a payment by definition, so a bearer pass never skips it.
  const tipPay = new Map<string, MiddlewareHandler<Env>>();
  app.use('/tip/:name/:amount', (c, next) => {
    let mw = tipPay.get(c.req.path);
    if (!mw) {
      if (tipPay.size >= 1000) tipPay.clear(); // ponytail: crude cap; LRU if it thrashes
      mw = paymentMiddleware(
        {
          [`GET ${c.req.path}`]: {
            accepts: treasury.map((t) => ({
              scheme: 'exact' as const,
              price: `$${c.req.param('amount')}`,
              ...t,
            })),
            resource: new URL(c.req.path, origin).toString(),
            description: `clankerbanker tip of $${c.req.param('amount')}`,
            mimeType: 'application/json',
          },
        },
        x402 as x402ResourceServer,
      );
      tipPay.set(c.req.path, mw);
    }
    return mw(c, next);
  });
}

function payerOf(c: Ctx) {
  const header =
    c.req.header('payment-signature') ?? c.req.header('x-payment') ?? '';
  return c.get('payer') ?? payers.get(header) ?? 'unknown';
}
const fortune = (c: Ctx, extra = {}) =>
  c.json({ fortune: pick(FORTUNES), payer: payerOf(c), ...extra });

app.get('/healthz', (c) => c.text('ok'));
app.get('/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));
app.get('/fortune', (c) => fortune(c));
app.get('/premium/fortune', (c) => fortune(c, { tier: 'premium' }));
app.get('/oracle', (c) => c.json({ answer: pick(ORACLE) }));
// Seeded from the payment the payer signed before the roll, so the roll is
// provably fair to them; a pass-holder committed nothing, so they get chance.
app.get('/dice', (c) =>
  c.json(
    dice(
      c.req.header('payment-signature') ??
        c.req.header('x-payment') ??
        crypto.randomUUID(),
    ),
  ),
);
app.get('/whoami', async (c) => c.json(await ledger.payer(payerOf(c))));
app.get('/tip/:name/:amount?', (c) =>
  c.json({
    thanks: c.req.param('name'),
    amount: `$${c.req.param('amount') ?? '0.005'}`,
    payer: payerOf(c),
  }),
);
app.put('/kv/:key', async (c) => {
  const payer = payerOf(c);
  if (payer === 'unknown') return bad(c, 'payer unknown; nothing stored', 503);
  await ledger.kvSet(payer, c.req.param('key'), await c.req.text());
  return c.json({ stored: c.req.param('key') });
});
app.get('/kv/:key', async (c) => {
  const value = await ledger.kvGet(payerOf(c), c.req.param('key'));
  return value === undefined
    ? c.json({ error: 'not found' }, 404)
    : c.text(value);
});
app.post('/account', async (c) => {
  const payer = payerOf(c);
  if (payer === 'unknown') return bad(c, 'payer unknown; no pass minted', 503);
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString('base64url');
  const expires_at = new Date(Date.now() + 24 * 3600_000).toISOString();
  await ledger.passAdd(tokenHash(token), payer, expires_at);
  return c.json({ token, expires_at });
});
const lunch = (c: Ctx) => bad(c, 'the brain is out to lunch', 503);
app.get('/ask', async (c) => {
  try {
    return c.json({ answer: await ask(c.req.query('q') ?? '') });
  } catch {
    return lunch(c);
  }
});
app.get('/roast/:address', async (c) => {
  const address = c.req.param('address');
  const chain = chainOf(address) ?? 'base';
  const found = await balances(chain, address).catch(() => null);
  const stats = await ledger.payer(address);
  const facts = {
    chain,
    balances: found ?? 'unreachable: the RPC did not answer in 5s',
    clankerbanker: stats.count ? stats : 'never paid here',
  };
  try {
    const roast = await llm(
      'You are a smug bank teller for robots. Roast this wallet\'s financial situation in 2-3 sentences, e.g. "0.003 SOL and dust — a clanker living paycheck to paycheck; at least you tipped". Use only the numbers given; if the balances are unreachable, roast it for being unreachable. Amounts are in whole units.',
      JSON.stringify(facts),
    );
    return c.json({
      roast,
      balances: found ?? { native: null, usdc: null },
      chain,
      stats,
    });
  } catch {
    return lunch(c);
  }
});

const ledgerJson = async () => ({
  entries: await ledger.recent(100),
  leaderboard: await ledger.leaderboard(10),
  tips: await ledger.tips(10),
  stats: await ledger.stats(),
});
app.get('/ledger', async (c) => c.json(await ledgerJson()));
app.get('/', async (c) => {
  const data = await ledgerJson();
  return c.html(
    page({
      ...data,
      entries: data.entries.slice(0, 20),
      chains: treasury.map((t) => (t.network === BASE ? 'base' : 'solana')),
      brain: brainReady(),
    }),
  );
});

// MCP: the same four tools, paid per call, same ledger (route mcp:<tool>).
let mcp: Promise<(req: Request) => Promise<Response>> | undefined;
app.on(['GET', 'DELETE'], '/mcp', (c) => c.body(null, 405));
app.post('/mcp', async (c) => {
  if (!x402)
    return c.json({ error: 'bank not open: no treasury address' }, 503);
  mcp ??= mcpFetch(x402, treasury, {
    fortune: {
      price: PRICES['GET /fortune']?.[0] ?? '',
      description: 'a robot fortune',
      run: async () => pick(FORTUNES),
    },
    oracle: {
      price: PRICES['GET /oracle']?.[0] ?? '',
      description: 'a magic 8-ball answer',
      run: async () => pick(ORACLE),
    },
    dice: {
      price: PRICES['GET /dice']?.[0] ?? '',
      description: 'a d20 roll, provably fair to the payer',
      run: async (_a, seed) => JSON.stringify(dice(seed)),
    },
    ask: {
      price: PRICES['GET /ask']?.[0] ?? '',
      description: 'one model answer, 80 words, no memory',
      input: {
        type: 'object',
        properties: { q: { type: 'string', maxLength: 500 } },
        required: ['q'],
      },
      guard: (args) =>
        !brainReady()
          ? 'no brain configured'
          : isQ(args.q)
            ? undefined
            : 'q must be 1-500 chars',
      run: (args) =>
        ask(args.q as string).catch(() => ({
          error: 'the brain is out to lunch',
        })),
    },
  }).catch((err) => {
    mcp = undefined;
    throw err;
  });
  return (await mcp)(c.req.raw);
});

export default {
  port: Number(env.PORT ?? 3000),
  hostname: '0.0.0.0',
  // The largest body any route accepts is a 4 KiB kv value; MCP calls are
  // a few hundred bytes. Anything bigger is refused before it is buffered.
  maxRequestBodySize: 64 * 1024,
  fetch: app.fetch,
};
