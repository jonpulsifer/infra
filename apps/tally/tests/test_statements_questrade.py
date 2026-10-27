from datetime import date
from decimal import Decimal

import pytest

from tally.model import AccountKind
from tally.parsers import ParseError
from tally.parsers.statements import Page, identify
from tally.parsers.statements.questrade import FAMILY

COVER = """Get the most out of your statement
Current month balance: $10,450.00
ACCOUNT STATEMENT
A HOLDER Account #: 00000001 Current month: March 31, 2021
Type: Individual Registered Retirement Savings Plan (RRSP)
Current month FX rate: $1.00 USD = $ 1.2500 CAD Previous month FX rate: $1.00 USD = $1.2400 CAD
Questrade, Inc. All rights reserved."""

HOLDINGS = """ACCOUNT STATEMENT
05. INVESTMENT DETAILS
Symbol Description Qty Segr. Cost/share Pos. cost Mkt. price Mkt. value P&L % return % port.
Securities held in CAD
ZZA NORTHWIND GLOBAL EQUITY BK 100 100 20.00 2,000.00 25.00 2,500.00 500.00 25.00 23.92
INDEX ETF UNIT
NORTHWIND CANADA
ZZB BK 200 200 30.00 6,000.00 28.00 5,600.00 (400.00) (6.67) 53.59
BOND INDEX ETF
Securities held in USD
ZZC NORTHWIND US TOTAL BK 10 10 150.00 1,500.00 160.00 1,600.00 100.00 6.67 19.14
Current month FX rate: $1.00 USD = $ 1.2500 CAD"""

CASH = """ACCOUNT STATEMENT
05. INVESTMENT DETAILS
Cash
CAD USD Combined in CAD USD Combined in
Owned 350.00 - 350.00 300.00 - 300.00"""

ACTIVITY = """ACCOUNT STATEMENT
06. ACTIVITY DETAILS
Transactions
Trans. date Settle date Activity type Symbol Description Qty Price Gross Com. Net
Opening balance - - - - 100.00 - - - -
NORTHWIND GLOBAL EQUITY|INDEX ETF UNIT|WE
3/2/2021 3/4/2021 Buy .ZZA 10 25.000 (250.00) (4.95) (254.95) - - - -
ACTED AS AGENT
3/15/2021 3/15/2021 Contribution CON 1234567 - - - - 500.00 - - - -
3/20/2021 3/22/2021 Dividends .ZZC - - - - - - 5.00 - 5.00
Closing balance - - - - 345.05 - - - -"""

UNSETTLED = """ACCOUNT STATEMENT
07. TRADES TO SETTLE AFTER MONTH END
ACTIVITY DETAILS
Trans. date Settle date Activity type Symbol Description Qty Price Gross Com. Net
3/31/2021 4/2/2021 Buy .ZZB 1 28.000 (28.00) (4.95) (32.95) - - - -"""


def _statement(*pages: str):
    texts = pages or (COVER, HOLDINGS, CASH, ACTIVITY, UNSETTLED)
    return FAMILY.parse([Page(text=t) for t in texts], origin="2021-03.pdf")


def test_sniffs_the_cover_page():
    assert identify([COVER]) is FAMILY


def test_holdings_snapshot_converts_usd_and_adds_cash():
    (snap,) = _statement().holdings
    assert (snap.account_id, snap.date, snap.total) == (
        "00000001",
        date(2021, 3, 31),
        Decimal("10450.00"),
    )
    assert snap.origin == "statement-pdf"
    by_symbol = {p.symbol: p for p in snap.positions}
    assert set(by_symbol) == {"ZZA", "ZZB", "ZZC", "CASH"}
    assert by_symbol["ZZA"].name == "NORTHWIND GLOBAL EQUITY INDEX ETF UNIT"
    assert by_symbol["ZZB"].name == "NORTHWIND CANADA BOND INDEX ETF"
    assert by_symbol["ZZB"].book_cost == Decimal("6000.00")
    assert by_symbol["ZZC"].market_value == Decimal("2000.00")
    assert by_symbol["ZZC"].price == Decimal("200.0000")
    assert by_symbol["CASH"].market_value == Decimal("350.00")


def test_cash_activity_rows_are_cad_settled_and_skip_unsettled_and_usd():
    st = _statement()
    assert [(r.date, r.amount) for r in st.rows] == [
        (date(2021, 3, 4), Decimal("-254.95")),
        (date(2021, 3, 15), Decimal("500.00")),
    ]
    assert st.rows[0].descriptor == "Buy .ZZA NORTHWIND GLOBAL EQUITY INDEX ETF UNIT"
    assert st.rows[1].descriptor == "Contribution CON"
    assert st.rows[1].memo == "reference 1234567"
    assert sum(r.amount for r in st.rows) == Decimal("345.05") - Decimal("100.00")
    assert st.account_kind is AccountKind.investment
    assert (st.date_from, st.date_to) == (date(2021, 3, 1), date(2021, 3, 31))


def test_an_empty_account_is_a_zero_snapshot():
    cover = COVER.replace("Current month balance: $10,450.00", "Current month balance:")
    (snap,) = _statement(cover).holdings
    assert (snap.total, snap.positions) == (Decimal(0), ())


def test_positions_that_miss_the_total_are_refused():
    cover = COVER.replace("$10,450.00", "$10,999.00")
    with pytest.raises(ParseError, match="do not add up"):
        _statement(cover, HOLDINGS, CASH)


def test_a_transaction_line_with_missing_columns_is_refused():
    broken = ACTIVITY.replace("(254.95) - - - -", "(254.95) - - -")
    with pytest.raises(ParseError, match="column count"):
        _statement(COVER, HOLDINGS, CASH, broken)
