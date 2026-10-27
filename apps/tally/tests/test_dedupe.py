from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.model import ParsedRow, Transaction
from tally.reconcile.dedupe import dedupe, find_duplicates

D = date(2022, 6, 10)


def tx(
    id_: str,
    amount: str,
    *,
    on: date = D,
    descriptor: str = "BEAN BARN",
    account: str = "chq",
    fitid: str | None = None,
    pending: bool = False,
) -> Transaction:
    return Transaction(
        id=id_,
        account_id=account,
        date=on,
        amount=Decimal(amount),
        descriptor=descriptor,
        merchant=descriptor.title(),
        category_id="cat-coffee",
        batch_id="b0",
        fitid=fitid,
        pending=pending,
    )


def row(
    amount: str,
    *,
    on: date = D,
    descriptor: str = "BEAN BARN",
    account: str | None = "chq",
    fitid: str | None = None,
    pending: bool = False,
) -> ParsedRow:
    return ParsedRow(
        account_hint=account,
        date=on,
        amount=Decimal(amount),
        descriptor=descriptor,
        fitid=fitid,
        pending=pending,
    )


def test_fitid_match_is_tier_one_even_when_the_date_moved():
    existing = [tx("e1", "-4.50", fitid="F1")]
    incoming = [row("-4.50", on=D + timedelta(days=9), fitid="F1")]
    [finding] = find_duplicates(existing, incoming)
    assert finding.tier == "fitid"
    assert finding.matches_id == "e1"
    assert "date changed" in finding.reason


def test_fitid_on_another_account_does_not_match():
    existing = [tx("e1", "-4.50", fitid="F1", account="visa", on=D - timedelta(days=30))]
    assert find_duplicates(existing, [row("-4.50", fitid="F1")]) == []


def test_fuzzy_match_within_window_and_not_beyond():
    existing = [tx("e1", "-12.00", descriptor="NOODLE HOUSE")]
    near = row("-12.00", on=D + timedelta(days=3), descriptor="NOODLE HOUSE #12")
    far = row("-12.00", on=D + timedelta(days=4), descriptor="NOODLE HOUSE")
    [finding] = find_duplicates(existing, [near])
    assert finding.tier == "fuzzy"
    assert "3 days apart" in finding.reason
    assert find_duplicates(existing, [far]) == []
    assert find_duplicates(existing, [far], window_days=4) != []


def test_amount_must_match_to_the_cent():
    assert find_duplicates([tx("e1", "-12.00")], [row("-12.01")]) == []


def test_two_identical_coffees_survive_against_one_existing():
    result = dedupe([tx("e1", "-4.50")], [row("-4.50"), row("-4.50")])
    assert len(result.findings) == 1
    assert len(result.new) == 1
    assert len(set(result.ids)) == 2


def test_each_existing_row_is_used_once_and_closest_date_wins():
    existing = [tx("e1", "-4.50", on=D - timedelta(days=2)), tx("e2", "-4.50", on=D)]
    result = dedupe(existing, [row("-4.50", on=D)])
    [finding] = result.findings
    assert finding.matches_id == "e2"


def test_closest_descriptor_breaks_a_date_tie():
    existing = [
        tx("e1", "-20.00", descriptor="CORNER GROCER"),
        tx("e2", "-20.00", descriptor="FUEL STOP"),
    ]
    incoming = [row("-20.00", descriptor="FUEL STOP 0099"), row("-20.00", descriptor="CORNER")]
    findings = find_duplicates(existing, incoming)
    assert {(f.transaction_id, f.matches_id) for f in findings} == {
        (dedupe(existing, incoming).ids[0], "e2"),
        (dedupe(existing, incoming).ids[1], "e1"),
    }


def test_different_fitids_block_a_fuzzy_match_unless_descriptor_agrees():
    existing = [tx("e1", "-9.99", descriptor="STREAMFLIX", fitid="A")]
    other = row("-9.99", descriptor="SOMETHING ELSE", fitid="B")
    same = row("-9.99", descriptor="STREAMFLIX", fitid="B")
    assert find_duplicates(existing, [other]) == []
    [finding] = find_duplicates(existing, [same])
    assert "FITIDs differ" in finding.reason


def test_rows_in_disjoint_closed_periods_are_two_purchases():
    march, april = (D - timedelta(days=30), D), (D, D + timedelta(days=30))
    existing = [tx("e1", "-3.25", on=D)]
    repeat = [row("-3.25", on=D + timedelta(days=2))]
    assert find_duplicates(existing, repeat, periods=[april], existing_periods={"e1": march}) == []
    assert find_duplicates(existing, repeat, periods=[march], existing_periods={"e1": march})
    assert find_duplicates(existing, repeat, periods=[None], existing_periods={"e1": march})
    assert find_duplicates(existing, repeat, periods=[april])


def test_closed_periods_keep_both_files_of_one_import():
    rows = [row("-3.25", on=D), row("-3.25", on=D + timedelta(days=1))]
    periods = [(D - timedelta(days=30), D), (D, D + timedelta(days=30))]
    assert find_duplicates([], rows, sources=["mar", "apr"], periods=periods) == []
    assert find_duplicates([], rows, sources=["mar", "apr"])


