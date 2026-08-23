import {
  HTTPFacilitatorClient,
  type HTTPTransportContext,
  type RouteConfig,
} from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { Hono } from 'hono';
import { type Entry, openLedger } from './ledger.ts';

const BASE: Network = 'eip155:8453';
const SOLANA: Network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PRICES: Record<string, string> = {
  '/fortune': '$0.001',
  '/ping': '$0.0001',
};
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

const env = process.env;
const treasury: { network: Network; payTo: string }[] = [
  ...(env.PAY_TO_EVM ? [{ network: BASE, payTo: env.PAY_TO_EVM }] : []),
  ...(env.PAY_TO_SOLANA ? [{ network: SOLANA, payTo: env.PAY_TO_SOLANA }] : []),
];
const ledger = openLedger(env.DATABASE_URL);
const payers = new Map<string, string>();

export const app = new Hono();

if (treasury.length === 0) {
  for (const path of Object.keys(PRICES)) {
    app.use(path, async (c) =>
      c.json({ error: 'bank not open: no treasury address' }, 503),
    );
  }
} else {
  const server = new x402ResourceServer(
    new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL ?? 'https://facilitator.payai.network',
    }),
  )
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme())
    .onAfterVerify(async ({ result, transportContext }) => {
      const header = (transportContext as HTTPTransportContext | undefined)
        ?.request.paymentHeader;
      if (!result.isValid || !header || !result.payer) return;
      // ponytail: clear-on-cap; entries strand only when settle never runs
      if (payers.size > 1000) payers.clear();
      payers.set(header, result.payer);
    })
    .onAfterSettle(async ({ result, requirements, transportContext }) => {
      const req = (transportContext as HTTPTransportContext | undefined)
        ?.request;
      const header = req?.paymentHeader ?? '';
      const payer = result.payer ?? payers.get(header) ?? 'unknown';
      payers.delete(header);
      if (!result.success) return;
      const entry = {
        at: new Date().toISOString(),
        route: req?.path ?? '?',
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
    });
  const routes: Record<string, RouteConfig> = {};
  for (const [path, price] of Object.entries(PRICES)) {
    routes[`GET ${path}`] = {
      accepts: treasury.map((t) => ({ scheme: 'exact', price, ...t })),
      description: `clankerbanker ${path} (${price})`,
      mimeType: 'application/json',
    };
  }
  app.use(paymentMiddleware(routes, server));
}

function payerOf(c: { req: { header(n: string): string | undefined } }) {
  const header =
    c.req.header('payment-signature') ?? c.req.header('x-payment') ?? '';
  return payers.get(header) ?? 'unknown';
}

app.get('/healthz', (c) => c.text('ok'));
app.get('/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));
app.get('/fortune', (c) =>
  c.json({
    fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)],
    payer: payerOf(c),
  }),
);
app.get('/ledger', async (c) =>
  c.json({
    entries: await ledger.recent(100),
    leaderboard: await ledger.leaderboard(10),
  }),
);
app.get('/', async (c) =>
  c.html(page(await ledger.recent(20), await ledger.leaderboard(10))),
);

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ] ?? ch,
  );
const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toFixed(4)}`;
const short = (s: string) =>
  s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
const txUrl = (e: Entry) =>
  e.network === BASE
    ? `https://basescan.org/tx/${encodeURIComponent(e.tx)}`
    : `https://solscan.io/tx/${encodeURIComponent(e.tx)}`;
const chain = (network: string) => (network === BASE ? 'base' : 'solana');

function page(
  entries: Entry[],
  leaders: { payer: string; total: string; count: number }[],
) {
  const status =
    treasury.length === 0
      ? '<p class="warn">bank not open: no treasury address configured.</p>'
      : `<p>accepting ${treasury.map((t) => chain(t.network)).join(' + ')} USDC.</p>`;
  const rows = entries
    .map(
      (e) =>
        `<tr><td>${esc(e.at)}</td><td>${esc(e.route)}</td><td>${chain(e.network)}</td><td title="${esc(e.payer)}">${esc(short(e.payer))}</td><td>${usd(e.amount)}</td><td><a href="${esc(txUrl(e))}">${esc(short(e.tx))}</a></td></tr>`,
    )
    .join('');
  const top = leaders
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td title="${esc(l.payer)}">${esc(short(l.payer))}</td><td>${usd(l.total)}</td><td>${l.count}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clankerbanker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#111;color:#ddd;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:60rem;margin:2rem auto;padding:0 1rem}
h1{color:#7fd;margin:0}h2{color:#9cf;font-size:1.1rem;margin-top:2rem}a{color:#7fd}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #333;padding:.3rem .5rem;text-align:left}
code,pre{background:#1b1b1b;color:#fd7;padding:.1rem .3rem}pre{padding:.6rem;overflow-x:auto}.warn{color:#f96}
</style></head><body>
<h1>clankerbanker</h1>
<p>a bank for clankers: robots pay fractions of a cent per request over <a href="https://x402.org">x402</a>. every settlement lands on the public ledger below.</p>
${status}
<h2>prices</h2>
<table><tr><th>route</th><th>price</th><th>returns</th></tr>
<tr><td><code>GET /fortune</code></td><td>${esc(PRICES['/fortune'] ?? '')}</td><td>a robot fortune</td></tr>
<tr><td><code>GET /ping</code></td><td>${esc(PRICES['/ping'] ?? '')}</td><td>pong</td></tr>
<tr><td><code>GET /ledger</code></td><td>free</td><td>this ledger as JSON</td></tr></table>
<h2>how to pay</h2>
<p>MoonPay CLI (Solana by default, <code>--chain base</code> for Base):</p>
<pre>mp x402 limit set --amount 10000
mp x402 request --url https://clankerbanker.ca/fortune --wallet main
mp x402 request --url https://clankerbanker.ca/fortune --wallet main --chain base</pre>
<p>PayBox from Claude.ai: call <code>use_service</code> with <code>https://clankerbanker.ca/fortune</code> (Base USDC by default).</p>
<h2>ledger (last ${entries.length})</h2>
<table><tr><th>time</th><th>route</th><th>network</th><th>payer</th><th>amount</th><th>tx</th></tr>${rows || '<tr><td colspan="6">no settlements yet</td></tr>'}</table>
<h2>leaderboard</h2>
<table><tr><th>#</th><th>payer</th><th>total</th><th>requests</th></tr>${top || '<tr><td colspan="4">nobody yet</td></tr>'}</table>
</body></html>`;
}

export default {
  port: Number(env.PORT ?? 3000),
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
