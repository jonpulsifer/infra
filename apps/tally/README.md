# tally

A privacy-first household ledger. Import bank exports (CSV, QFX, OFX, XLSX) and
statements (PDF), reconcile them against what the ledger already
holds, classify merchants, and read the result: net worth over time, spend by
category, top merchants, cash flow, and where the money went.

## Layout

| Path | What |
| --- | --- |
| `src/tally/model.py` | The nouns. Mirrors `web/src/fixtures/types.ts`. |
| `src/tally/parsers/` | File to `ParsedFile`. `ofx.py` wraps ofxtools; `csv_.py` holds the profile registry in `profiles/`; `xlsx.py` reads Questrade activity exports; `pdf.py` dispatches to the families in `statements/`, and only scanned PDFs need the `ocr` extra. |
| `src/tally/reconcile/` | `identity.py`, `dedupe.py`, `transfers.py`, `balances.py`. Pure functions. |
| `src/tally/classify/` | `base.py` is the interface and the `Cascade`; `rules.py`; `providers/` talk to models and see descriptor strings only. |
| `src/tally/engine.py` | `preview()` and `apply()`: the two functions both shells call. `engine_impl.py` implements them. |
| `src/tally/report.py` | The dashboard aggregates. Mirrors `web/src/fixtures/derive.ts`. |
| `src/tally/synthetic.py` | The deterministic synthetic ledger, a port of `web/src/fixtures/generate.ts`. Tests and the demo use it. |
| `src/tally/cli.py` | `tally inventory`, `tally preview`, `tally push`, `tally load`, `tally report`, `tally rules`, `tally serve`. |
| `src/tally/load.py`, `src/tally/files.py` | `tally load`: walk a directory, open zips, order the sources, decide each file's account from the rows it overlaps, preview and apply through the server, and report what disagrees. |
| `src/tally/store/` | The CLI's SQLite cache. |
| `src/tally/server/` | FastAPI: the API, sealed rows on Postgres, tailnet identity, and the built SPA. |
| `web/` | The Vite React app. |
| `tests/` | pytest. |
| `./docs/architecture.md` | The module map, the privacy line, encryption, identity, and how to run it. |

## Run

```sh
mise run tally:test        # ruff, mypy, pytest
mise run tally:dev         # API and built SPA on :8081 with the synthetic ledger
bun run --cwd apps/tally/web dev    # web on :5180, proxying /api to :8081
uv run --directory apps/tally tally inventory ~/finance
uv run --directory apps/tally tally preview --dry-run ~/finance/raw/rbc/*.qfx
mise run tally:load -- --dry-run     # decide and report against a copy of the live ledger
mise run tally:load                  # load ~/finance into the live ledger, once
```

`tally load` is idempotent: a file already loaded is skipped by its hash and
a row already held is never added twice. It needs a bearer token the owner
minted in the app (`token_command` in `~/.config/tally/config.toml`). It
exits 3 when something needs the owner: an account whose rows do not sum to
the balances its statements assert, or a file whose account it could not
decide (`--account FILE=ACCOUNT_ID` settles it). Files it could not read
are listed with the reason.

## The privacy line

A model sees merchant descriptor strings and nothing else: no amount, date,
balance or account number. Card, account and reference numbers inside a
descriptor are replaced before it goes (`classify/egress.py`). Each unique
string is sent once and the answer is cached as a rule. `tally preview` prints the exact strings that would leave
the machine before anything does, and `--withhold` keeps any of them back.
PDFs are read locally.

## Encryption

Rows are sealed in the application (AES-256-GCM, one payload per row, a
per-ledger data key wrapped by a versioned master key) before they reach
Postgres. The database holds ids, batch ids and HMAC tokens for dedupe and
merchant lookup. Dashboards aggregate in the app.
[The architecture page](./docs/architecture.md) has the identity model too.
