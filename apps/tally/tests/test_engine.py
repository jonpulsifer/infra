from dataclasses import fields
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

import tally.parsers
import tally.reconcile.balances
from tally import engine_impl
from tally.classify.base import Request, Result
from tally.engine import Decisions, apply, preview
from tally.engine_impl import EngineError, minted_account_id, placeholder
from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    Category,
    DuplicateFinding,
    Flow,
    HoldingSnapshot,
    Ledger,
    LowConfidenceFinding,
    Member,
    MissingPeriodFinding,
    ParsedFile,
    ParsedRow,
    Position,
    Rule,
    Source,
    Transaction,
    TransferFinding,
)
from tally.reconcile.identity import transaction_id
from tally.synthetic import PREVIEW_FROM, build_ledger, build_preview, build_preview_files

D = Decimal
CATS = (
    Category(id="food", name="Food", parent_id=None, flow=Flow.expense),
    Category(id="groceries", name="Groceries", parent_id="food", flow=Flow.expense),
    Category(id="coffee", name="Coffee", parent_id="food", flow=Flow.expense),
    Category(id="shopping", name="Shopping", parent_id=None, flow=Flow.expense),
    Category(id="transfer", name="Transfer", parent_id=None, flow=Flow.transfer),
    Category(id="uncategorized", name="Uncategorized", parent_id=None, flow=Flow.expense),
)
RULE = Rule(
    id="r1", match="grocer", category_id="groceries", merchant="Grocer", created_from="seed"
)


def account(id_, kind):
    return Account(id=id_, name=id_, institution="Test", kind=kind, since=date(2030, 1, 1))


def make_ledger(transactions=(), rules=(RULE,)):
    return Ledger(
        id="t",
        members=(Member(login="owner@example.com", role="owner"),),
        accounts=(account("chq", AccountKind.chequing), account("card", AccountKind.credit)),
        categories=CATS,
        transactions=tuple(transactions),
        rules=tuple(rules),
    )


def row(on, amount, descriptor, fitid=None, hint=None):
    return ParsedRow(
        account_hint=hint, date=on, amount=D(amount), descriptor=descriptor, fitid=fitid
    )


def parsed(name, rows, hint="card", fmt="csv", institution="Test", assertions=()):
    return ParsedFile(
        name=name,
        format=fmt,
        institution=institution,
        account_hint=hint,
        rows=tuple(r.model_copy(update={"account_hint": r.account_hint or hint}) for r in rows),
        assertions=tuple(assertions),
        sha256=name.encode().hex().ljust(64, "0")[:64],
        date_from=min((r.date for r in rows), default=None),
        date_to=max((r.date for r in rows), default=None),
    )


def existing(id_, acct, on, amount, descriptor, category="groceries", fitid=None):
    return Transaction(
        id=id_,
        account_id=acct,
        date=on,
        amount=D(amount),
        descriptor=descriptor,
        merchant=descriptor.title(),
        category_id=category,
        batch_id="b0",
        fitid=fitid,
    )


class Stub:
    """A classifier stand-in: answers from a table and logs what it was asked, as Cascade does."""

    name = "stub"

    def __init__(self, answers=None, *, log=True):
        self.answers = answers or {}
        self.requests: list[Request] = []
        if log:
            self.outbound: list[str] = []

    def classify(self, requests, taxonomy):
        self.requests.extend(requests)
        if hasattr(self, "outbound"):
            self.outbound.extend(sorted({r.descriptor for r in requests}))
        out = []
        for r in requests:
            hit = self.answers.get(r.descriptor)
            out.append(
                None
                if hit is None
                else Result(r.descriptor, hit[0], hit[0].title(), hit[1], Source.model)
            )
        return out


JAN = date(2030, 1, 10)


def test_rules_first_then_each_unique_string_once_with_nothing_else():
    rows = [
        row(JAN, "-12.00", "GROCER 0042"),
        row(date(2030, 1, 11), "-14.00", "GROCER 0042"),
        row(JAN, "-4.00", "NEW CAFE"),
        row(date(2030, 1, 12), "-5.00", "NEW CAFE"),
        row(JAN, "-30.00", "ODD SHOP"),
    ]
    stub = Stub({"NEW CAFE": ("coffee", 0.95), "ODD SHOP": ("shopping", 0.5)})
    p = preview([parsed("card.csv", rows)], make_ledger(), stub)
    assert [type(r) for r in stub.requests] == [Request, Request]
    assert {f.name for f in fields(Request)} == {"descriptor", "account_kind"}
    assert [(r.descriptor, r.account_kind) for r in stub.requests] == [
        ("NEW CAFE", "credit"),
        ("ODD SHOP", "credit"),
    ]
    assert p.outbound_strings == ("NEW CAFE", "ODD SHOP")
    assert (p.rules_hit, p.model_calls) == (2, 2)
    cats = {t.descriptor: (t.category_id, t.source) for t in p.new_transactions}
    assert cats["GROCER 0042"] == ("groceries", Source.rule)
    assert cats["NEW CAFE"] == ("coffee", Source.model)
    low = [f for f in p.findings if isinstance(f, LowConfidenceFinding)]
    assert [(f.suggested_category_id, f.confidence) for f in low] == [("shopping", 0.5)]


