"""Shareworks (Solium, now Morgan Stanley at Work) account statements and summary exports.

One document covers one period ("Statement Period" or "Summary Period") and
yields one holdings snapshot at the period's end, in the currency the
document declares (US dollars for a Shopify plan). Two routes to the
positions:

1. The "Account Summary" block, when the text layer has it: a quantity table
   ("Total Quantity ...") and a value table ("Total Value ...") with one row
   per instrument (share units, stock options, share holdings) and a "Total"
   row the positions must add up to.
2. The per-grant summary tables, which is all an OCR'd scan keeps: share
   units outstanding per grant at the period's closing price, and options
   outstanding per grant at the closing price less the grant price.

Docling writes a scan's tables as markdown rows and sometimes reads a dollar
sign as "S"; both are normalised before matching. A T5008 slip or a web
capture that merely mentions Solium has no period and is not claimed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal

from tally.model import AccountKind, HoldingSnapshot, Position
from tally.parsers import ParseError
from tally.parsers.statements import Page, Statement, check_total, money, month

NAME = "shareworks"
INSTITUTION = "Shareworks"

_PERIOD = re.compile(
    r"(?:Statement|Summary) Period:\s*(?P<sd>\d{1,2})-(?P<sm>[A-Za-z]{3})-(?P<sy>\d{4})\s*to\s*"
    r"(?P<ed>\d{1,2})-(?P<em>[A-Za-z]{3})-(?P<ey>\d{4})"
)
_ACCOUNT = re.compile(r"Account Number:\s*(?P<n>[A-Z]{1,3}-\d{3,}-\d+)")
_COMPANY = re.compile(r"Company:\s*(?P<c>[A-Za-z][A-Za-z0-9 .,&'-]*?)\s*(?:\||$)", re.M)
_PRICE = re.compile(r"Class A[^\n$]*?\$(?P<start>[\d,]+\.\d+)[^\n$]*?\$(?P<end>[\d,]+\.\d+)")
_USD = re.compile(r"US Dollars|USD")
_LABELS = (
    r"Share Units \(RSU\)|Stock Options?|Non-Qualified Options|[A-Z][A-Za-z ]+ Holdings(?: USD)?"
)
_VALUE_ROW = re.compile(rf"^(?P<label>{_LABELS})\s+\$(?P<v>[\d,]+\.\d+)")
_QTY_ROW = re.compile(rf"^(?P<label>{_LABELS})\s+(?P<q>[\d,]+(?:\.\d+)?)\b")
_TOTAL_ROW = re.compile(r"^Total\s+\$(?P<v>[\d,]+\.\d+)")
_QTY_HEAD = re.compile(r"^Total Quantity\b")
_VALUE_HEAD = re.compile(r"^Total Value\b")
_END_BLOCK = re.compile(r"^All currencies|^Summary of|^Page \d")
_GLITCH = re.compile(r"(?<![A-Za-z])S(?=\d)")


def _clean(text: str) -> str:
    return _GLITCH.sub("$", text.replace("​", ""))


def _number(cell: str) -> Decimal | None:
    s = cell.strip().replace(",", "").lstrip("$")
    if not s or s == "-":
        return None
    try:
        return Decimal(s)
    except ArithmeticError:
        return None


@dataclass(frozen=True)
class _Instrument:
    label: str
    value: Decimal
    quantity: Decimal


class Shareworks:
    name = NAME

    def sniff(self, texts: Sequence[str]) -> bool:
        joined = "\n".join(_clean(t) for t in texts[:2])
        return (
            any(n in t for t in texts for n in ("Shareworks", "Solium"))
            and _PERIOD.search(joined) is not None
        )

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        texts = [_clean(p.text) for p in pages]
        head = "\n".join(texts[:2])
        period = _PERIOD.search(head)
        if period is None:
            raise ParseError(f"{NAME}: statement period not found")
        start = date(int(period["sy"]), month(period["sm"]), int(period["sd"]))
        end = date(int(period["ey"]), month(period["em"]), int(period["ed"]))
        account_match = _ACCOUNT.search(head)
        if account_match is None:
            raise ParseError(f"{NAME}: account number not found")
        account = account_match["n"]
        company_match = _COMPANY.search(head)
        company = company_match["c"].strip() if company_match else "Shares"
        currency: Literal["CAD", "USD"] = "USD" if _USD.search(head) else "CAD"
        lines = [line.strip() for t in texts for line in t.splitlines() if line.strip()]
        price = _closing_price(head)
        positions, total = _from_summary(lines, company, price)
        if not positions:
            # A plan whose every grant has vested and been released holds nothing: an
            # empty snapshot, which is not the same as a document with no holdings tables.
            granted = _from_grants(lines, company, price)
            if granted is None:
                raise ParseError(f"{NAME}: no holdings found")
            positions = granted
        if total is not None:
            check_total(NAME, positions, total)
        snapshot = HoldingSnapshot(
            account_id=account,
            date=end,
            positions=tuple(positions),
            total=total
            if total is not None
            else sum((p.market_value for p in positions), Decimal()),
            origin="statement-pdf",
        )
        return Statement(
            institution=INSTITUTION,
            account_hint=account,
            account_kind=AccountKind.investment,
            date_from=start,
            date_to=end,
            holdings=(snapshot,),
            currency=currency,
        )


def _closing_price(head: str) -> Decimal | None:
    found = _PRICE.search(head)
    return money(found["end"]) if found else None


def _from_summary(
    lines: Sequence[str], company: str, price: Decimal | None
) -> tuple[list[Position], Decimal | None]:
    """Route 1: the Account Summary's quantity and value tables."""
    quantities: dict[str, Decimal] = {}
    values: dict[str, Decimal] = {}
    total: Decimal | None = None
    section: str | None = None
    for line in lines:
        if _QTY_HEAD.match(line):
            section = "qty"
            continue
        if _VALUE_HEAD.match(line):
            section = "value"
            continue
        if section and _END_BLOCK.match(line):
            section = None
            continue
        if section == "qty" and (m := _QTY_ROW.match(line)):
            quantities.setdefault(m["label"], money(m["q"]))
        elif section == "value" and (m := _VALUE_ROW.match(line)):
            values.setdefault(m["label"], money(m["v"]))
        elif section == "value" and (m := _TOTAL_ROW.match(line)):
            total = money(m["v"])
    positions = [
        _position(label, value, quantities.get(label, Decimal(0)), company, price)
        for label, value in values.items()
    ]
    return positions, total


