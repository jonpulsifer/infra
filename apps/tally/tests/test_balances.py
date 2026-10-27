from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from tally.model import BalanceAssertion, Transaction
from tally.reconcile.balances import check, ladder

D = date(2020, 1, 1)


def tx(id_: str, amount: str, on: date, *, account: str = "chq", pending: bool = False):
    return Transaction(
        id=id_,
        account_id=account,
        date=on,
        amount=Decimal(amount),
        descriptor="ROW",
        merchant="",
        category_id="c",
        batch_id="b0",
        pending=pending,
    )


def bal(on: date, balance: str, *, account: str = "chq", origin: str = "stmt"):
    return BalanceAssertion(account_id=account, date=on, balance=Decimal(balance), origin=origin)


def test_first_assertion_before_all_rows_is_the_opening_balance():
    rows = [tx("a", "-20.00", D + timedelta(1)), tx("b", "100.00", D + timedelta(2))]
    rungs = ladder("chq", rows, [bal(D, "50.00"), bal(D + timedelta(3), "130.00")])
    assert [r.anchor for r in rungs] == [True, False]
    assert all(r.held for r in rungs)
    assert check(rows, [bal(D, "50.00"), bal(D + timedelta(3), "130.00")]) == []


def test_assertion_counts_rows_on_its_own_date_and_skips_pending():
    rows = [tx("a", "-20.00", D), tx("p", "-5.00", D, pending=True)]
    assert check(rows, [bal(D, "-20.00")], opening={"chq": Decimal("0")}) == []


def test_inferred_opening_when_first_assertion_falls_after_rows():
    rows = [tx("a", "-20.00", D), tx("b", "-30.00", D + timedelta(5))]
    rungs = ladder("chq", rows, [bal(D + timedelta(1), "80.00"), bal(D + timedelta(6), "50.00")])
    assert rungs[0].anchor and rungs[0].held
    assert rungs[1].held


def test_failure_spans_from_the_last_assertion_that_held():
    rows = [
        tx("a", "-20.00", D + timedelta(1)),
        tx("b", "-30.00", D + timedelta(12)),
        tx("c", "-5.00", D + timedelta(40)),
    ]
    assertions = [
        bal(D, "100.00"),
        bal(D + timedelta(10), "80.00"),
        bal(D + timedelta(20), "10.00"),
        bal(D + timedelta(45), "5.00"),
    ]
    [finding] = check(rows, assertions)
    assert (finding.date_from, finding.date_to) == (D + timedelta(10), D + timedelta(20))
    assert finding.expected_balance == Decimal("10.00")
    assert finding.actual_balance == Decimal("50.00")
    rung = ladder("chq", rows, assertions)[2]
    assert rung.difference == Decimal("-40.00")
    assert ladder("chq", rows, assertions)[3].held


def test_explicit_opening_checks_the_first_assertion_from_the_account_start():
    rows = [tx("a", "-20.00", D + timedelta(3))]
    [finding] = check(rows, [bal(D + timedelta(9), "90.00")], opening={"chq": Decimal("100")})
    assert (finding.date_from, finding.date_to) == (D + timedelta(3), D + timedelta(9))
    assert finding.actual_balance == Decimal("80.00")


def test_accounts_are_checked_separately():
    rows = [tx("a", "-20.00", D + timedelta(1)), tx("v", "-7.00", D + timedelta(1), account="visa")]
    assertions = [
        bal(D, "0", account="visa"),
        bal(D + timedelta(2), "-7.00", account="visa"),
        bal(D, "0"),
        bal(D + timedelta(2), "-25.00"),
    ]
    [finding] = check(rows, assertions)
    assert finding.account_id == "chq"


def test_no_assertions_no_findings():
    assert check([tx("a", "-1.00", D)], []) == []
    assert ladder("chq", [tx("a", "-1.00", D)], []) == []


def test_finding_ids_are_stable():
    rows = [tx("a", "-1.00", D + timedelta(1))]
    assertions = [bal(D, "0"), bal(D + timedelta(2), "0")]
    assert check(rows, assertions) == check(list(reversed(rows)), list(reversed(assertions)))


amounts = st.decimals(min_value=-5000, max_value=5000, places=2, allow_nan=False)


@given(
    st.lists(st.tuples(st.sampled_from(["chq", "visa"]), st.integers(0, 90), amounts), max_size=40),
    st.lists(st.tuples(st.sampled_from(["chq", "visa"]), st.integers(0, 90)), max_size=8),
    st.dictionaries(st.sampled_from(["chq", "visa"]), amounts),
    st.booleans(),
)
def test_a_ledger_built_to_satisfy_its_assertions_passes(raw_rows, raw_asserts, opening, pass_it):
    rows = [
        tx(f"t{i}", str(amount), D + timedelta(day), account=account)
        for i, (account, day, amount) in enumerate(raw_rows)
    ]

    def balance_at(account: str, on: date) -> Decimal:
        base = opening.get(account, Decimal("0"))
        return base + sum(
            (t.amount for t in rows if t.account_id == account and t.date <= on), Decimal()
        )

    assertions = [
        bal(D + timedelta(day), str(balance_at(account, D + timedelta(day))), account=account)
        for account, day in raw_asserts
    ]
    known = {a: opening.get(a, Decimal("0")) for a in ("chq", "visa")}
    assert check(rows, assertions, opening=known if pass_it else {}) == []
