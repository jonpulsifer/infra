"""Reconcile: give parsed rows a ledger identity.

Three modules, each a pure function over tuples:

- `dedupe.find_duplicates(existing, incoming, window_days=3)`: tier 1 FITID,
  tier 2 multiset fuzzy match on exact cents within the window, each existing
  row used once. Returns DuplicateFindings keyed to incoming rows.
- `transfers.propose(transactions, window_days=4)`: opposite signs, equal
  cents, different accounts, within the window. Unique on both sides is
  auto-accepted; otherwise a TransferFinding asks.
- `balances.check(transactions, assertions)`: running totals against dated
  assertions; a failure yields a signed difference and a MissingPeriodFinding
  spanning from the last assertion that held to the one that did not.

The research behind the numbers is .agent/wayfinder/tally/assets/07-dedupe-and-transfers.md.
"""
