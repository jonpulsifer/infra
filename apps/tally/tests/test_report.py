from datetime import date
from decimal import Decimal

from tally import report
from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    Category,
    Flow,
    HoldingSnapshot,
    Ledger,
    Member,
    Position,
    Transaction,
    Valuation,
)
from tally.synthetic import build_ledger

D = Decimal

CATS = (
    Category(id="income", name="Income", parent_id=None, flow=Flow.income),
    Category(id="salary", name="Salary", parent_id="income", flow=Flow.income),
    Category(id="food", name="Food", parent_id=None, flow=Flow.expense),
    Category(id="groceries", name="Groceries", parent_id="food", flow=Flow.expense),
    Category(id="coffee", name="Coffee", parent_id="food", flow=Flow.expense),
    Category(id="transfer", name="Transfer", parent_id=None, flow=Flow.transfer),
    Category(id="uncategorized", name="Uncategorized", parent_id=None, flow=Flow.expense),
)


def acct(id_, kind):
    return Account(id=id_, name=id_, institution="Test", kind=kind, since=date(2030, 1, 1))


def tx(id_, account, on, amount, merchant="Shop", category="groceries", transfer=None):
    return Transaction(
        id=id_,
        account_id=account,
        date=on,
        amount=D(amount),
        descriptor=merchant.upper(),
        merchant=merchant,
        category_id=category,
        transfer_id=transfer,
        batch_id="b",
    )


def ledger(transactions, **extra):
    return Ledger(
        id="t",
        members=(Member(login="owner@example.com", role="owner"),),
        accounts=(
            acct("chq", AccountKind.chequing),
            acct("card", AccountKind.credit),
            acct("tfsa", AccountKind.investment),
            acct("home", AccountKind.asset),
            acct("loan", AccountKind.mortgage),
        ),
        categories=CATS,
        transactions=tuple(transactions),
        **extra,
    )


SMALL = ledger(
    [
        tx("a", "chq", date(2030, 1, 15), "3000.00", "Employer", "salary"),
        tx("b", "card", date(2030, 1, 16), "-80.25", "Grocer"),
        tx("c", "card", date(2030, 1, 17), "-4.50", "Cafe", "coffee"),
        tx("d", "chq", date(2030, 2, 2), "-84.75", "Card", "transfer", transfer="x1"),
        tx("e", "card", date(2030, 2, 3), "84.75", "Card", "transfer", transfer="x1"),
        tx("f", "card", date(2030, 2, 5), "-19.50", "Grocer"),
        tx("g", "card", date(2030, 2, 6), "-10.00", "Mystery", "no-such-category"),
        tx("h", "card", date(2030, 2, 7), "5.00", "Grocer"),
    ]
)


def test_spend_excludes_transfers_and_income_and_rolls_up():
    spend = report.monthly_spend_by_category(SMALL)
    assert spend.keys == ["food", "uncategorized"]
    assert spend.names == {"food": "Food", "uncategorized": "Uncategorized"}
    assert [(r.month, r.totals) for r in spend.rows] == [
        ("2030-01", {"food": D("84.75")}),
        ("2030-02", {"food": D("19.50"), "uncategorized": D("10.00")}),
    ]
    leaf = report.monthly_spend_by_category(SMALL, start="2030-02", level="leaf")
    assert leaf.keys == ["groceries", "no-such-category"]


def test_month_filters_compare_month_strings():
    assert report.monthly_spend_by_category(SMALL, start="2030-01-01").rows[0].month == "2030-02"


def test_top_merchants_sorted_by_total():
    top = report.top_merchants(SMALL, limit=2)
    assert [(m.merchant, m.total, m.count) for m in top] == [
        ("Grocer", D("99.75"), 2),
        ("Mystery", D("10.00"), 1),
    ]
    assert report.top_merchants(SMALL, start=date(2030, 2, 6))[0].merchant == "Mystery"


def test_cash_flow_has_a_row_for_every_month_with_rows():
    rows = report.cash_flow(SMALL)
    assert [(r.month, r.income, r.spend, r.net) for r in rows] == [
        ("2030-01", D("3000.00"), D("84.75"), D("2915.25")),
        ("2030-02", D(0), D("29.50"), D("-29.50")),
    ]


def test_balances_by_month_run_per_account():
    bal = report.balances_by_month(SMALL)
    assert bal["chq"] == {"2030-01": D("3000.00"), "2030-02": D("2915.25")}
    assert bal["tfsa"] == {"2030-01": D(0), "2030-02": D(0)}