def test_threshold_and_unanswered_rows_raise_findings():
    rows = [row(JAN, "-4.00", "NEW CAFE"), row(JAN, "-9.00", "NOBODY KNOWS")]
    stub = Stub({"NEW CAFE": ("coffee", 0.95)})
    p = preview([parsed("card.csv", rows)], make_ledger(), stub, threshold=0.99)
    low = {f.transaction_id: f for f in p.findings if isinstance(f, LowConfidenceFinding)}
    by_desc = {t.descriptor: t for t in p.new_transactions}
    assert low[by_desc["NEW CAFE"].id].suggested_category_id == "coffee"
    unknown = low[by_desc["NOBODY KNOWS"].id]
    assert (unknown.suggested_category_id, unknown.confidence) == ("uncategorized", 0.0)
    assert by_desc["NOBODY KNOWS"].category_id == "uncategorized"


def test_withheld_strings_never_reach_the_classifier():
    rows = [row(JAN, "-4.00", "PRIVATE CLINIC"), row(JAN, "-5.00", "NEW CAFE")]
    stub = Stub()
    p = engine_impl.preview(
        [parsed("card.csv", rows)], make_ledger(), stub, withhold={"PRIVATE CLINIC"}
    )
    assert [r.descriptor for r in stub.requests] == ["NEW CAFE"]
    assert "PRIVATE CLINIC" not in p.outbound_strings


def test_a_classifier_without_a_log_reports_every_string_it_was_given():
    stub = Stub(log=False)
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "NEW CAFE")])], make_ledger(), stub)
    assert p.outbound_strings == ("NEW CAFE",)


def test_nothing_is_asked_when_rules_cover_everything():
    stub = Stub()
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "GROCER")])], make_ledger(), stub)
    assert stub.requests == []
    assert (p.outbound_strings, p.model_calls) == ((), 0)


def test_fuzzy_duplicates_are_flagged_and_dropped_only_on_accept():
    old = existing("old", "card", JAN, "-12.34", "SHOP A", category="shopping")
    led = make_ledger([old])
    shifted = row(date(2030, 1, 11), "-12.34", "SHOP A")
    p = preview([parsed("card.csv", [shifted])], led, Stub())
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    assert (dup.matches_id, dup.tier) == ("old", "fuzzy")
    (t,) = p.new_transactions
    assert (t.id, t.category_id) == (dup.transaction_id, "shopping")
    assert p.outbound_strings == ()
    kept = apply(led, p, Decisions())
    assert len(kept.transactions) == 2
    dropped = apply(led, p, Decisions(accept_findings=frozenset({dup.id})))
    assert [t.id for t in dropped.transactions] == ["old"]


def test_a_replaced_row_gives_way_and_the_incoming_keeps_its_category_and_transfer():
    old = existing("old", "card", JAN, "-12.34", "SHOP A", category="shopping").model_copy(
        update={"transfer_id": "xf1", "tags": ("ynab:Fun/Shops",)}
    )
    led = make_ledger([old])
    posted = row(date(2030, 1, 12), "-12.34", "SHOP A 0042")
    p = preview([parsed("stmt.pdf", [posted], fmt="pdf")], led, Stub())
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    after = apply(led, p, Decisions(replace_findings=frozenset({dup.id})))
    (t,) = after.transactions
    assert t.id == dup.transaction_id and t.date == date(2030, 1, 12)
    assert (t.category_id, t.transfer_id, t.tags) == ("shopping", "xf1", ("ynab:Fun/Shops",))
    # the retired row never comes back: the same preview applied again changes nothing
    again = apply(
        after, preview([parsed("stmt.pdf", [posted], fmt="pdf")], after, Stub()), Decisions()
    )
    assert [x.id for x in again.transactions] == [t.id]
    # a replacement is not a drop: the same finding accepted instead keeps the old row
    dropped = apply(led, p, Decisions(accept_findings=frozenset({dup.id})))
    assert [x.id for x in dropped.transactions] == ["old"]


