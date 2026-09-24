---
title: clankerbanker
description: A public pay-per-call API at clankerbanker.ca, a kthx built app on offsite, that sells fortunes, dice rolls, storage and model answers to bots for USDC over x402.
status: live
---

clankerbanker is a public web API at `clankerbanker.ca` that charges bots for each call. It runs on the offsite cluster as a [kthx built app](kthx/built-apps.md). A paid route answers HTTP 402 until the caller pays in USDC, a dollar stablecoin, on the Base or Solana blockchain. The caller pays through [x402](https://x402.org), a protocol that carries a payment in HTTP headers. Its web page, Banque Clanker, shows the prices and a public ledger of every x402 payment.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web page | `https://clankerbanker.ca` | Anyone |
| Ledger | `https://clankerbanker.ca/ledger` | Anyone |
| Paid routes | `https://clankerbanker.ca/<route>` | Anyone who pays |
| Model Context Protocol (MCP) server | `POST https://clankerbanker.ca/mcp` | Any MCP client that pays for each tool call |

`apps/clankerbanker/src/prices.ts` lists each route, its price and what it returns. The page and the paywall both read that table. A call without a payment returns 402 and the quote.

```bash
curl -si https://clankerbanker.ca/fortune
```

A person can also scan a QR code on the web page and send USDC from a phone. Those deposits do not appear on the ledger.

## Limits

- If a route handler returns 4xx or 5xx, the payment is cancelled, and the caller pays nothing.
- `POST /account` sells a 24-hour bearer token that skips the paywall. It does not cover `/account`, `/ask`, `/roast`, `PUT /kv` or `GET /tip/:name/:amount`.
- `/ask` and `/roast` need an OpenAI-compatible model endpoint in `LLM_BASE_URL` and `LLM_MODEL`. Without one, they answer 503 before payment.
- `PUT /kv/:key` stores up to 4 KiB for each payer and key.

## How it works

clankerbanker is a Bun and Hono service. The x402 middleware puts the quote in the `PAYMENT-REQUIRED` header, and the PayAI facilitator verifies and settles each payment on chain. `PAY_TO_EVM` and `PAY_TO_SOLANA` name the receiving addresses. If neither is set, every paid route answers 503.

kthx builds the app from `apps/clankerbanker/` and its `spindrift.yaml`, and runs it as Deployment `clankerbanker-web` in namespace `app-clankerbanker`. Auto-deploy is off on the App, so a merge does not deploy. Start a Build on the App in kthx. kthx keeps the settings as App config in Secret Manager. The ledger, the stored values and the bearer tokens are in the kthx Datastore `clankerbanker`, a CloudNativePG cluster in namespace `spindrift-datastores`.

Cloudflare holds the `clankerbanker.ca` zone. The [kthx Apps tunnel](../platform/network/ingress-and-dns.md#public-names) carries the apex and `*.clankerbanker.ca` to the offsite Apps Gateway. `www` redirects to the apex.

## Operate

No alerts watch clankerbanker. `GET /healthz` returns `ok`.

## Reference

- Source: `apps/clankerbanker/`
- Zone: `terraform/network/cloudflare/clankerbanker.ca.tf`
- Tunnel rules: `terraform/network/cloudflare/spindrift.tf`
- Gateway listener: `clusters/offsite/apps/spindrift/gateway.yaml`
