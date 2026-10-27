from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from tally.classify.base import Result
from tally.model import (
    Account,
    AccountKind,
    Category,
    Flow,
    Ledger,
    Member,
    Rule,
    Source,
    Transaction,
)
from tally.store import MIGRATIONS, Answer, Store

AT = datetime(2030, 1, 2, 3, 4, 5, tzinfo=UTC)


def _ledger(ledger_id: str = "home") -> Ledger:
    return Ledger(
        id=ledger_id,
        members=(Member(login="owner@example.com", role="owner"),),
        accounts=(
            Account(
                id="chq",
                name="Everyday",
                institution="Example Bank",
                kind=AccountKind.chequing,
                since=date(2030, 1, 1),
            ),
        ),
        categories=(Category(id="groceries", name="Groceries", parent_id=None, flow=Flow.expense),),
        transactions=(
            Transaction(
                id="t1",
                account_id="chq",
                date=date(2030, 1, 3),
                amount=Decimal("-12.34"),
                descriptor="CORNER BAKERY 12",
                merchant="Corner Bakery",
                category_id="groceries",
                batch_id="b1",
            ),
        ),
    )


def test_migrations_set_the_version_and_reapply_as_a_no_op(tmp_path):
    path = tmp_path / "nested" / "tally.db"
    with Store.open(path) as store:
        assert store.version == len(MIGRATIONS)
        store.put_rules(
            [Rule(id="r", match="bakery", category_id="g", merchant="B", created_from="seed")]
        )
    with Store.open(path) as store:
        assert store.version == len(MIGRATIONS)
        assert [r.id for r in store.rules()] == ["r"]


def test_a_later_migration_runs_on_an_older_database(tmp_path, monkeypatch):
    path = tmp_path / "tally.db"
    Store.open(path).close()
    import tally.store.sqlite as mod

    monkeypatch.setattr(mod, "MIGRATIONS", (*MIGRATIONS, "CREATE TABLE extra (x INTEGER);"))
    with Store.open(path) as store:
        assert store.version == len(MIGRATIONS) + 1
        store.conn.execute("INSERT INTO extra VALUES (1)")


def test_rules_round_trip_and_replace_by_id():
    store = Store(sqlite3.connect(":memory:"))
    first = Rule(
        id="r1",
        match="/^ACME\\b/",
        category_id="hardware",
        merchant="Acme",
        created_from="correction",
        account_id="chq",
        hits=3,
    )
    other = Rule(
        id="r2", match="bakery", category_id="groceries", merchant="Bakery", created_from="seed"
    )
    assert store.put_rules([first, other]) == 2
    assert store.rules() == [first, other]
    store.put_rules([first.model_copy(update={"hits": 9})])
    assert [r.hits for r in store.rules()] == [9, 0]


def test_answers_round_trip_and_replay_as_rules():
    store = Store(sqlite3.connect(":memory:"))
    res = Result("MOONLIGHT CINEMA", "fun", "Moonlight", 0.91, Source.model, "fake")
    store.put_answers([Answer.of(res, "fake", AT)])
    got = store.answers()["MOONLIGHT CINEMA"]
    assert got == Answer("MOONLIGHT CINEMA", "fun", "Moonlight", 0.91, "fake", AT)
    (replayed,) = store.remembered()
    assert (replayed.category_id, replayed.source, replayed.layer) == ("fun", Source.rule, "store")


def test_outbound_batches_keep_order_and_strings():
    store = Store(sqlite3.connect(":memory:"))
    a = store.record_outbound("fake", "fake-1", ["A", "B"])
    b = store.record_outbound("codex", "gpt-x", ["C"])
    assert a < b
    batches = store.outbound()
    assert [(x.provider, x.model, x.strings) for x in batches] == [
        ("fake", "fake-1", ("A", "B")),
        ("codex", "gpt-x", ("C",)),
    ]


def test_files_are_seen_per_action():
    store = Store(sqlite3.connect(":memory:"))
    store.mark_file("abc", "previewed")
    assert store.seen("abc", "previewed")
    assert not store.seen("abc", "pushed")
    store.mark_file("abc", "pushed", "p-1")
    assert store.seen("abc", "pushed")


def test_snapshot_round_trips_the_latest_ledger():
    store = Store(sqlite3.connect(":memory:"))
    assert store.snapshot() is None
    store.save_snapshot(_ledger("home"))
    store.save_snapshot(_ledger("dad"))
    assert store.snapshot("home") == _ledger("home")
    assert store.snapshot() is not None


@given(st.text(min_size=1), st.floats(min_value=0, max_value=1, allow_nan=False))
def test_any_descriptor_round_trips(descriptor, confidence):
    store = Store(sqlite3.connect(":memory:"))
    store.put_answers([Answer(descriptor, "c", "m", confidence, "fake", AT)])
    assert store.answers()[descriptor].confidence == confidence