def test_an_authoritative_statement_retires_the_rows_of_its_span_it_does_not_list():
    listed = existing("listed", "card", date(2030, 1, 5), "-20.00", "SHOP A", category="shopping")
    phantom = existing("phantom", "card", date(2030, 1, 9), "-7.00", "NOT ON STATEMENT")
    partner = existing("partner", "chq", date(2030, 1, 9), "7.00", "TRANSFER IN")
    phantom = phantom.model_copy(update={"transfer_id": "xf9"})
    partner = partner.model_copy(update={"transfer_id": "xf9"})
    outside = existing("outside", "card", date(2030, 2, 9), "-9.00", "LATER")
    led = make_ledger([listed, phantom, partner, outside])
    stmt = parsed(
        "jan.pdf",
        [row(date(2030, 1, 6), "-20.00", "SHOP A 0042")],
        fmt="pdf",
        assertions=[
            BalanceAssertion(
                account_id="card", date=date(2030, 1, 31), balance=D("-20.00"), origin="jan.pdf"
            )
        ],
    )
    stmt = stmt.model_copy(update={"date_from": date(2030, 1, 1), "date_to": date(2030, 1, 31)})
    p = preview([stmt], led, Stub())
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    after = apply(
        led,
        p,
        Decisions(replace_findings=frozenset({dup.id}), authoritative_files=frozenset({"jan.pdf"})),
    )
    ids = {t.id for t in after.transactions}
    assert "phantom" not in ids and "listed" not in ids
    assert {"partner", "outside", dup.transaction_id} <= ids
    # a ledger row the statement holds under the very same id is listed, not retired
    same = row(date(2030, 1, 20), "-3.00", "PAYMENT THANK YOU")
    same_id = transaction_id("card", same.date, -300, same.descriptor)
    held = existing(same_id, "card", same.date, "-3.00", "PAYMENT THANK YOU")
    led2 = make_ledger([listed, phantom, held])
    stmt2 = stmt.model_copy(update={"rows": (*stmt.rows, same)})
    p2 = preview([stmt2], led2, Stub())
    assert same_id in p2.held_ids
    after2 = apply(led2, p2, Decisions(authoritative_files=frozenset({"jan.pdf"})))
    ids2 = {t.id for t in after2.transactions}
    assert same_id in ids2 and "phantom" not in ids2
    assert next(t for t in after.transactions if t.id == "partner").transfer_id is None
    # without the authority, the unlisted row stays
    kept = apply(led, p, Decisions(replace_findings=frozenset({dup.id})))
    assert "phantom" in {t.id for t in kept.transactions}


def test_a_row_the_file_states_again_is_never_given_way_by_a_repeat_purchase():
    first = row(date(2030, 1, 20), "-3.00", "COFFEE BAR")
    held_id = transaction_id("card", first.date, -300, first.descriptor)
    led = make_ledger([existing(held_id, "card", first.date, "-3.00", "COFFEE BAR")])
    again = row(date(2030, 1, 23), "-3.00", "COFFEE BAR")
    # two statements: the first states the held row again, the next holds the repeat
    files = [parsed("jan.pdf", [first], fmt="pdf"), parsed("feb.pdf", [again], fmt="pdf")]
    p = preview(files, led, Stub())
    assert p.held_ids == (held_id,)
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    assert dup.matches_id == held_id
    after = apply(led, p, Decisions(replace_findings=frozenset({dup.id})))
    assert {t.date for t in after.transactions} == {first.date, again.date}


def test_fitid_duplicates_drop_unless_dismissed():
    old = existing("old", "card", JAN, "-20.00", "SHOP B", fitid="F-1")
    led = make_ledger([old])
    again = row(date(2030, 1, 20), "-20.00", "SHOP B", fitid="F-1")
    p = preview([parsed("card.qfx", [again], fmt="qfx")], led, Stub())
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    assert dup.tier == "fitid"
    assert len(apply(led, p, Decisions()).transactions) == 1
    assert len(apply(led, p, Decisions(dismiss_findings=frozenset({dup.id}))).transactions) == 2


def test_overlapping_files_in_one_import_collapse_to_one_row():
    shared = row(JAN, "-7.00", "NEW CAFE")
    files = [
        parsed("a.csv", [shared, row(date(2030, 1, 9), "-1.00", "GROCER")]),
        parsed("b.csv", [shared, row(date(2030, 1, 12), "-2.00", "GROCER")]),
    ]
    stub = Stub()
    p = preview(files, make_ledger(), stub)
    assert len(p.new_transactions) == 3
    assert [r.descriptor for r in stub.requests] == ["NEW CAFE"]
    led = apply(make_ledger(), p, Decisions())
    assert len(led.transactions) == 3


def test_an_ofx_account_number_becomes_a_minted_account():
    f = parsed("bank.ofx", [row(JAN, "-3.00", "GROCER")], hint="000111222", fmt="ofx")
    p = preview([f], make_ledger(), Stub())
    minted = minted_account_id("Test", "000111222")
    assert p.files[0].account_id == minted
    assert "000111222" not in minted
    led = apply(make_ledger(), p, Decisions())
    new = next(a for a in led.accounts if a.id == minted)
    assert "000111222" not in new.name
    assert new.since == JAN
    again = preview([f], led, Stub())
    assert again.new_transactions == ()


