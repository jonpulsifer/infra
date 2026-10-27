import hashlib
from collections import defaultdict
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.synthetic import (
    PREVIEW_FROM,
    build_ledger,
    build_preview,
    build_preview_files,
    js_round,
    mulberry32,
    round2,
)

# Values computed by running web/src/fixtures/generate.ts under bun.
TS_GOLDEN = {
    1337: {
        "transactions": 4875,
        "txn_digest": "f9cdd0f51a5e40264d196ff79e7530224157824eb9e52c62bf5482ca10dc65ea",
        "holdings_digest": "8e91f15a1aae525a42e97574a0e292ac4d424f7d7b08d965053889b2f1651b5b",
        "preview": (59, 55, 2, [11, 31, 15, 2]),
    },
    7: {
        "transactions": 4873,
        "txn_digest": "3a884885a29d0c7f071016c03d131b307340439b66e16b3a8508a1274a82d591",
        "holdings_digest": "1f64d7a345a89cdd998da2b300a5c426e3c7ac543ec71300e2ef3204db71d136",
        "preview": (61, 61, 0, [11, 29, 19, 2]),
    },
}


def _digest(lines):
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def test_mulberry32_matches_javascript():
    rnd = mulberry32(1337)
    assert [rnd() for _ in range(4)] == [
        0.1844118325971067,
        0.18998925131745636,
        0.8104719922412187,
        0.6437488221563399,
    ]


@given(st.integers(min_value=0, max_value=2**32 - 1))
def test_mulberry32_stays_in_unit_interval(seed):
    rnd = mulberry32(seed)
    assert all(0 <= rnd() < 1 for _ in range(8))


def test_js_round_ties_go_up():
    assert js_round(2.5) == 3
    assert js_round(-2.5) == -2
    assert round2(1.005) == 1.0  # 1.005 * 100 is 100.49999999999999 in binary, as in JS


@pytest.mark.parametrize("seed", sorted(TS_GOLDEN))
def test_ledger_matches_the_web_fixture(seed):
    golden = TS_GOLDEN[seed]
    ledger = build_ledger(seed)
    txns = [
        f"{t.id},{t.account_id},{t.date},{t.amount},{t.category_id},{t.transfer_id or ''}"
        for t in ledger.transactions
    ]
    holdings = [f"{h.account_id},{h.date},{h.total}" for h in ledger.holdings]
    assert len(ledger.transactions) == golden["transactions"]
    assert _digest(txns) == golden["txn_digest"]
    assert _digest(holdings) == golden["holdings_digest"]
    assert (len(ledger.accounts), len(ledger.categories), len(ledger.rules)) == (9, 34, 33)
    assert (len(ledger.holdings), len(ledger.assertions), len(ledger.batches)) == (46, 53, 6)


@pytest.mark.parametrize("seed", sorted(TS_GOLDEN))
def test_static_preview_matches_the_web_fixture(seed):
    new, rules_hit, model_calls, rows = TS_GOLDEN[seed]["preview"]
    p = build_preview(seed)
    assert (len(p.new_transactions), p.rules_hit, p.model_calls) == (new, rules_hit, model_calls)
    assert [f.rows for f in p.files] == rows
    assert len(p.outbound_strings) == model_calls


def test_same_seed_same_ledger():
    assert build_ledger(42) == build_ledger(42)
    assert build_ledger(42) != build_ledger(43)


def test_every_transfer_has_two_opposite_legs():
    legs = defaultdict(list)
    for t in build_ledger().transactions:
        if t.transfer_id:
            legs[t.transfer_id].append(t)
    assert legs
    for pair in legs.values():
        assert len(pair) == 2
        assert pair[0].amount + pair[1].amount == 0
        assert pair[0].account_id != pair[1].account_id


def test_batches_count_their_rows():
    ledger = build_ledger()
    assert sum(b.rows for b in ledger.batches) == len(ledger.transactions)
    assert all(t.amount == t.amount.quantize(Decimal("0.01")) for t in ledger.transactions)


def test_before_drops_the_preview_month():
    full, base = build_ledger(), build_ledger(before=PREVIEW_FROM)
    assert all(t.date < PREVIEW_FROM for t in base.transactions)
    october = len(full.transactions) - len(base.transactions)
    assert october == len(build_preview().new_transactions)
    assert sum(b.rows for b in base.batches) == len(base.transactions)


def test_preview_files_agree_with_the_static_preview():
    files = build_preview_files()
    static = build_preview()
    assert [f.name for f in files] == [f.name for f in static.files]
    counts = [len(f.rows) or sum(len(h.positions) for h in f.holdings) for f in files]
    assert counts == [f.rows for f in static.files]
    td = next(f for f in files if f.name == "td-visa-download.csv")
    assert td.account_hint is None
    assert all(r.account_hint is None for r in td.rows)
    qfx = next(f for f in files if f.format == "qfx")
    assert all(r.fitid for r in qfx.rows)
    assert len({f.sha256 for f in files}) == len(files)
