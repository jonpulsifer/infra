from datetime import date
from decimal import Decimal

import pytest

from tally.parsers import ParseError
from tally.parsers.statements import Page, identify
from tally.parsers.statements.shareworks import FAMILY

STATEMENT = """Example Holder Statement of Account
1 Example Street Statement Period: 01-Mar-2031 to 31-Aug-2031
Townville ON A1A 1A1 Account Number: CS-123456-01
Canada Company: Example Corp.
Price History Over Statement Period
01-Mar-2031 31-Aug-2031 % Change
Example, Inc - Class A NYSE $10.00 $20.00 100%
All currencies are in US Dollars unless specified.
Account Summary
Total Quantity Available Future Available Quantity
Quantity Remainder of 2031 2032 2033 2034 and After
Share Units (RSU) 150 0 50 50 50 0
Stock Option 40 0 20 20
Total Value Available Value Future Available Value
Remainder of 2031 2032 2033 2034 and After
Share Units (RSU) $3,000.00 $0.00 $1,000.00 $1,000.00 $1,000.00 $0.00
Stock Option $400.00 $0.00 $200.00 $200.00
Total $3,400.00 $0.00 $1,200.00 $1,200.00 $1,000.00 $0.00
All currencies are in US Dollars unless specified.
Summary of Share Units (RSU)
Grant Name Market Price At Time Of Total Share Units Share Units Distributed Share Units Forfeited Share Units Outstanding
Grant Accumulated
2031-1-RSU-1 $10.00 200 50 0 150
200 50 0 150
Issued through Solium Capital"""  # noqa: E501

EXPORT = """Example Holder​ Account Summary​
2 Example Road​ Summary Period: 24-Feb-2031 to 06-May-2039​
Townville NS B2B 2B2​ Account Number: CS-654321-02​
Canada​ Company: Example Corp.​
Price History Over Summary Period​
​ 24-Feb-2031​ 06-May-2039​ % Change​
Example, Inc - Class A​ $10.00​ $30.000​ 200%​
NASDAQ​
All currencies are in US Dollars unless specified.​
Account Summary​
Total Quantity​ Available Quantity​
Share Units (RSU)​ 0​ 0​
Total Value​ Available Value​
Example Share Holdings USD​ $9,000.00​ $9,000.00​
All currencies are in US Dollars unless specified.​
Shareworks"""

OCR = """Example Holder Account Summary

Summary Period: 01-Jan-2031 to 31-May-2039

Account Number: CS-111111-03

Company: Example Corp.

## Price History Over Summary Period

|                                          | 01-Jan-2031   | 31-May-2039   | % Change   |
|------------------------------------------|---------------|---------------|------------|
| Example, Inc - Class A NASDAQ            | $10.00        | S100.00       | 900%       |
| All currencies are in US Dollars unless specified. |     |               |            |

## Account Summary

## Summary of Non-Qualified Options

| Non-Qualified Options - Grant Name | Non-Qualified Options - Grant Price | Non-Qualified Options - Options Granted | Non-Qualified Options - Options Exercised | Non-Qualified Options - Options Outstanding |
|---|---|---|---|---|
| 2031-1 | $40.00 | 1,000 | 900 | {opt} |
| | | 1,000 | 900 | {opt} |

## Summary of Share Units (RSU)

| Share Units (RSU) - Grant Name | Share Units (RSU) - Market Price At Time Of Grant | Share Units (RSU) - Total Share Units Accumulated | Share Units (RSU) - Share Units Distributed | Share Units (RSU) - Share Units Outstanding |
|---|---|---|---|---|
| 2031-1-RSU-1 | S10.00 | 2,000 | 1,990 | {rsu} |
| 2031-1-RSU-P | $12.00 | 100 | 100 | 0 |
| | | 2,100 | 2,090 | {rsu} |

Shareworks"""  # noqa: E501


def pages(text: str) -> list[Page]:
    return [Page(text=t) for t in text.split("\f")]


def test_a_statement_reads_the_account_summary_in_usd():
    assert identify([STATEMENT]) is FAMILY
    got = FAMILY.parse(pages(STATEMENT), "s.pdf")
    assert (got.institution, got.account_hint, got.currency) == (
        "Shareworks",
        "CS-123456-01",
        "USD",
    )
    assert (got.date_from, got.date_to) == (date(2031, 3, 1), date(2031, 8, 31))
    (snap,) = got.holdings
    assert snap.date == date(2031, 8, 31) and snap.total == Decimal("3400.00")
    by = {p.symbol: p for p in snap.positions}
    assert by["RSU"].quantity == 150 and by["RSU"].market_value == Decimal("3000.00")
    assert by["RSU"].price == Decimal("20.0000")
    assert by["OPTIONS"].quantity == 40 and by["OPTIONS"].market_value == Decimal("400.00")
    assert by["RSU"].name == "Example Corp. share units (rsu)"


def test_a_summary_export_with_zero_width_spaces_reads_its_holdings():
    got = FAMILY.parse(pages(EXPORT), "e.pdf")
    (snap,) = got.holdings
    (shares,) = snap.positions
    assert (shares.symbol, shares.market_value, snap.total) == (
        "SHARES",
        Decimal("9000.00"),
        Decimal("9000.00"),
    )
    assert snap.date == date(2039, 5, 6)


def test_an_ocr_scan_values_outstanding_grants_at_the_closing_price():
    got = FAMILY.parse(pages(OCR.format(opt="100", rsu="10")), "scan.pdf")
    (snap,) = got.holdings
    by = {p.symbol: p for p in snap.positions}
    assert by["RSU"].quantity == 10 and by["RSU"].market_value == Decimal("1000.00")
    assert by["OPTIONS"].quantity == 100 and by["OPTIONS"].market_value == Decimal("6000.00")
    assert snap.total == Decimal("7000.00")


def test_an_ocr_scan_of_a_fully_released_plan_is_an_empty_snapshot():
    got = FAMILY.parse(pages(OCR.format(opt="0", rsu="0")), "scan.pdf")
    (snap,) = got.holdings
    assert snap.positions == () and snap.total == 0 and snap.date == date(2039, 5, 31)


def test_a_slip_that_merely_names_solium_is_not_claimed():
    assert identify(["T5008 Statement of Securities Transactions", "Solium Capital"]) is None


def test_a_statement_whose_positions_miss_the_total_is_refused():
    broken = STATEMENT.replace("Total $3,400.00", "Total $9,999.00")
    with pytest.raises(ParseError, match="do not add up"):
        FAMILY.parse(pages(broken), "s.pdf")


def test_a_document_with_no_holdings_tables_is_refused():
    head = "\n".join(STATEMENT.splitlines()[:8]) + "\nShareworks"
    with pytest.raises(ParseError, match="no holdings found"):
        FAMILY.parse(pages(head), "s.pdf")