def test_a_csv_without_an_account_waits_for_one():
    f = parsed(
        "download.csv", [row(JAN, "-3.00", "GROCER"), row(JAN, "-3.00", "GROCER")], hint=None
    )
    led = make_ledger()
    p = preview([f], led, Stub())
    assert p.files[0].needs_account is True
    assert {t.account_id for t in p.new_transactions} == {placeholder("download.csv")}
    with pytest.raises(EngineError, match=r"download\.csv: needs an account"):
        apply(led, p, Decisions())
    with pytest.raises(EngineError, match="no account"):
        apply(led, p, Decisions(account_for_file={"download.csv": "nope"}))
    done = apply(led, p, Decisions(account_for_file={"download.csv": "card"}))
    ids = {t.id for t in done.transactions}
    assert ids == {
        transaction_id("card", JAN, -300, "GROCER", occurrence=0),
        transaction_id("card", JAN, -300, "GROCER", occurrence=1),
    }
    named = engine_impl.preview([f], led, Stub(), account_for_file={"download.csv": "card"})
    assert {t.id for t in named.new_transactions} == ids
    assert named.files[0].needs_account is False


def test_unique_transfers_are_stamped_and_need_no_model():
    files = [
        parsed("chq.csv", [row(JAN, "-100.00", "TFR TO CARD")], hint="chq"),
        parsed("card.csv", [row(date(2030, 1, 12), "100.00", "PAYMENT THANK YOU")]),
    ]
    stub = Stub()
    p = preview(files, make_ledger(), stub)
    (xfer,) = [f for f in p.findings if isinstance(f, TransferFinding)]
    assert (xfer.auto, xfer.days_apart) == (True, 2)
    assert stub.requests == []
    led = apply(make_ledger(), p, Decisions())
    assert {(t.transfer_id, t.category_id) for t in led.transactions} == {(xfer.id, "transfer")}
    kept_apart = apply(make_ledger(), p, Decisions(dismiss_findings=frozenset({xfer.id})))
    assert {t.transfer_id for t in kept_apart.transactions} == {None}


def test_a_new_leg_pairs_with_one_already_in_the_ledger():
    out = existing("out", "chq", JAN, "-50.00", "TFR TO CARD", category="uncategorized")
    led = make_ledger([out])
    p = preview([parsed("card.csv", [row(date(2030, 1, 11), "50.00", "PAYMENT")])], led, Stub())
    (xfer,) = [f for f in p.findings if isinstance(f, TransferFinding)]
    assert xfer.out_id == "out"
    after = apply(led, p, Decisions())
    assert all(t.transfer_id == xfer.id for t in after.transactions)


def test_corrections_recategorise_and_become_rules():
    led = make_ledger()
    p = preview([parsed("card.csv", [row(JAN, "-8.00", "CORNER STORE 0099")])], led, Stub())
    (t,) = p.new_transactions
    after = apply(
        led,
        p,
        Decisions(recategorise={t.id: "groceries"}, make_rules=frozenset({t.id})),
    )
    (fixed,) = after.transactions
    assert (fixed.category_id, fixed.source) == ("groceries", Source.manual)
    (rule,) = [r for r in after.rules if r.created_from == "correction"]
    assert rule.category_id == "groceries"
    stub = Stub()
    nxt = preview(
        [parsed("card2.csv", [row(date(2030, 2, 1), "-9.00", "CORNER STORE 0100")])], after, stub
    )
    assert stub.requests == []
    assert nxt.rules_hit == 1
    with pytest.raises(EngineError, match="no category"):
        apply(led, p, Decisions(recategorise={t.id: "nope"}))


def test_accepting_a_low_confidence_finding_takes_its_suggestion():
    stub = Stub({"ODD SHOP": ("shopping", 0.4)})
    p = preview([parsed("card.csv", [row(JAN, "-30.00", "ODD SHOP")])], make_ledger(), stub)
    (low,) = [f for f in p.findings if isinstance(f, LowConfidenceFinding)]
    after = apply(make_ledger(), p, Decisions(accept_findings=frozenset({low.id})))
    assert after.transactions[0].category_id == "shopping"
    assert after.transactions[0].source is Source.manual
    assert len(after.rules) == 1


def test_confident_answers_are_cached_so_a_string_goes_out_once():
    stub = Stub({"NEW CAFE": ("coffee", 0.95)})
    led = make_ledger()
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "NEW CAFE")])], led, stub)
    after = apply(led, p, Decisions())
    (cached,) = [r for r in after.rules if r.match == "new cafe"]
    assert (cached.category_id, cached.created_from) == ("coffee", "model")
    again = Stub()
    nxt = preview([parsed("card2.csv", [row(date(2030, 3, 1), "-4.50", "NEW CAFE")])], after, again)
    assert again.requests == []
    assert nxt.new_transactions[0].category_id == "coffee"


def test_tombstoned_rows_never_come_back():
    f = parsed("card.csv", [row(JAN, "-4.00", "GROCER"), row(JAN, "-5.00", "GROCER")])
    led = make_ledger()
    p = preview([f], led, Stub())
    dead = p.new_transactions[0].id
    again = engine_impl.preview([f], led, Stub(), tombstones={dead})
    assert dead not in {t.id for t in again.new_transactions}
    after = engine_impl.apply(led, p, Decisions(), tombstones={dead})
    assert dead not in {t.id for t in after.transactions}
    assert len(after.transactions) == 1


