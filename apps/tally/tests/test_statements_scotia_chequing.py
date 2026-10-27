from datetime import date
from decimal import Decimal

import pytest

from tally.model import AccountKind
from tally.parsers import ParseError
from tally.parsers.statements import Page, Word, identify
from tally.parsers.statements.scotia_chequing import FAMILY

FIRST = """MRAHOLDER Youraccountnumber:
1EXAMPLESTREET 000011112222
Questions? Call18004-SCOTIA
Your Basic Package account summary www.scotiabank.com
OpeningBalanceonDecember18,2020 $1,000.00
Minustotalwithdrawals $275.50
Plustotaldeposits $2,025.00
ClosingBalanceonJanuary17,2021 $2,749.50
Here's what happened in your account this statement period
Amounts Amounts
Date Transactions withdrawn($) deposited($) Balance($)
Dec18 OpeningBalance 1,000.00
Dec20 Pointofsalepurchase 50.50 949.50
CornerStoreTownNSCA
Dec31 Servicecharge 0.00 949.50
MB-FreeEmailMoneyTrf
Dec31 Payrolldep. 2,000.00 2,949.50
ExampleEmployerInc.
continuedonnextpage
Page1of2"""

SECOND = """MRAHOLDER
YourBasicPackageaccount
December18toJanuary17,2021 000011112222
Here's what happened in your account (continued)
Amounts Amounts
Date Transactions withdrawn($) deposited($) Balance($)
Jan4 Misc.payment 25.00 2,974.50
RefundCo
Jan15 Mortgagepayment 225.00 2,749.50
#000000-0
Jan17 ClosingBalance $2,749.50
Page2of2"""


def _statement(first: str = FIRST, second: str = SECOND):
    return FAMILY.parse([Page(text=first), Page(text=second)], origin="chequing.pdf")


def test_sniffs_page_one_and_leaves_the_visa_statement_alone():
    assert identify([FIRST, SECOND]) is FAMILY
    assert not FAMILY.sniff(["Statement Period Mar 2, 2021 -Apr 1, 2021 Scotia VISA"])


def test_rows_take_their_sign_from_the_running_balance():
    st = _statement()
    assert [r.amount for r in st.rows] == [
        Decimal("-50.50"),
        Decimal("2000.00"),
        Decimal("25.00"),
        Decimal("-225.00"),
    ]
    assert st.rows[2].balance_after == Decimal("2974.50")
    assert st.account_hint == "000011112222"
    assert st.account_kind is AccountKind.chequing
    assert {r.account_hint for r in st.rows} == {"000011112222"}


def test_the_counterparty_is_the_descriptor_and_the_type_is_the_memo():
    rows = _statement().rows
    assert (rows[0].descriptor, rows[0].memo) == ("CornerStoreTownNSCA", "Pointofsalepurchase")
    assert rows[3].descriptor == "#000000-0"
    assert not any("FreeEmail" in r.descriptor for r in rows)


def test_rows_are_dated_in_the_period_across_the_new_year():
    st = _statement()
    assert [r.date for r in st.rows] == [
        date(2020, 12, 20),
        date(2020, 12, 31),
        date(2021, 1, 4),
        date(2021, 1, 15),
    ]
    assert (st.date_from, st.date_to) == (date(2020, 12, 18), date(2021, 1, 17))


def test_opening_and_closing_balances_are_asserted_and_the_rows_bridge_them():
    st = _statement()
    opening, closing = st.assertions
    assert (opening.date, opening.balance) == (date(2020, 12, 17), Decimal("1000.00"))
    assert (closing.date, closing.balance) == (date(2021, 1, 17), Decimal("2749.50"))
    assert sum(r.amount for r in st.rows) == closing.balance - opening.balance
    assert {a.account_id for a in st.assertions} == {"000011112222"}
    assert {a.origin for a in st.assertions} == {"chequing.pdf"}


def test_a_savings_product_is_a_savings_account():
    first = FIRST.replace("Basic Package", "Momentum Savings")
    assert _statement(first).account_kind is AccountKind.savings


def test_margin_codes_left_of_the_date_column_stay_out_of_the_rows():
    cells = [
        (100, 73, "Date"),
        (100, 113, "Transactions"),
        (120, 21, "-"),
        (120, 73, "Dec20"),
        (120, 113, "Pointofsalepurchase"),
        (120, 278, "50.50"),
        (120, 400, "949.50"),
        (129, 21, "0000_ZZZ"),
        (129, 113, "CornerStoreTownNSCA"),
        (150, 73, "Jan17"),
        (150, 113, "ClosingBalance"),
    ]
    words = tuple(Word(text, x, x + 5 * len(text), top) for top, x, text in cells)
    first = (
        FIRST.replace("$275.50", "$50.50")
        .replace("$2,025.00", "$0.00")
        .replace("$2,749.50", "$949.50")
    )
    st = FAMILY.parse([Page(text=first, words=words)], origin="chequing.pdf")
    assert [(r.amount, r.descriptor) for r in st.rows] == [
        (Decimal("-50.50"), "CornerStoreTownNSCA")
    ]


def test_an_amount_that_disagrees_with_the_running_balance_is_refused():
    with pytest.raises(ParseError, match="running balance"):
        _statement(FIRST.replace("50.50 949.50", "60.50 949.50"))


def test_rows_that_miss_the_summary_totals_are_refused():
    with pytest.raises(ParseError, match="summary"):
        _statement(FIRST.replace("$2,025.00", "$2,000.00"))


def test_missing_closing_balance_is_a_parse_error_naming_the_field():
    first = FIRST.replace("ClosingBalanceonJanuary17,2021 $2,749.50", "")
    with pytest.raises(ParseError, match="closing balance"):
        _statement(first)