def _position(
    label: str, value: Decimal, quantity: Decimal, company: str, price: Decimal | None
) -> Position:
    unit = value / quantity if quantity else (price or Decimal(0))
    return Position(
        symbol=_symbol(label),
        name=f"{company} {label.lower()}",
        quantity=quantity,
        price=unit.quantize(Decimal("0.0001")),
        market_value=value,
        book_cost=Decimal(0),
    )


def _symbol(label: str) -> str:
    low = label.lower()
    if "option" in low:
        return "OPTIONS"
    if "unit" in low:
        return "RSU"
    return "SHARES"


@dataclass(frozen=True)
class _Table:
    header: list[str]
    rows: list[list[str]]

    def column(self, needle: str) -> int | None:
        return next((i for i, h in enumerate(self.header) if needle in h), None)


def _tables(lines: Iterable[str]) -> list[_Table]:
    """Markdown tables, as Docling writes them: a header row, a rule, then rows."""
    out: list[_Table] = []
    block: list[list[str]] = []
    for line in [*lines, ""]:
        if line.startswith("|"):
            block.append([c.strip() for c in line.strip("|").split("|")])
            continue
        if len(block) >= 3 and all(set(c) <= set("-: ") for c in block[1]):
            out.append(_Table(block[0], block[2:]))
        block = []
    return out


def _from_grants(
    lines: Sequence[str], company: str, price: Decimal | None
) -> list[Position] | None:
    """Route 2: per-grant outstanding units and options at the closing price.

    None when the document has no grant table at all; an empty list when it
    has one and nothing is outstanding.
    """
    if price is None:
        return None
    positions: list[Position] = []
    found = False
    for table in _tables(lines):
        name_col = table.column("Grant Name")
        if name_col is None:
            continue
        found = True
        out_col = table.column("Share Units Outstanding")
        if out_col is not None:
            units = _column_total(table, out_col, name_col)
            if units:
                positions.append(
                    _position(
                        "Share Units (RSU)",
                        (units * price).quantize(Decimal("0.01")),
                        units,
                        company,
                        price,
                    )
                )
            continue
        out_col, strike_col = table.column("Options Outstanding"), table.column("Grant Price")
        if out_col is not None and strike_col is not None:
            quantity = Decimal(0)
            value = Decimal(0)
            for row in table.rows:
                if not row[name_col] or len(row) <= max(out_col, strike_col):
                    continue
                held, strike = _number(row[out_col]), _number(row[strike_col])
                if held is None or strike is None or held <= 0:
                    continue
                quantity += held
                value += held * max(price - strike, Decimal(0))
            if quantity:
                positions.append(
                    _position(
                        "Stock Options", value.quantize(Decimal("0.01")), quantity, company, price
                    )
                )
    return positions if found else None


def _column_total(table: _Table, col: int, name_col: int) -> Decimal:
    """The footer row's figure when the table has one, else the sum of the named rows."""
    footer = [r for r in table.rows if len(r) > col and not r[name_col] and _number(r[col])]
    if footer:
        return _number(footer[-1][col]) or Decimal(0)
    return sum(
        (n for r in table.rows if len(r) > col and r[name_col] and (n := _number(r[col]))),
        Decimal(0),
    )


FAMILY = Shareworks()
