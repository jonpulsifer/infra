# clankerbanker

clankerbanker is a Bun and Hono service at https://clankerbanker.ca whose paid
routes use [x402](https://x402.org) v2: a client pays USDC on Base or Solana,
and the PayAI facilitator verifies and settles the payment. See
[clankerbanker](https://wiki.lolwtf.ca/apps/clankerbanker/).

## Run

```bash
PAY_TO_EVM=0x... PAY_TO_SOLANA=... bun run dev
curl -si localhost:3000/fortune   # 402 and a base64 PAYMENT-REQUIRED header
```

Without a `PAY_TO_*` address, the paid routes and `/mcp` answer 503.

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port. The default is 3000. |
| `PAY_TO_EVM` | A 0x address. It turns on the Base (`eip155:8453`) USDC payment. |
| `PAY_TO_SOLANA` | A base58 address. It turns on the Solana mainnet USDC payment. |
| `DATABASE_URL` | Postgres for the ledger, the key-value store and the bearer passes. Without it, they are in memory. |
| `FACILITATOR_URL` | The default is `https://facilitator.payai.network`. |
| `PUBLIC_ORIGIN` | The origin in the 402 quote. The default is `https://clankerbanker.ca`. |
| `LLM_BASE_URL`, `LLM_MODEL` | An OpenAI-compatible chat endpoint for `/ask` and `/roast`. Without them, those routes answer 503. |
| `LLM_API_KEY` | Sent as `Authorization: Bearer`. Leave it unset for an endpoint with no key. |
| `BASE_RPC_URL` | The default is `https://mainnet.base.org`. |
| `SOLANA_RPC_URL` | The default is `https://api.mainnet-beta.solana.com`. |

## Code

- `src/prices.ts` holds the paid routes and their prices. The paywall and the
  landing page both read it.
- A handler runs after verify and before settle. A 4xx or 5xx response from a
  handler cancels the payment, so the payer pays nothing for it.
- `src/mcp.ts` serves the paid tools over MCP at `POST /mcp`.

## Test

```bash
bun test
bun run typecheck
bun run lint
```

The tests use a fake facilitator, a fake `/chat/completions` and a fake
JSON-RPC node. Nothing leaves the process.

## Deploy

kthx built apps builds `Dockerfile` as `spindrift.yaml` declares, and runs the
app on the `offsite` cluster behind the `spindrift-apps` Gateway in
`clusters/offsite/apps/spindrift/gateway.yaml`. No manifest for the app is in
`clusters/`. The DNS zone is `terraform/network/cloudflare/clankerbanker.ca.tf`.
