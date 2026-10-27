from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.model import Transaction
from tally.reconcile.transfers import apply, propose

D = date(2023, 1, 16)


def tx(
    id_: str,
    account: str,
    amount: str,
    *,
    on: date = D,
    descriptor: str = "ONLINE TFR",
    transfer_id: str | None = None,
    pending: bool = False,
) -> Transaction:
    return Transaction(
        id=id_,
        account_id=account,
        date=on,
        amount=Decimal(amount),
        descriptor=descriptor,
        merchant="",
        category_id="cat-uncategorised",
        batch_id="b0",
        transfer_id=transfer_id,
        pending=pending,
    )


def test_credit_card_payment_pairs_automatically():
    rows = [
        tx("c1", "chq", "-250.00", descriptor="CARD PAYMENT"),
        tx("v1", "visa", "250.00", on=D + timedelta(days=2), descriptor="PAYMENT THANK YOU"),
    ]
    [finding] = propose(rows)
    assert (finding.out_id, finding.in_id) == ("c1", "v1")
    assert finding.days_apart == 2
    assert finding.auto


def test_brokerage_contribution_pairs():
    rows = [
        tx("c1", "chq", "-500.00", descriptor="INVESTMENT CONTRIBUTION"),
        tx("r1", "rrsp", "500.00", on=D + timedelta(days=1), descriptor="CONTRIBUTION"),
    ]
    assert [f.auto for f in propose(rows)] == [True]


def test_outside_window_unequal_and_same_sign_rows_do_not_pair():
    assert propose([tx("a", "chq", "-10.00"), tx("b", "sav", "10.00", on=D + timedelta(5))]) == []
    assert propose([tx("a", "chq", "-10.00"), tx("b", "sav", "10.01")]) == []
    assert propose([tx("a", "chq", "-10.00"), tx("b", "sav", "-10.00")]) == []
    assert propose(
        [tx("a", "chq", "-10.00"), tx("b", "sav", "10.00", on=D + timedelta(5))], window_days=5
    )


def test_same_account_rows_never_pair():
    assert propose([tx("a", "chq", "-10.00"), tx("b", "chq", "10.00")]) == []


def test_rows_already_in_a_transfer_or_pending_are_skipped():
    assert propose([tx("a", "chq", "-10.00", transfer_id="t0"), tx("b", "sav", "10.00")]) == []
    assert propose([tx("a", "chq", "-10.00"), tx("b", "sav", "10.00", pending=True)]) == []


def test_ambiguous_candidates_are_proposed_one_to_one_and_not_auto():
    rows = [
        tx("a", "chq", "-100.00"),
        tx("b", "sav", "100.00", on=D + timedelta(days=1)),
        tx("c", "visa", "100.00", on=D + timedelta(days=3)),
    ]
    [finding] = propose(rows)
    assert (finding.out_id, finding.in_id) == ("a", "b")
    assert not finding.auto


def test_transfer_words_break_a_date_tie():
    rows = [
        tx("a", "chq", "-100.00", descriptor="CORNER GROCER"),
        tx("b", "sav", "100.00", descriptor="REFUND"),
        tx("c", "visa", "100.00", descriptor="PAYMENT RECEIVED"),
    ]
    [finding] = propose(rows)
    assert finding.in_id == "c"


def test_rejected_pairs_are_not_proposed_again():
    rows = [tx("a", "chq", "-10.00"), tx("b", "sav", "10.00"), tx("c", "visa", "10.00")]
    [finding] = propose(rows, rejected={("a", "b")})
    assert finding.in_id == "c"
    assert finding.auto


def test_apply_stamps_both_legs_and_the_category():
    rows = [tx("a", "chq", "-10.00"), tx("b", "sav", "10.00"), tx("z", "chq", "-3.00")]
    [finding] = propose(rows)
    out = apply(rows, [finding], category_id="cat-transfer")
    by_id = {t.id: t for t in out}
    assert by_id["a"].transfer_id == by_id["b"].transfer_id == finding.id
    assert by_id["a"].category_id == by_id["b"].category_id == "cat-transfer"
    assert by_id["z"] == rows[2]
    assert [t.id for t in out] == ["a", "b", "z"]


def test_apply_refuses_bad_findings():
    rows = [tx("a", "chq", "-10.00"), tx("b", "sav", "10.00"), tx("c", "visa", "10.00")]
    [finding] = propose(rows)
    with pytest.raises(ValueError, match="already in a transfer"):
        apply(rows, [finding, finding], category_id="t")
    with pytest.raises(ValueError, match="no transaction"):
        apply(rows[:1], [finding], category_id="t")
    stamped = apply(rows, [finding], category_id="t")
    with pytest.raises(ValueError, match="already in a transfer"):
        apply(stamped, [finding], category_id="t")
    wrong = finding.model_copy(update={"out_id": "c"})
    with pytest.raises(ValueError, match="equal and opposite"):
        apply(rows, [wrong], category_id="t")


ledgers = st.lists(
    st.builds(
        tx,
        st.uuids().map(str),
        st.sampled_from(["chq", "sav", "visa", "rrsp"]),
        st.sampled_from(["-10.00", "10.00", "-250.00", "250.00", "0.00"]),
        on=st.dates(min_value=D, max_value=D + timedelta(days=10)),
        transfer_id=st.one_of(st.none(), st.just("t-old")),
        pending=st.booleans(),
    ),
    max_size=30,
    unique_by=lambda t: t.id,
)


@given(ledgers)
def test_proposals_are_cross_account_one_to_one_and_applicable(rows):
    findings = propose(rows)
    by_id = {t.id: t for t in rows}
    legs = [leg for f in findings for leg in (f.out_id, f.in_id)]
    assert len(legs) == len(set(legs))
    for f in findings:
        out, inn = by_id[f.out_id], by_id[f.in_id]
        assert out.account_id != inn.account_id
        assert out.amount == -inn.amount < 0
        assert out.transfer_id is None and inn.transfer_id is None
        assert f.days_apart <= 4
    apply(rows, findings, category_id="cat-transfer")