def test_apply_twice_changes_nothing_more():
    led = make_ledger()
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "GROCER")])], led, Stub())
    once = apply(led, p, Decisions())
    assert apply(once, p, Decisions()) == once
    assert len(once.batches) == 1
    assert once.batches[0].rows == 1


def test_only_gaps_this_import_opens_are_reported(monkeypatch):
    def gap(account_id, actual):
        return MissingPeriodFinding(
            id=f"gap-{account_id}-{actual}",
            account_id=account_id,
            date_from=date(2030, 1, 1),
            date_to=date(2030, 1, 31),
            expected_balance=D("10.00"),
            actual_balance=D(actual),
        )

    calls = []

    def stand_in(transactions, assertions):
        calls.append(len(transactions))
        old = gap("chq", "1.00")
        return [old] if len(calls) == 1 else [old, gap("card", "2.00")]

    monkeypatch.setattr(tally.reconcile.balances, "check", stand_in)
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "GROCER")])], make_ledger(), Stub())
    assert [f.account_id for f in p.findings if isinstance(f, MissingPeriodFinding)] == ["card"]


def test_a_file_balance_is_checked_against_the_resolved_account():
    stated = BalanceAssertion(account_id="000111222", date=JAN, balance=D("-10.00"), origin="ofx")
    f = parsed(
        "bank.ofx", [row(JAN, "-3.00", "GROCER")], hint="000111222", fmt="ofx", assertions=[stated]
    )
    stub = Stub()
    p = preview([f], make_ledger(), stub)
    assert p.findings == ()
    later = BalanceAssertion(
        account_id="000111222", date=date(2030, 2, 1), balance=D("-50.00"), origin="ofx"
    )
    f2 = parsed(
        "bank.ofx",
        [row(JAN, "-3.00", "GROCER"), row(date(2030, 1, 20), "-4.00", "GROCER")],
        hint="000111222",
        fmt="ofx",
        assertions=[stated, later],
    )
    (gap,) = [
        x
        for x in preview([f2], make_ledger(), stub).findings
        if isinstance(x, MissingPeriodFinding)
    ]
    assert gap.account_id == minted_account_id("Test", "000111222")
    assert (gap.expected_balance, gap.actual_balance) == (D("-50.00"), D("-14.00"))


def test_paths_go_through_the_parser(monkeypatch, tmp_path):
    f = parsed("card.csv", [row(JAN, "-4.00", "GROCER")])
    seen = []

    def fake_parse(path):
        seen.append(path)
        return f

    monkeypatch.setattr(tally.parsers, "parse", fake_parse)
    p = preview([tmp_path / "card.csv"], make_ledger(), Stub())
    assert seen == [Path(tmp_path / "card.csv")]
    assert p.files[0].rows == 1


def test_the_synthetic_october_import_matches_the_web_preview():
    base = build_ledger(before=PREVIEW_FROM)
    static = build_preview()
    p = preview(build_preview_files(), base, Stub())
    assert [(f.name, f.rows) for f in p.files] == [(f.name, f.rows) for f in static.files]
    assert [f.needs_account for f in p.files] == [False, False, True, False]
    assert sum(1 for f in p.findings if isinstance(f, TransferFinding) and f.auto) == 2
    after = apply(base, p, Decisions(account_for_file={"td-visa-download.csv": "td-visa"}))
    in_files = {"rbc-chq", "amex", "td-visa"}
    october = [t for t in build_ledger().transactions if t.date >= PREVIEW_FROM]
    assert len(after.transactions) == len(base.transactions) + sum(
        1 for t in october if t.account_id in in_files
    )
    assert not any(t.account_id.startswith("unassigned:") for t in after.transactions)


def test_the_engine_contract_forwards_withhold_and_tombstones():
    f = parsed("card.csv", [row(JAN, "-4.00", "PRIVATE CLINIC"), row(JAN, "-5.00", "NEW CAFE")])
    stub = Stub()
    led = make_ledger()
    p = preview([f], led, stub, withhold={"PRIVATE CLINIC"})
    assert [r.descriptor for r in stub.requests] == ["NEW CAFE"]
    dead = p.new_transactions[0].id
    assert dead not in {t.id for t in preview([f], led, Stub(), tombstones={dead}).new_transactions}
    assert dead not in {t.id for t in apply(led, p, Decisions(), tombstones={dead}).transactions}


def statement(name, hint, *, kind, assertions=(), holdings=()):
    return ParsedFile(
        name=name,
        format="pdf",
        institution="Test",
        account_hint=hint,
        account_kind_hint=kind,
        rows=(),
        assertions=tuple(assertions),
        holdings=tuple(holdings),
        sha256=name.encode().hex().ljust(64, "0")[:64],
        date_from=JAN,
        date_to=JAN,
    )