def test_net_worth_carries_snapshots_forward_and_flags_it():
    snap = HoldingSnapshot(
        account_id="tfsa",
        date=date(2030, 1, 31),
        positions=(
            Position(
                symbol="ETF",
                name="Fund",
                quantity=D(10),
                price=D(100),
                market_value=D(1000),
                book_cost=D(900),
            ),
        ),
        total=D(1000),
        origin="export",
    )
    led = SMALL.model_copy(
        update={
            "holdings": (snap,),
            "valuations": (
                Valuation(
                    account_id="home", date=date(2030, 2, 1), value=D(5000), source="estimate"
                ),
            ),
            "assertions": (
                BalanceAssertion(
                    account_id="loan", date=date(2030, 1, 31), balance=D(-4000), origin="t"
                ),
            ),
        }
    )
    jan, feb = report.net_worth_series(led)
    assert (jan.cash, jan.investments, jan.house, jan.mortgage) == (2915, 1000, 0, -4000)
    assert jan.total == 2915 + 1000 - 4000
    assert jan.estimated is False
    assert (feb.investments, feb.house, feb.mortgage) == (1000, 5000, -4000)
    assert feb.estimated is True


def test_sankey_flows_income_to_groups_to_leaves_and_saves_the_rest():
    s = report.sankey(SMALL, start=date(2030, 1, 1), end=date(2030, 2, 28))
    links = {(link.source, link.target): link.value for link in s.links}
    assert links[("src:Employer", "all")] == 3000
    assert links[("all", "grp:food")] == 104
    assert links[("grp:food", "leaf:groceries")] == 100
    assert links[("all", "grp:uncategorized")] == 10
    assert ("grp:uncategorized", "leaf:uncategorized") not in links
    assert links[("all", "leaf:saved")] == 2886
    assert [n.id for n in s.nodes][-2:] == ["all", "leaf:saved"]


def test_account_balance_by_kind():
    assert report.account_balance(SMALL, "card") == D("-24.50")
    assert report.account_balance(SMALL, "tfsa") == 0
    assert report.account_balance(SMALL, "nope") == 0


def test_search_is_newest_first_and_matches_top_level():
    hits = report.search_transactions(SMALL, category_id="food")
    assert [t.id for t in hits] == ["h", "f", "c", "b"]
    assert [t.id for t in report.search_transactions(SMALL, text=" grocer ", limit=2)] == ["h", "f"]
    assert report.search_transactions(SMALL, account_id="chq", end=date(2030, 1, 31))[0].id == "a"


def test_js_round_ties_toward_positive_infinity():
    assert report.js_round(D("2.5")) == 3
    assert report.js_round(D("-2.5")) == -2
    assert report.js_round(D("-2.51")) == -3


def test_to_json_gives_the_web_shape():
    row = report.to_json(report.monthly_spend_by_category(SMALL).rows[0])
    assert row == {"month": "2030-01", "food": 84.75}
    t = report.to_json(SMALL.transactions[1])
    assert isinstance(t, dict)
    assert t["accountId"] == "card"
    assert t["amount"] == -80.25
    assert t["date"] == "2030-01-16"
    assert t["transferId"] is None
    nw = report.to_json(report.net_worth_series(SMALL)[0])
    assert nw == {
        "month": "2030-01",
        "cash": 2915,
        "investments": 0,
        "house": 0,
        "mortgage": 0,
        "total": 2915,
        "estimated": False,
    }


def test_synthetic_aggregates_match_the_web_fixture():
    """Golden numbers from derive.ts over generate.ts at seed 1337, run under bun."""
    led = build_ledger(1337)
    last = report.net_worth_series(led)[-1]
    assert (last.cash, last.investments, last.house, last.mortgage, last.total) == (
        -17815,
        103059,
        705000,
        -337526,
        452719,
    )
    assert last.estimated is True
    top = report.top_merchants(led, start=date(2025, 1, 1), end=date(2025, 12, 31), limit=2)
    assert [(m.merchant, m.total, m.count) for m in top] == [
        ("Mortgage", D("63360.00"), 24),
        ("Little Sprouts", D("14180.13"), 12),
    ]
    s = report.sankey(led, start=date(2026, 1, 1), end=date(2026, 9, 30))
    assert (len(s.nodes), len(s.links)) == (31, 29)
    assert next(link.value for link in s.links if link.target == "leaf:saved") == 24103
    flow = report.cash_flow(led)[-1]
    assert (flow.income, flow.spend) == (D("4850.00"), D("8337.67"))
    assert report.account_balance(led, "rbc-chq") == D("78178.38")
    assert report.account_balance(led, "qt-rrsp") == D("52871.30")
