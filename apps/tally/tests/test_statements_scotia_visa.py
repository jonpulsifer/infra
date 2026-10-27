from datetime import date
from decimal import Decimal

import pytest

from tally.model import AccountKind
from tally.parsers import ParseError
from tally.parsers.statements import Page, Word, identify
from tally.parsers.statements.scotia_visa import FAMILY

SUMMARY = """Statement Period Mar 2, 2021 -Apr 1, 2021
Statement date Apr 1, 2021
Account # 0000 111 222 333 444
Scotia Momentum VISA Infinite Card
Borrowers on this account; Previous balance,Mar 1/21 $100.00
A HOLDER Interest + $1.50
Payments/credits - $100.00
Purchases/charges + $62.75
New balance = $64.25"""

TRANSACTIONS = """Transactions since your last statement
TRANS. POST
REF.# DATE DATE DETAILS AMOUNT($)
A HOLDER -0000 111 222 333444
001 Mar 3 Mar 4 BLUE HERON BAKERYOTTAWAON 12.50
(APPLE PAY)
002 Mar 5 Mar 5 PC PAYMENT FROM *****00*0000 100.00-
003 Mar 30 Apr 1 CAFE LUNA LISBONAMT 14.75
10.00 EURO
9 004 Apr 1 Apr 1 35.50
WWW.EXAMPLE.TEST
SUB-TOTAL CREDITS-0000 111 222 333444 $100.00-
Continued on next page"""


def _statement(first: str = SUMMARY, rest: str = TRANSACTIONS):
    return FAMILY.parse([Page(text=first), Page(text=rest)], origin="visa.pdf")


def test_sniffs_page_one_and_leaves_other_banks_alone():
    assert identify([SUMMARY, TRANSACTIONS]) is FAMILY
    assert not FAMILY.sniff(["Statement Period Mar 2, 2021 -Apr 1, 2021 Mastercard"])


def test_rows_sign_purchases_negative_and_credits_positive():
    st = _statement()
    assert [r.amount for r in st.rows] == [
        Decimal("-12.50"),
        Decimal("100.00"),
        Decimal("-14.75"),
        Decimal("-35.50"),
        Decimal("-1.50"),
    ]
    assert st.account_hint == "0000111222333444"
    assert st.account_kind is AccountKind.credit
    assert {r.account_hint for r in st.rows} == {"0000111222333444"}


def test_rows_date_by_posting_and_keep_the_transaction_date_in_the_memo():
    first = _statement().rows[0]
    assert first.date == date(2021, 3, 4)
    assert first.descriptor == "BLUE HERON BAKERYOTTAWAON"
    assert first.memo == "(APPLE PAY) transaction date 2021-03-03"


def test_foreign_amount_and_wrapped_details_stay_out_of_the_descriptor():
    rows = _statement().rows
    assert rows[2].descriptor == "CAFE LUNA LISBON"
    assert "10.00 EURO" in rows[2].memo
    assert rows[3].descriptor == "WWW.EXAMPLE.TEST"


def test_summary_interest_becomes_a_row_so_the_balances_reconcile():
    st = _statement()
    opening, closing = st.assertions
    assert (opening.date, opening.balance) == (date(2021, 3, 1), Decimal("-100.00"))
    assert (closing.date, closing.balance) == (date(2021, 4, 1), Decimal("-64.25"))
    assert sum(r.amount for r in st.rows) == closing.balance - opening.balance
    assert st.rows[-1].descriptor == "INTEREST CHARGES"
    assert {a.origin for a in st.assertions} == {"visa.pdf"}


def test_a_credit_balance_is_positive():
    first = SUMMARY.replace("New balance = $64.25", "New balance = $20.00 CR")
    assert _statement(first).assertions[-1].balance == Decimal("20.00")


def test_year_rolls_back_for_december_rows_on_a_january_statement():
    first = SUMMARY.replace("Mar 2, 2021 -Apr 1, 2021", "Dec 2, 2020 -Jan 1, 2021")
    rest = "001 Dec 30 Dec 31 SNOW PLOW CO 40.00\n002 Dec 31 Jan 1 HOT COCOA 3.00"
    rows = _statement(first, rest).rows
    assert [r.date for r in rows[:2]] == [date(2020, 12, 31), date(2021, 1, 1)]


def test_the_first_statement_has_no_opening_assertion_without_a_start():
    first = SUMMARY.replace("Mar 2, 2021 -Apr 1, 2021", "-Apr 1, 2021").replace(
        "Previous balance,Mar 1/21 $100.00", "Previous balance $0.00"
    )
    assert len(_statement(first).assertions) == 1


def test_a_blank_after_the_amount_marks_a_credit():
    words = tuple(
        Word(text, x, x + 5 * len(text), 100.0, blank_after=(text == "9.99"))
        for x, text in zip(
            range(0, 400, 40),
            ["005", "Mar", "6", "Mar", "6", "REFUND", "SHOP", "9.99"],
            strict=False,
        )
    )
    st = FAMILY.parse([Page(text=SUMMARY), Page(text="", words=words)], origin="visa.pdf")
    assert st.rows[0].amount == Decimal("9.99")


def test_missing_new_balance_is_a_parse_error_naming_the_field():
    with pytest.raises(ParseError, match="new balance"):
        _statement(SUMMARY.replace("New balance = $64.25", ""))
