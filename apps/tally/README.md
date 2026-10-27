# tally

A privacy-first household ledger. Import bank exports (CSV, QFX, OFX) and
investment statements (PDF), reconcile them against what the ledger already
holds, classify merchants, and read the result: net worth over time, spend by
category, top merchants, cash flow, and where the money went.

## Layout

| Path | What |
| --- | --- |
| `src/tally/model.py` | The nouns. Mirrors `web/src/fixtures/types.ts`. |
| `src/tally/parsers/` | File to `ParsedFile`. `ofx.py` wraps ofxtools; `csv_.py` holds the profile registry matched by column fingerprint; `pdf.py` needs the `ocr` extra. |
| `src/tally/reconcile/` | `dedupe.py`, `transfers.py`, `balances.py`. Pure functions. |
| `src/tally/classify/` | `base.py` is the interface and the `Cascade`; `rules.py`; `providers/` talk to models and see descriptor strings only. |
| `src/tally/engine.py` | `preview()` and `apply()`: the two functions both shells call. |
| `src/tally/report.py` | The dashboard aggregates. Mirrors `web/src/fixtures/derive.ts`. |
| `src/tally/synthetic.py` | The deterministic synthetic ledger, a port of `web/src/fixtures/generate.ts`. Tests and the demo use it. |
| `src/tally/cli.py` | `tally inventory`, `tally preview`, `tally report`, `tally rules`, `tally push`. |
| `src/tally/store/` | The CLI's SQLite cache. |
| `src/tally/server/` | FastAPI: the API, sealed rows on Postgres, tailnet identity, and the built SPA. |
| `web/` | The Vite React app. |
| `tests/` | pytest. |

## Run

```sh
mise run tally:test        # ruff, mypy, pytest
mise run tally:dev         # API on :8081 with the synthetic ledger, web on :5180
uv run --directory apps/tally tally preview ~/finance/raw/rbc/*.qfx
```

## The privacy line

A model sees merchant descriptor strings and nothing else: no amount, date,
balance or account number. Each unique string is sent once and the answer is
cached as a rule. `tally preview` prints the exact strings that would leave
the machine before anything does, and `--withhold` keeps any of them back.
PDFs are read locally.

## Encryption

Rows are sealed in the application (AES-256-GCM, one payload per row, a
per-ledger data key wrapped by a versioned master key) before they reach
Postgres. The database holds ids, batch ids and HMAC tokens for dedupe and
merchant lookup. Dashboards aggregate in the app.