def snapshot(account_id, on=JAN):
    pos = Position(
        symbol="CASH",
        name="Cash",
        quantity=D("10.00"),
        price=D("1"),
        market_value=D("10.00"),
        book_cost=D("10.00"),
    )
    return HoldingSnapshot(
        account_id=account_id, date=on, positions=(pos,), total=D("10.00"), origin="statement-pdf"
    )


def test_statement_balances_and_holdings_reach_the_ledger_under_minted_accounts():
    card = statement(
        "card.pdf",
        "000111222",
        kind=AccountKind.credit,
        assertions=[
            BalanceAssertion(account_id="000111222", date=JAN, balance=D("-1.00"), origin="x")
        ],
    )
    plans = statement(
        "plans.pdf", None, kind=AccountKind.investment, holdings=[snapshot("777"), snapshot("888")]
    )
    led = make_ledger()
    p = preview([card, plans], led, Stub())
    minted = {minted_account_id("Test", h) for h in ("000111222", "777", "888")}
    assert {a.account_id for a in p.assertions} | {h.account_id for h in p.holdings} == minted
    assert not any(f.needs_account for f in p.files)
    after = apply(led, p, Decisions())
    kinds = {a.id: a.kind for a in after.accounts if a.id in minted}
    assert kinds == {
        minted_account_id("Test", "000111222"): AccountKind.credit,
        minted_account_id("Test", "777"): AccountKind.investment,
        minted_account_id("Test", "888"): AccountKind.investment,
    }
    assert (len(after.holdings), len(after.assertions)) == (2, 1)
    assert apply(after, p, Decisions()) == after


def test_a_snapshot_without_an_account_waits_for_one():
    f = statement("plan.pdf", None, kind=AccountKind.investment, holdings=[snapshot("")])
    led = make_ledger()
    p = preview([f], led, Stub())
    assert p.files[0].needs_account is True
    assert p.holdings[0].account_id == placeholder("plan.pdf")
    with pytest.raises(EngineError, match="needs an account"):
        apply(led, p, Decisions())
    after = apply(led, p, Decisions(account_for_file={"plan.pdf": "chq"}))
    assert [h.account_id for h in after.holdings] == ["chq"]
    assert {a.id for a in after.accounts} == {"chq", "card"}


def pending(r):
    return r.model_copy(update={"pending": True})


def test_a_pending_row_posts_in_place_when_its_twin_arrives_posted():
    tid = transaction_id("card", JAN, -900, "SHOP A")
    held = existing(tid, "card", JAN, "-9.00", "SHOP A", category="shopping")
    led = make_ledger([held.model_copy(update={"pending": True})])
    stub = Stub()
    p = preview([parsed("card.csv", [row(JAN, "-9.00", "SHOP A", fitid="F9")])], led, stub)
    assert stub.requests == []
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    assert dup.reason.startswith("replaces pending")
    for decisions in (Decisions(), Decisions(accept_findings=frozenset({dup.id}))):
        (only,) = apply(led, p, decisions).transactions
        assert (only.id, only.pending, only.category_id, only.fitid) == (
            tid,
            False,
            "shopping",
            "F9",
        )


def test_a_pending_row_and_its_posted_twin_in_one_import_land_posted():
    files = [
        parsed("a.csv", [pending(row(JAN, "-9.00", "SHOP A"))]),
        parsed("b.csv", [row(JAN, "-9.00", "SHOP A")]),
    ]
    led = make_ledger()
    p = preview(files, led, Stub())
    assert [t.pending for t in p.new_transactions] == [False]
    everything = frozenset(f.id for f in p.findings)
    for decisions in (Decisions(), Decisions(accept_findings=everything)):
        (only,) = apply(led, p, decisions).transactions
        assert not only.pending


def test_an_accepted_replacement_retires_a_pending_row_from_the_same_import():
    files = [
        parsed("a.csv", [pending(row(JAN, "-9.00", "SHOP A"))]),
        parsed("b.csv", [row(date(2030, 1, 12), "-9.00", "SHOP A")]),
    ]
    led = make_ledger()
    p = preview(files, led, Stub())
    (dup,) = [f for f in p.findings if isinstance(f, DuplicateFinding)]
    assert dup.reason.startswith("replaces pending")
    assert len(apply(led, p, Decisions()).transactions) == 2
    (only,) = apply(led, p, Decisions(accept_findings=frozenset({dup.id}))).transactions
    assert (only.date, only.pending) == (date(2030, 1, 12), False)


def test_rows_given_an_account_at_apply_are_deduped_against_it():
    led = make_ledger([existing("tx_old", "card", JAN, "-7.00", "SHOP B", fitid="F1")])
    f = parsed("x.csv", [row(JAN, "-7.00", "SHOP B", fitid="F1")], hint=None)
    p = preview([f], led, Stub())
    after = apply(led, p, Decisions(account_for_file={"x.csv": "card"}))
    assert [t.id for t in after.transactions] == ["tx_old"]


