"""The Questrade Activities export: one sheet, 14 headed columns.

Every row whose Net Amount moves cash becomes a ParsedRow in the account
named by Account # plus Account Type. Rows with no cash effect (a security
moved in kind) and rows not in CAD are left out; the ledger is CAD only.
`ACTIVITY_KINDS` says how the engine should read each Activity Type.
"""

from __future__ import annotations

import warnings
import zipfile
from collections.abc import Iterator
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

import openpyxl
from openpyxl.utils.exceptions import InvalidFileException

from tally.model import CENT, AccountKind, ParsedFile, ParsedRow
from tally.parsers import ParseError, register, sha256_of
from tally.parsers.profiles import describe_header
from tally.parsers.profiles.base import DateFormatError, detect_date_format, norm, parse_date

PROFILE_ID = "questrade-activities"
HEADER = (
    "Transaction Date",
    "Settlement Date",
    "Action",
    "Symbol",
    "Description",
    "Quantity",
    "Price",
    "Gross Amount",
    "Commission",
    "Net Amount",
    "Currency",
    "Account #",
    "Activity Type",
    "Account Type",
)
_COL = {h: i for i, h in enumerate(HEADER)}
DATE_FORMATS = (
    "%d/%m/%Y %I:%M:%S %p",
    "%m/%d/%Y %I:%M:%S %p",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
)

Kind = Literal["transfer", "trade", "dividend", "interest", "fee"]
ACTIVITY_KINDS: dict[str, Kind] = {
    "Deposits": "transfer",
    "Withdrawals": "transfer",
    "Transfers": "transfer",
    "Trades": "trade",
    "Dividends": "dividend",
    "Interest": "interest",
    "Fees and rebates": "fee",
    "Other": "fee",
}

Cell = object
SheetRow = tuple[Cell, ...]


def _text(cell: Cell) -> str:
    return "" if cell is None else " ".join(str(cell).split())


def _date(cell: Cell, fmt: str | None) -> date:
    if isinstance(cell, datetime):
        return cell.date()
    if isinstance(cell, date):
        return cell
    if fmt is None:
        raise ValueError("not a date")
    try:
        return parse_date(_text(cell), fmt)
    except ValueError:
        raise ValueError("not a date") from None


def _date_format(rows: list[SheetRow], name: str) -> str | None:
    col = _COL["Transaction Date"]
    texts = [_text(r[col]) for r in rows if col < len(r) and isinstance(r[col], str)]
    if not texts:
        return None
    try:
        return detect_date_format(texts, DATE_FORMATS)
    except DateFormatError as err:
        raise ParseError(f"{name}: column 'Transaction Date' {err}") from None


def _money(cell: Cell) -> Decimal:
    if isinstance(cell, bool) or cell is None:
        raise ValueError("not an amount")
    try:
        value = Decimal(str(cell).replace(",", "").replace("$", "").strip())
    except InvalidOperation:
        raise ValueError("not an amount") from None
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def kind_of(memo: str) -> Kind | None:
    """The engine reads a row's kind back from the memo the parser wrote."""
    return ACTIVITY_KINDS.get(memo)


def _row(row: SheetRow, n: int, fmt: str | None, name: str) -> ParsedRow | None:
    def col(h: str) -> Cell:
        return row[_COL[h]] if _COL[h] < len(row) else None

    if _text(col("Currency")).upper() != "CAD":
        return None
    try:
        amount = _money(col("Net Amount"))
        day = _date(col("Transaction Date"), fmt)
    except ValueError as err:
        raise ParseError(f"{name}: row {n}: {err}") from None
    if not amount:
        return None
    account = " ".join(filter(None, (_text(col("Account #")), _text(col("Account Type")))))
    return ParsedRow(
        account_hint=account or None,
        date=day,
        amount=amount,
        descriptor=" ".join(
            filter(None, (_text(col(h)) for h in ("Action", "Symbol", "Description")))
        ),
        memo=_text(col("Activity Type")),
    )


def _sheet(path: Path) -> Iterator[SheetRow]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, OSError) as err:
        raise ParseError(f"{path.name}: not a readable xlsx ({type(err).__name__})") from None
    try:
        yield from (tuple(r) for r in wb.worksheets[0].iter_rows(values_only=True))
    finally:
        wb.close()


def _check_header(row: SheetRow | None, name: str) -> None:
    cells = tuple(_text(c) for c in row or ())
    while cells and not cells[-1]:
        cells = cells[:-1]
    if tuple(norm(c) for c in cells) == tuple(norm(h) for h in HEADER):
        return
    shown = describe_header(cells, HEADER)
    raise ParseError(f"{name}: not a Questrade activities sheet: {len(cells)} columns, {shown}")


def parse(path: Path, date_format: str | None = None) -> ParsedFile:
    """`date_format` is the owner's answer when every day in the file is 12 or less."""
    sheet = _sheet(path)
    _check_header(next(sheet, None), path.name)
    data = [r for r in sheet if any(c is not None for c in r)]
    fmt = date_format or _date_format(data, path.name)
    got = (_row(r, n, fmt, path.name) for n, r in enumerate(data, start=1))
    rows = tuple(r for r in got if r is not None)
    days = [r.date for r in rows]
    accounts = {r.account_hint for r in rows}
    return ParsedFile(
        name=path.name,
        format="xlsx",
        institution="Questrade",
        account_hint=accounts.pop() if len(accounts) == 1 else None,
        account_kind_hint=AccountKind.investment,
        rows=rows,
        profile_id=PROFILE_ID,
        sha256=sha256_of(path),
        date_from=min(days, default=None),
        date_to=max(days, default=None),
    )


class XlsxParser:
    def sniff(self, path: Path, head: bytes) -> bool:
        return head.startswith(b"PK\x03\x04") and path.suffix.lower() in {".xlsx", ".xlsm"}

    def parse(self, path: Path) -> ParsedFile:
        return parse(path)


register(XlsxParser())
