# tally UI prototype

Six variants of the whole tally app on one route, switchable with
`?variant=a..f` and the floating bar at the bottom (← and → keys work too).
`?theme=dark` forces dark mode; the default follows the OS.

The owner chose **f, Reader and inspector** (2026-10-27) after two rounds:
a (Desk), b (Editorial), c (Questions), then the fusions d (Desk, written),
e (Hero desk) and f. The others stay for comparison.

Run it: `bun run --cwd apps/tally/web dev`, then open
http://localhost:5180/?variant=f

Each variant is a self-contained app under `src/variants/<key>/` with a
default export `{ name, Component }`. Variants share only the fixtures in
`src/fixtures/` (synthetic data, deterministic seed) and the derivations in
`src/fixtures/derive.ts`. They must not share layout.

Every variant renders the same jobs:

1. Dashboard: net worth over time (house, mortgage, holdings, cash), monthly
   spend by category, top merchants for a period, monthly cash flow, and the
   income-to-category Sankey.
2. Transactions: the ledger with search, category and account filters,
   transfer pairs shown as one thing, and an inline recategorise that offers
   "always do this" (a rule).
3. Import: bulk upload, the preview with findings (duplicates, missing
   periods, transfer candidates, low-confidence merchants, the strings that
   would leave the lab), review and accept.
4. Accounts and holdings: per-account balance history; for an investment
   account the positions at the latest statement; for the house its
   valuations.

This is throwaway code that answers "what should tally look like". No tests,
no persistence, no network.