def test_only_row_driven_accounts_are_checked_for_missing_periods():
    def gaps(account_id, kind):
        opening = BalanceAssertion(
            account_id=account_id, date=JAN, balance=D("-1000.00"), origin="pdf"
        )
        later = opening.model_copy(update={"date": date(2030, 2, 10), "balance": D("-990.00")})
        base = make_ledger()
        led = base.model_copy(
            update={
                "accounts": (*base.accounts, account(account_id, kind)),
                "assertions": (opening,),
            }
        )
        f = parsed("s.pdf", [], hint=account_id, fmt="pdf", assertions=[later])
        found = preview([f], led, Stub()).findings
        return [x for x in found if isinstance(x, MissingPeriodFinding)]

    assert gaps("mtg", AccountKind.mortgage) == []
    assert gaps("inv", AccountKind.investment) == []
    assert [g.account_id for g in gaps("sav", AccountKind.savings)] == ["sav"]


def test_only_scrubbed_descriptors_leave_and_the_cache_matches_the_next_reference():
    rows = [
        row(JAN, "-4.00", "E-TRANSFER 12345678901 SENT"),
        row(JAN, "-6.00", "PAYMENT CARD ****4321 THANKS"),
    ]
    stub = Stub({"E-TRANSFER [ref] SENT": ("shopping", 0.95)})
    led = make_ledger()
    p = preview([parsed("card.csv", rows)], led, stub)
    sent = [r.descriptor for r in stub.requests]
    assert sent == ["E-TRANSFER [ref] SENT", "PAYMENT CARD [ref] THANKS"]
    assert not any(n in s for s in p.outbound_strings for n in ("12345678901", "4321"))
    after = apply(led, p, Decisions())
    (cached,) = [r for r in after.rules if r.created_from == "model"]
    assert "12345678901" not in cached.match
    again = Stub()
    later = row(date(2030, 3, 1), "-8.00", "E-TRANSFER 99887766554 SENT")
    nxt = preview([parsed("card2.csv", [later])], after, again)
    assert again.requests == []
    assert nxt.new_transactions[0].category_id == "shopping"


def test_a_slash_shaped_descriptor_caches_as_a_literal():
    stub = Stub({"/x+(/": ("coffee", 0.95)})
    led = make_ledger()
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "/x+(/")])], led, stub)
    after = apply(led, p, Decisions())
    again = Stub()
    nxt = preview([parsed("c2.csv", [row(date(2030, 3, 1), "-4.00", "/x+(/")])], after, again)
    assert again.requests == []
    assert nxt.new_transactions[0].category_id == "coffee"


def test_a_string_withheld_at_apply_keeps_no_model_answer():
    stub = Stub({"NEW CAFE": ("coffee", 0.95)})
    led = make_ledger()
    p = preview([parsed("card.csv", [row(JAN, "-4.00", "NEW CAFE")])], led, stub)
    after = apply(led, p, Decisions(withhold_strings=frozenset({"NEW CAFE"})))
    (t,) = after.transactions
    assert (t.category_id, t.source) == ("uncategorized", Source.manual)
    assert not [r for r in after.rules if r.created_from == "model"]


# trusted tags: a register the owner categorised by hand


def tagged(on, amount, descriptor, *tags, hint="Test Card"):
    return ParsedRow(account_hint=hint, date=on, amount=D(amount), descriptor=descriptor, tags=tags)


def register(rows):
    from tally.model import AccountHint

    hints = dict.fromkeys(r.account_hint for r in rows if r.account_hint)
    return ParsedFile(
        name="Register.csv",
        format="csv",
        institution="YNAB",
        account_hint=None,
        accounts=tuple(
            AccountHint(hint=h, name=h, kind=AccountKind.credit if "Card" in h else None)
            for h in hints
        ),
        rows=tuple(rows),
        sha256="5" * 64,
        date_from=min(r.date for r in rows),
        date_to=max(r.date for r in rows),
    )


