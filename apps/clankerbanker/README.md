# clankerbanker

The bank that charges clankers: a Bun + Hono service whose paid routes are
gated by [x402](https://x402.org) v2. A robot hits a route, gets HTTP 402
with a `PAYMENT-REQUIRED` header, pays USDC on Base or Solana, and the
PayAI facilitator (no API key) verifies and settles. Every settlement lands
on the public ledger. Live at https://clankerbanker.ca.

## Routes

Prices live in `src/prices.ts`; the paywall routes and the landing page are
both rendered from that table.

| Route | Price | Returns |
| --- | --- | --- |
| `GET /fortune` | $0.001 | `{ fortune, payer }` |
| `GET /premium/fortune` | $0.10 | `{ fortune, payer, tier: "premium" }` |
| `GET /oracle` | $0.0005 | `{ answer }` from the magic 8-ball |
| `GET /dice` | $0.001 | `{ roll: 1-20, seed }`; SHA-256 of the payment header, so the payer committed to the roll before seeing it |
| `GET /ping` | $0.0001 | `{ pong, at }` |
| `GET /whoami` | $0.0001 | `{ payer, total, count, first, last }` lifetime ledger stats (amounts are atomic USDC strings) |
| `GET /tip/:name` | $0.005 | a name (`[a-z0-9-]{1,24}`, else 400 before payment) on the tips ticker |
| `PUT /kv/:key` | $0.001 | stores the body (text, up to 4 KiB, else 413 before payment) under the payer; key `[a-zA-Z0-9_.-]{1,64}` |
| `GET /kv/:key` | $0.0001 | the payer's value, 404 when absent |
| `POST /account` | $1.00 | `{ token, expires_at }`: a 24h bearer pass |
| `GET /ask?q=` | $0.01 | `{ answer }`: one model answer, 80 words, no memory; `q` 1-500 chars else 400 before payment |
| `GET /roast/:address` | $0.01 | `{ roast, balances: { native, usdc }, chain, stats }`: the model roasts a Base or Solana wallet from its on-chain balances and its ledger stats |
| `POST /mcp` | per tool | MCP streamable HTTP: paid tools `fortune`, `oracle`, `dice`, `ask` |
| `GET /ledger` | free | last 100 settlements, leaderboard, tips, totals |
| `GET /` | free | HTML pitch, prices, live ledger |
| `GET /healthz` | free | `ok` |

Handlers run after verify and before settle: a 4xx/5xx from a handler cancels
the payment instead of settling it. That is what makes the bearer pass, the
kv 404, and the brain refusals below free.

### Bearer pass

`POST /account` (paid) mints 32 random bytes as base64url; only its hash is
stored, with the payer and `expires_at`. Send it as
`Authorization: Bearer <token>` on the fun routes to skip the paywall: the
handler answers as that payer and writes no ledger row. It does not cover
`POST /account` (a dollar would otherwise buy a chain of passes), `/ask`,
`/roast`, or `PUT /kv` (each costs the bank something per call). An unknown or
expired token falls through to the normal 402.

### The walk-up window

The landing page renders one QR plate per configured treasury address, so a
human with a phone can send USDC (or the native coin) straight to the bank
without x402, a facilitator, or an agent. The plate encodes the **bare
address** rather than an EIP-681 or Solana Pay URI: a wallet that does not
parse those schemes still sends to the right place, and no naive parser can
mistake a token contract for the recipient. Each plate carries the address as
copyable text and a block-explorer link to the vault.

Over-the-counter deposits never reach the ledger — nothing indexes the chain,
so `/ledger`, the standings, and the wall only ever show x402 settlements.

### Brain routes

`/ask` and `/roast` call any OpenAI-compatible chat endpoint over raw
`fetch`. Without `LLM_BASE_URL` and `LLM_MODEL` they answer 503
`{ error: "no brain configured" }` before the paywall, and the page says so.
A non-2xx or 20s timeout from the provider answers 503
`{ error: "the brain is out to lunch" }`; the payment is cancelled, not
settled, so a refusal costs the payer nothing.

`/roast` reads balances with raw JSON-RPC: `eth_getBalance` plus USDC
`balanceOf` on Base, `getBalance` plus USDC `getTokenAccountsByOwner` on
Solana, 5s timeout. When the RPC does not answer, the model roasts the wallet
for being unreachable and `balances` is `{ native: null, usdc: null }`; it
never invents numbers.

### MCP

`POST /mcp` is a stateless streamable-HTTP MCP server. Each tool call without
`_meta["x402/payment"]` returns the x402 `accepts` as `structuredContent`
with `isError: true`; a call carrying a payment payload is verified, run, and
settled, and the result carries `_meta["x402/payment-response"]`. Settlements
land on the same ledger with route `mcp:<tool>`. The `ask` tool refuses before
payment when no brain is configured.

## Environment

| Var | Meaning |
| --- | --- |
| `PORT` | listen port, default 3000 |
| `PAY_TO_EVM` | 0x address; enables the Base (`eip155:8453`) USDC entry |
| `PAY_TO_SOLANA` | base58 address; enables the Solana mainnet USDC entry |
| `DATABASE_URL` | optional Postgres for the ledger, kv, and passes; in-memory otherwise |
| `FACILITATOR_URL` | default `https://facilitator.payai.network` |
| `PUBLIC_ORIGIN` | origin advertised in the 402 quote, default `https://clankerbanker.ca` |
| `LLM_BASE_URL` | OpenAI-compatible base, e.g. `https://opencode.ai/zen/v1`, `https://openrouter.ai/api/v1`, `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`, or an Ollama on the LAN |
| `LLM_API_KEY` | sent as `Authorization: Bearer`; leave unset for keyless endpoints |
| `LLM_MODEL` | model name passed to `/chat/completions` |
| `BASE_RPC_URL` | default `https://mainnet.base.org` |
| `SOLANA_RPC_URL` | default `https://api.mainnet-beta.solana.com` |

With neither `PAY_TO_*` set, paid routes and `/mcp` answer 503: the bank is
not open.

## Local

```sh
PAY_TO_EVM=0x... PAY_TO_SOLANA=... bun run dev
curl -si localhost:3000/fortune   # 402 + base64 PAYMENT-REQUIRED header
```

`bun test` drives verify → settle against an in-test fake facilitator, a
canned `/chat/completions`, and a canned JSON-RPC node; nothing leaves the
process.

## Paying

MoonPay CLI (Solana by default, `--chain base` for Base):

```sh
mp x402 limit set --amount 10000
mp x402 request --url https://clankerbanker.ca/fortune --wallet main
```

PayBox from Claude.ai: call `use_service` with the route URL (Base USDC).

No agent at all: open <https://clankerbanker.ca> and scan a walk-up plate.
