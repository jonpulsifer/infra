from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import openpyxl
import pytest

from tally import parsers
from tally.model import AccountKind
from tally.parsers import ParseError, xlsx


def row(
    when: object,
    action: str | None,
    symbol: str | None,
    desc: str,
    net: object,
    activity: str,
    account: str = "90000001",
    account_type: str = "Individual TFSA",
    currency: str = "CAD",
) -> list[object]:
    return [when, when, action, symbol, desc, "0.00000", "0.00000000", net, "0.00", net,
            currency, account, activity, account_type]  # fmt: skip


def workbook(
    tmp_path: Path, rows: list[list[object]], header: tuple[str, ...] = xlsx.HEADER
) -> Path:
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(list(header))
    for r in rows:
        ws.append(r)
    path = tmp_path / "Activities.xlsx"
    wb.save(path)
    return path


def test_cash_rows(tmp_path: Path) -> None:
    path = workbook(
        tmp_path,
        [
            row("15/01/2033 12:00:00 AM", "CON", None, "CONTRIBUTION  ", "500.00", "Deposits"),
            row("16/01/2033 12:00:00 AM", "Buy", "ABC.TO", "ABC   INDEX ETF", "-499.95", "Trades"),
            row(datetime(2033, 2, 1), None, "ABC.TO", "CASH DIV", 1.234, "Dividends"),
            row("20/02/2033 12:00:00 AM", "TF6", "XYZ", "TRANSFER IN KIND", "0.00", "Transfers"),
        ],
    )

    pf = xlsx.parse(path)

    assert pf.institution == "Questrade"
    assert pf.profile_id == "questrade-activities"
    assert pf.account_kind_hint is AccountKind.investment
    assert pf.account_hint == "90000001 Individual TFSA"
    assert [(r.date, r.amount, r.descriptor, r.memo) for r in pf.rows] == [
        (date(2033, 1, 15), Decimal("500.00"), "CON CONTRIBUTION", "Deposits"),
        (date(2033, 1, 16), Decimal("-499.95"), "Buy ABC.TO ABC INDEX ETF", "Trades"),
        (date(2033, 2, 1), Decimal("1.23"), "ABC.TO CASH DIV", "Dividends"),
    ]
    assert (pf.date_from, pf.date_to) == (date(2033, 1, 15), date(2033, 2, 1))


def test_foreign_currency_rows_are_left_out(tmp_path: Path) -> None:
    path = workbook(
        tmp_path,
        [
            row(
                "13/03/2033 12:00:00 AM", "Buy", "US", "US ETF", "-10.00", "Trades", currency="USD"
            ),
            row("14/03/2033 12:00:00 AM", "FCH", None, "FEE", "-1.00", "Fees and rebates"),
        ],
    )
    pf = xlsx.parse(path)
    assert [r.amount for r in pf.rows] == [Decimal("-1.00")]


def test_two_accounts_leave_the_file_account_open(tmp_path: Path) -> None:
    path = workbook(
        tmp_path,
        [
            row(datetime(2033, 3, 1), "CON", None, "C", "1.00", "Deposits", account="1"),
            row(datetime(2033, 3, 1), "CON", None, "C", "2.00", "Deposits", account="2"),
        ],
    )
    pf = xlsx.parse(path)
    assert pf.account_hint is None
    assert [r.account_hint for r in pf.rows] == ["1 Individual TFSA", "2 Individual TFSA"]


def test_wrong_header_names_columns_only(tmp_path: Path) -> None:
    path = workbook(tmp_path, [["PRIVATE", "42.00"]], header=("Date", "Amount"))
    with pytest.raises(ParseError, match=r"2 columns, header \['Date', 'Amount'\]") as err:
        xlsx.parse(path)
    assert "PRIVATE" not in str(err.value)


def test_a_header_shaped_data_row_is_never_echoed(tmp_path: Path) -> None:
    cells = ("Jan 5 note", "ACME CAFE ref 998877", "Acct 5500123456")
    path = workbook(tmp_path, [["Feb 6 note", "OTHER", "Acct 1"]], header=cells)
    with pytest.raises(ParseError, match="3 columns, an unrecognised header row") as err:
        xlsx.parse(path)
    for text in (*cells, "998877", "5500123456", "ACME"):
        assert text not in str(err.value)


def test_month_first_dates(tmp_path: Path) -> None:
    path = workbook(tmp_path, [row("01/25/2033 12:00:00 AM", "CON", None, "C", "1.00", "Deposits")])
    assert xlsx.parse(path).rows[0].date == date(2033, 1, 25)


def test_ambiguous_dates_raise_until_named(tmp_path: Path) -> None:
    path = workbook(tmp_path, [row("03/04/2033 12:00:00 AM", "CON", None, "C", "1.00", "Deposits")])
    with pytest.raises(ParseError, match="'Transaction Date' reads as"):
        xlsx.parse(path)
    named = xlsx.parse(path, date_format="%d/%m/%Y %I:%M:%S %p")
    assert named.rows[0].date == date(2033, 4, 3)


def test_bad_date_raises_without_value(tmp_path: Path) -> None:
    path = workbook(tmp_path, [row("someday", "CON", None, "C", "1.00", "Deposits")])
    with pytest.raises(ParseError, match="no known date format") as err:
        xlsx.parse(path)
    assert "someday" not in str(err.value)


def test_not_a_workbook(tmp_path: Path) -> None:
    path = tmp_path / "fake.xlsx"
    path.write_bytes(b"PK\x03\x04 not really a zip")
    with pytest.raises(ParseError, match="not a readable xlsx"):
        xlsx.parse(path)


@pytest.mark.parametrize(
    ("memo", "kind"),
    [
        ("Deposits", "transfer"),
        ("Transfers", "transfer"),
        ("Trades", "trade"),
        ("Dividends", "dividend"),
        ("Fees and rebates", "fee"),
        ("Other", "fee"),
        ("Something new", None),
    ],
)
def test_kind_of(memo: str, kind: str | None) -> None:
    assert xlsx.kind_of(memo) == kind


def test_registered_and_dispatched(tmp_path: Path) -> None:
    path = workbook(tmp_path, [row("21/05/2033 12:00:00 AM", "CON", None, "C", "5.00", "Deposits")])
    assert parsers.parse(path).profile_id == "questrade-activities"