def test_periods_must_cover_every_incoming_row():
    with pytest.raises(ValueError, match="periods"):
        dedupe([], [row("-1.00")], periods=[])


def test_pending_incoming_matching_posted_existing_is_a_duplicate():
    result = dedupe([tx("e1", "-30.00")], [row("-30.00", on=D - timedelta(days=1), pending=True)])
    [finding] = result.findings
    assert finding.reason.startswith("pending row already posted")
    assert result.new == ()
    assert result.replaces == {}


def test_posted_incoming_matching_pending_existing_is_a_replacement():
    existing = [tx("e1", "-30.00", pending=True, descriptor="PENDING BEAN BARN")]
    result = dedupe(existing, [row("-30.00", on=D + timedelta(days=2))])
    [finding] = result.findings
    assert finding.reason.startswith("replaces pending")
    assert result.new == (0,)
    assert result.replaces == {0: "e1"}


def test_overlapping_files_in_one_import_dedupe_against_each_other():
    jan = [row("-4.50"), row("-4.50"), row("-60.00", descriptor="POWER CO")]
    feb = [row("-4.50"), row("-60.00", descriptor="POWER CO"), row("-8.00", descriptor="BAKERY")]
    incoming = [*jan, *feb]
    sources = ["jan.csv"] * 3 + ["feb.csv"] * 3
    result = dedupe([], incoming, sources=sources)
    assert result.new == (0, 1, 2, 5)
    assert len(result.findings) == 2
    assert len({f.id for f in result.findings}) == 2


def test_without_sources_one_import_is_one_file():
    assert find_duplicates([], [row("-4.50"), row("-4.50")]) == []


def test_three_overlapping_files_all_collapse_onto_the_ledger_row():
    existing = [tx("e1", "-4.50")]
    result = dedupe(existing, [row("-4.50")] * 3, sources=["a", "b", "c"])
    assert result.new == ()
    assert {f.matches_id for f in result.findings} == {"e1"}
    assert len({f.id for f in result.findings}) == 3


def test_posted_file_replaces_pending_row_from_an_earlier_file_in_the_batch():
    incoming = [row("-15.00", pending=True), row("-15.00", on=D + timedelta(days=1))]
    result = dedupe([], incoming, sources=["pending.csv", "posted.csv"])
    assert result.new == (1,)
    assert result.replaces == {}
    assert result.findings[0].reason.startswith("replaces pending")


def test_parsed_row_without_account_needs_one():
    with pytest.raises(ValueError, match="no account"):
        find_duplicates([], [row("-1.00", account=None)])
    assert find_duplicates([tx("e1", "-1.00")], [row("-1.00", account=None)], account_id="chq")


def test_transactions_are_accepted_as_incoming():
    [finding] = find_duplicates([tx("e1", "-4.50")], [tx("n1", "-4.50", on=D + timedelta(days=1))])
    assert finding.transaction_id == "n1"


def test_bad_arguments_raise():
    with pytest.raises(ValueError):
        find_duplicates([], [], window_days=-1)
    with pytest.raises(ValueError):
        find_duplicates([], [row("-1.00")], sources=[])


descriptors = st.sampled_from(["BEAN BARN", "NOODLE HOUSE #4", "POWER CO", "FUEL STOP 0042"])
rows = st.builds(
    row,
    st.sampled_from(["-4.50", "-12.00", "-60.00", "1500.00"]),
    on=st.dates(min_value=D, max_value=D + timedelta(days=20)),
    descriptor=descriptors,
    account=st.sampled_from(["chq", "visa"]),
    fitid=st.one_of(st.none(), st.sampled_from(["F1", "F2", "F3"])),
    pending=st.booleans(),
)


def _as_ledger(parsed: list[ParsedRow]) -> list[Transaction]:
    ids = dedupe([], parsed).ids
    return [
        tx(
            ids[i],
            str(r.amount),
            on=r.date,
            descriptor=r.descriptor,
            account=r.account_hint or "chq",
            fitid=r.fitid,
            pending=r.pending,
        )
        for i, r in enumerate(parsed)
    ]


@given(st.lists(rows, max_size=25))
def test_importing_the_same_file_twice_is_all_duplicates(parsed):
    result = dedupe(_as_ledger(parsed), parsed)
    assert result.new == ()
    assert len(result.findings) == len(parsed)
    assert len({f.matches_id for f in result.findings}) == len(parsed)


@given(st.lists(rows, max_size=25))
def test_one_file_twice_in_one_import_is_all_duplicates_the_second_time(parsed):
    result = dedupe([], [*parsed, *parsed], sources=["a"] * len(parsed) + ["b"] * len(parsed))
    assert result.new == tuple(range(len(parsed)))


@given(st.lists(rows, max_size=25), st.lists(rows, max_size=25))
def test_findings_never_reuse_an_existing_row_within_one_file(ledger_rows, incoming):
    findings = find_duplicates(_as_ledger(ledger_rows), incoming)
    matched = [f.matches_id for f in findings]
    assert len(matched) == len(set(matched))