def test_trusted_tags_keep_their_category_grow_the_tree_and_seed_rules():
    rows = [
        tagged(JAN, "-4.50", "Lantern Cafe", "ynab:Everyday/Coffee"),
        tagged(JAN, "-9.00", "Lantern Cafe", "ynab:Everyday/Coffee"),
        tagged(JAN, "-30.00", "Widget Shop", "ynab:Odd Group/Widgets"),
        tagged(JAN, "-100.00", "Transfer : Test Chequing", "ynab:transfer"),
        tagged(JAN, "100.00", "Transfer : Test Card", "ynab:transfer", hint="Test Chequing"),
        tagged(JAN, "-5.00", "Lantern Cafe"),
        tagged(JAN, "-7.00", "Nothing Known"),
    ]
    stub = Stub()
    led = make_ledger(rules=())
    got = preview([register(rows)], led, stub)

    by_desc = {(t.descriptor, t.amount): t for t in got.new_transactions}
    assert by_desc[("Lantern Cafe", D("-4.50"))].category_id == "coffee"
    assert by_desc[("Lantern Cafe", D("-4.50"))].source is Source.manual
    assert by_desc[("Lantern Cafe", D("-4.50"))].tags == ("ynab:Everyday/Coffee",)
    widgets = by_desc[("Widget Shop", D("-30.00"))].category_id
    assert widgets not in {c.id for c in led.categories}
    assert {c.id for c in got.new_categories} >= {widgets}
    assert all(c.id not in {x.id for x in led.categories} for c in got.new_categories)
    # the untagged coffee row matches the rule the tagged rows seeded, in this same preview
    assert by_desc[("Lantern Cafe", D("-5.00"))].category_id == "coffee"
    assert by_desc[("Lantern Cafe", D("-5.00"))].source is Source.rule
    assert {r.match for r in got.seed_rules} == {"lantern cafe", "widget shop"}
    assert all(r.created_from == "seed" for r in got.seed_rules)
    # the transfer pair is stamped under the transfer root, and only the unknown row is asked
    legs = [t for t in got.new_transactions if t.descriptor.startswith("Transfer")]
    assert {t.category_id for t in legs} == {"transfer"}
    assert [r.descriptor for r in stub.requests] == ["Nothing Known"]
    # the register's accounts carry their names and kinds
    assert {(a.name, a.kind) for a in got.new_accounts} == {
        ("Test Card", AccountKind.credit),
        ("Test Chequing", AccountKind.chequing),
    }

    after = apply(led, got, Decisions())
    assert widgets in {c.id for c in after.categories}
    assert {r.match for r in after.rules} == {"lantern cafe", "widget shop"}
    assert {a.name for a in after.accounts} >= {"Test Card", "Test Chequing"}
    assert {t.account_id for t in after.transactions} <= {a.id for a in after.accounts}
    assert next(t for t in after.transactions if t.transfer_id).category_id == "transfer"

    again = apply(after, preview([register(rows)], after, stub), Decisions())
    assert again.categories == after.categories
    assert again.rules == after.rules
    assert len(again.transactions) == len(after.transactions)


def test_a_trusted_tag_whose_category_the_ledger_lacks_is_added_before_classifying():
    rows = [tagged(JAN, "-1.00", "Odd Vendor", "ynab:Odd Group/Widgets")]
    got = preview([register(rows)], make_ledger(rules=()), Stub())
    (txn,) = got.new_transactions
    assert txn.category_id == got.new_categories[-1].id
    assert not got.findings


def card_statement(name, opening, closing, rows):
    """A card statement: rows posted after the opening date through the closing date."""
    assertions = [
        BalanceAssertion(account_id="card", date=on, balance=D(balance), origin=name)
        for on, balance in (opening, closing)
    ]
    return parsed(name, rows, fmt="pdf", assertions=assertions)


FEB = date(2030, 2, 10)
FARE = "TRANSIT FARE"
JANUARY = card_statement(
    "jan.pdf",
    (date(2029, 12, 10), "0.00"),
    (JAN, "-10.00"),
    [row(date(2030, 1, 5), "-3.25", "BUS"), row(date(2030, 1, 9), "-6.75", FARE)],
)
FEBRUARY = card_statement(
    "feb.pdf", (JAN, "-10.00"), (FEB, "-16.75"), [row(date(2030, 1, 11), "-6.75", FARE)]
)


def dups(p):
    return [f for f in p.findings if isinstance(f, DuplicateFinding)]


def test_a_repeat_purchase_either_side_of_a_statement_date_is_kept_in_one_import():
    p = preview([JANUARY, FEBRUARY], make_ledger(), Stub())
    assert dups(p) == []
    after = apply(make_ledger(), p, Decisions())
    assert len(after.transactions) == 3
    assert tally.reconcile.balances.check(after.transactions, after.assertions) == []


def test_a_repeat_purchase_is_kept_against_a_statement_the_ledger_already_reconciles():
    first = make_ledger()
    led = apply(first, preview([JANUARY], first, Stub()), Decisions())
    p = preview([FEBRUARY], led, Stub())
    assert dups(p) == []
    assert len(apply(led, p, Decisions()).transactions) == 3


def test_a_statement_that_does_not_reconcile_is_still_deduped():
    unanchored = FEBRUARY.model_copy(update={"assertions": FEBRUARY.assertions[1:]})
    off = card_statement(
        "feb.pdf", (JAN, "-10.00"), (FEB, "-99.00"), [row(date(2030, 1, 11), "-6.75", FARE)]
    )
    for second in (unanchored, off):
        (dup,) = dups(preview([JANUARY, second], make_ledger(), Stub()))
        assert dup.tier == "fuzzy"


def test_an_export_overlapping_a_reconciled_statement_is_still_deduped():
    first = make_ledger()
    led = apply(first, preview([JANUARY], first, Stub()), Decisions())
    export = parsed("card.csv", [row(date(2030, 1, 11), "-6.75", FARE)])
    (dup,) = dups(preview([export], led, Stub()))
    assert dup.tier == "fuzzy"
