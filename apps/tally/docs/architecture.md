# tally architecture

tally reads bank exports and statements, folds them into one ledger, and
serves that ledger to a web app. The engine is pure. The CLI and the server
are its only shells, and only they do I/O.

## Module map

| Module | Role |
| --- | --- |
| `model.py` | The nouns, frozen pydantic models. `web/src/fixtures/types.ts` mirrors them. |
| `parsers/` | A file in, a `ParsedFile` out. `parse(path)` sniffs and dispatches in the order `csv_`, `ofx`, `xlsx`, `pdf`. |
| `parsers/profiles/` | CSV layouts (`ynab`, `scotiabank`, `generic`), matched by header or column shape. |
| `parsers/statements/` | PDF statement families. Each one turns positioned words into rows, balance assertions and holdings snapshots. |
| `reconcile/` | `identity` (transaction ids, dedupe keys), `dedupe`, `transfers`, `balances`. Pure functions over models. |
| `classify/` | `base.Cascade` and the `Classifier` protocol, `rules`, `taxonomy`, `cascade.build` (rules, then memory, then a provider), and `providers/` (`openai_api`, `codex`, `fake`). |
| `engine.py` | The contract: `preview(files, ledger, classifier)` and `apply(ledger, preview, decisions)`. `engine_impl.py` implements it. |
| `report.py` | The dashboard aggregates, a port of `web/src/fixtures/derive.ts`. |
| `fx.py` | The one rate table: a US-dollar account (a Shareworks plan) converts in the reports at the Bank of Canada annual average for the year. Rows and snapshots stay in their account's currency. |
| `synthetic.py` | The seeded synthetic ledger, a port of `web/src/fixtures/generate.ts`. Tests and the demo use it. |
| `cli.py`, `config.py`, `store/` | The local shell: `inventory`, `preview`, `push`, `load`, `report`, `rules` and `serve`, with a SQLite cache of rules, model answers, loaded files and account decisions. |
| `load.py`, `files.py` | `tally load`: the walk (identity exclusions, zips one level deep), the load order (a YNAB register first), the account decision per file from the rows it overlaps, preview and apply through the server, and the report of what disagrees. |
| `server/` | The hosted shell: a FastAPI app, sealed rows in SQLite or Postgres, tailnet identity, and the built SPA. |
| `web/` | The Vite React reader. It falls back to the synthetic ledger on `?synthetic=1`. |

A preview carries everything `apply` needs: new transactions, findings
(duplicates, transfers, missing periods, low confidence), the statement
balance assertions and holdings snapshots, and the exact strings sent to a
model. `apply` folds it in as the owner decided. It never re-adds a
tombstoned or existing id, and applying the same preview twice changes
nothing.

Account numbers never become ids. A hint from a file that is not already a
ledger account id becomes `acct_<sha12>`. A file that names no account holds
its rows under `unassigned:<file>`, and `apply` refuses it until
`account_for_file` names the account.

A file the owner categorised by hand (a YNAB register) carries its categories
as `ParsedRow.tags`. The preview keeps each tagged row's category as a manual
choice, lists the categories the ledger's tree lacks as `new_categories`, and
seeds one rule per payee the tags categorise consistently as `seed_rules`;
the preview's untagged rows already match those rules. `apply` folds both in.
A new ledger starts with the seed tree in `classify/taxonomy.py`.

## The privacy line

A classifier receives a `Request`: one descriptor string and an optional
account kind. It never gets an amount, a date, a balance or an account id.
The engine sends each unique string once and drops these before asking:

- strings a ledger rule already answers;
- the legs of auto-paired transfers;
- duplicate rows, which take the matched row's category;
- strings the owner withholds (`preview(..., withhold=)`, `tally preview --withhold`).

A provider records each batch in the audit log before sending it. Memory
answers a string it has already seen, and `apply` caches each confident
answer as a rule with `created_from="model"`. `outbound_strings` on the
preview lists exactly what left or would leave the process. With `--dry-run`,
nothing is sent.

## Encryption

The server seals each row with AES-256-GCM under a per-ledger data key
(`server/crypto.py`). A versioned master key from `TALLY_KEYRING` or
`TALLY_KEYRING_FILE` wraps the data key. A row's associated data binds the
ledger, table, column and row id. A wrapped key's associated data binds the
ledger, the key's purpose and the master version.

The plaintext columns are ids, batch ids, roles and server event timestamps,
plus two HMAC tokens: a full-width dedupe token and a 12-bit merchant token.
Reports run in the app over the decrypted ledger. `repo.rotate(version)`
rewraps the keys and leaves every row unchanged. The design is in
`.agent/wayfinder/tally/assets/06-encryption-on-cnpg.md`.

## Identity

`server/identity.py` takes the login from the `Tailscale-User-Login` header
that the tailnet proxy sets. It refuses requests from tagged nodes. A bearer
token that the owner mints acts as the owner for the CLI, but it cannot mint
tokens or change members. Logins in `TALLY_OWNERS` get a ledger the first
time they are seen. `X-Tally-Ledger` picks among a login's memberships, and
viewers get 403 on every write.

The header is trusted only because the proxy is the only route to the pod. The
cluster's CiliumNetworkPolicy and tailscale Ingress enforce that. In synthetic
mode the seeded owner is the dev login, so local requests need no header.
`tally serve` binds a dev login to loopback only, unless
`TALLY_ALLOW_DEV_LOGIN=1`. Writes a browser marks as cross-site
(`Sec-Fetch-Site`) get 403, because the identity header is per node rather
than a cookie. The OpenAPI docs are served in synthetic mode only.

## Run

From `apps/tally`:

```sh
mise run tally:test                                   # ruff, format check, mypy, pytest
mise run tally:dev                                    # API and built SPA on :8081, synthetic ledger
bun run --cwd web dev                                 # Vite on :5180, proxies /api to :8081
bun run --cwd web build                               # web/dist, served by the API at /
uv run tally inventory ~/finance                      # shapes and counts, never a value
uv run tally preview --synthetic --dry-run FILES...   # what an import would do and send
uv run tally rules seed-ynab Register.csv             # seed rules from a YNAB register
mise run tally:ocr                                    # Docling and its models, so load reads scans
mise run tally:load -- --dry-run                      # what loading ~/finance would do
mise run tally:load                                   # load it, once; exit 3 on a discrepancy
```

Without `--synthetic`, the server needs `TALLY_DATABASE_URL` and a keyring.
