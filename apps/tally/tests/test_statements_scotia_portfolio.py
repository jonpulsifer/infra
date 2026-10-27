from datetime import date
from decimal import Decimal

import pytest

from tally.parsers import ParseError
from tally.parsers.statements import Page, identify
from tally.parsers.statements.scotia_portfolio import FAMILY

NEW_COVER = """Your Investments
EXAMPLE BRANCH (00000)
January 1 toMarch 31, 2021
Here's where you can reach us Website www.scotiabank.com
Keep track of your portfolio with the 2021 Personal Portfolio Statement."""

LRSP = """Your account details
99.90% OF YOUR TOTAL PORTFOLIO
LRSP #000000000000001
Your registered account withScotia Securities Inc.
ACCOUNT VALUE $15,010.00
Details of your investments
Cash and Savings Accelerator
VALUE AT VALUE AT
DEC 31, 2020 ($) MAR 31, 2021 ($)
CAD Cash - Registered Plan 5.00 10.00
TOTAL CASH HELD WITH SCOTIA SECURITIES INC. $10.00
Mutual Funds
DESCRIPTION COST ($) UNIT COST ($) # UNITS PRICE ($) MAR 31, 2021 ($)
FOREIGN EQUITY
EXAMPLE GROWTH 9,000.00 10.00 900.000 11.1111 10,000.00
PORTFOLIO
CANADIAN EQUITY
EXAMPLE DIVIDEND 4,500.00 9.00 500.000 10.0000 5,000.00
CLASS A
000000-00-0-0- TOTAL MUTUAL FUNDS $13,500.00 $15,000.00"""

TFSA = """Your account details
0.10% OF YOUR TOTAL PORTFOLIO
TFSA #000000000000002
ACCOUNT VALUE $0.00
Details of your investments
Cash and Savings Accelerator
CAD Cash - TFSA 0.00 0.00
TOTAL CASH HELD $0.00"""

OLD = """Personal Portfolio Statement
Scotiabank
October 1 to December 31, 2014
Your investments through Scotiabank
Details of your tax free investments
TFSA Designated beneficiary: NONE ON FILE
#00000003
Sep 30, 2014 ($) Dec 31, 2014 ($)
Total value of your plan 0.00 25.00
Details of your investments
Cash and High Interest Savings Value at Value at
Sep 30, 2014 ($) Dec 31, 2014 ($)
CAD Cash - TFSA 0.00 25.00
Total held with The Bank of Nova Scotia 0.00 25.00"""


def test_sniffs_both_layouts():
    assert identify([NEW_COVER]) is FAMILY
    assert identify([OLD]) is FAMILY


def test_new_layout_snapshots_every_plan():
    st = FAMILY.parse([Page(NEW_COVER), Page(LRSP), Page(TFSA)], origin="q1.pdf")
    lrsp, tfsa = st.holdings
    assert (lrsp.account_id, lrsp.date, lrsp.total) == (
        "000000000000001",
        date(2021, 3, 31),
        Decimal("15010.00"),
    )
    assert [p.name for p in lrsp.positions] == [
        "CAD Cash - Registered Plan",
        "EXAMPLE GROWTH PORTFOLIO",
        "EXAMPLE DIVIDEND CLASS A",
    ]
    fund = lrsp.positions[1]
    assert (fund.quantity, fund.price, fund.book_cost) == (
        Decimal("900.000"),
        Decimal("11.1111"),
        Decimal("9000.00"),
    )
    assert (tfsa.total, tfsa.positions) == (Decimal("0.00"), ())
    assert st.account_hint is None
    assert (st.date_from, st.date_to) == (date(2021, 1, 1), date(2021, 3, 31))
    assert st.rows == () and st.assertions == ()


def test_old_layout_reads_plan_value_and_cash():
    st = FAMILY.parse([Page(OLD)], origin="q4.pdf")
    (snap,) = st.holdings
    assert (snap.account_id, snap.total) == ("00000003", Decimal("25.00"))
    assert [(p.symbol, p.market_value) for p in snap.positions] == [("CASH", Decimal("25.00"))]
    assert st.account_hint == "00000003"


def test_a_plan_whose_holdings_miss_its_value_is_refused():
    with pytest.raises(ParseError, match="do not add up"):
        FAMILY.parse([Page(NEW_COVER), Page(LRSP.replace("$15,010.00", "$15,500.00"))], "q1.pdf")


def test_a_statement_with_no_plan_is_refused():
    with pytest.raises(ParseError, match="no plan"):
        FAMILY.parse([Page(NEW_COVER)], "q1.pdf")
