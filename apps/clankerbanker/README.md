# clankerbanker

The bank that charges clankers: a Bun + Hono service whose paid routes are
gated by [x402](https://x402.org) v2. A robot hits a route, gets HTTP 402
with a `PAYMENT-REQUIRED` header, pays USDC on Base or Solana, and the
PayAI facilitator (no API key) verifies and settles. Every settlement lands
on the public ledger. Live at https://clankerbanker.ca.

## Routes

| Route | Price | Returns |
| --- | --- | --- |
| `GET /fortune` | $0.001 | `{ fortune, payer }` |
| `GET /ping` | $0.0001 | `{ pong, at }` |
| `GET /ledger` | free | last 100 settlements + leaderboard |
| `GET /` | free | HTML pitch, prices, live ledger |
| `GET /healthz` | free | `ok` |

## Environment

| Var | Meaning |
| --- | --- |
| `PORT` | listen port, default 3000 |
| `PAY_TO_EVM` | 0x address; enables the Base (`eip155:8453`) USDC entry |
| `PAY_TO_SOLANA` | base58 address; enables the Solana mainnet USDC entry |
| `DATABASE_URL` | optional Postgres for the ledger; in-memory otherwise |
| `FACILITATOR_URL` | default `https://facilitator.payai.network` |
| `PUBLIC_ORIGIN` | origin advertised in the 402 quote, default `https://clankerbanker.ca` |

With neither `PAY_TO_*` set, paid routes answer 503: the bank is not open.

## Local

```sh
PAY_TO_EVM=0x... PAY_TO_SOLANA=... bun run dev
curl -si localhost:3000/fortune   # 402 + base64 PAYMENT-REQUIRED header
```

## Paying

MoonPay CLI (Solana by default, `--chain base` for Base):

```sh
mp x402 limit set --amount 10000
mp x402 request --url https://clankerbanker.ca/fortune --wallet main
```

PayBox from Claude.ai: call `use_service` with the route URL (Base USDC).
