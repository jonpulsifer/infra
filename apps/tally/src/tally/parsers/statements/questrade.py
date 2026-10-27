"""Questrade monthly account statements.

The holdings table shares its page with a glossary column, so lines are cut at
the right edge of the `% port.` header before rows are read. Positions held in
USD are converted at the statement's own current-month rate, the same rate the
statement uses for its combined-in-CAD totals. Cash activity becomes rows only
for CAD amounts; USD cash rows are left out because the ledger is CAD only.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date
from decimal import Decimal

from tally.model import AccountKind, HoldingSnapshot, ParsedRow, Position
from tally.parsers import ParseError
from tally.parsers.statements import (
    AMOUNT,
    Line,
    Page,
    Statement,
    around,
    attach,
    check_total,
    document_lines,
    money,
    month,
    optional_money,
    search,
)

NAME = "questrade"
INSTITUTION = "Questrade"
CENT = Decimal("0.01")

_NUM = AMOUNT.replace(r"\.\d+", r"(?:\.\d+)?")
_CELL = rf"(?:{_NUM}|-)"
_ACCOUNT = re.compile(r"Account #:\s*(\d+)")
_PLAN = re.compile(r"\((LRSP|RRSP|SRRSP|TFSA|FHSA|RESP|LIRA|LIF|RRIF|RIF)\)")
_CURRENT = re.compile(r"Current month:\s*([A-Z][a-z]+) (\d{1,2}), (\d{4})")
_BALANCE = re.compile(r"Current month balance:\s*\$(\d[\d,]*\.\d{2})")
_FX = re.compile(r"Current month FX rate:\s*\$[\d.]+\s*USD\s*=\s*\$\s*(\d+(?:\.\d+)?)\s*CAD")
_HELD_IN = re.compile(r"^Securities held in (CAD|USD)\b")
_TABLE_END = re.compile(r"^(?:Current month FX rate|Total\b|©|Note:)")
_POSITION = re.compile(
    rf"^(?P<sym>[A-Z][A-Z0-9.\-]*)\s+(?:(?P<desc>.*?)\s+)?(?P<basis>BK|HMVD|HMV|ND)\s+"
    rf"(?P<qty>{_NUM})\s+{_CELL}\s+{_CELL}\s+(?P<cost>{_CELL})\s+(?P<px>{_CELL})\s+"
    rf"(?P<mv>{_NUM})[EN]?\s+{_CELL}\s+{_CELL}\s+{_CELL}$"
)
_OWNED_CASH = re.compile(rf"^Owned\s+{_CELL}\s+{_CELL}\s+(?P<cad>{_CELL})(?:\s|$)")
_TXN = re.compile(r"^(?P<td>\d{1,2}/\d{1,2}/\d{4}) (?P<sd>\d{1,2}/\d{1,2}/\d{4}) (?P<rest>.+)$")
_TXN_START = re.compile(r"^Trans\. date")
_TXN_END = re.compile(r"^Closing balance\b")
_REFERENCE = re.compile(r"^\d{6,}$")
_BOILERPLATE = re.compile(r"\b(?:WE ACTED AS AGENT|AVG PRICE - ASK US FOR DETAILS)\b")


class Questrade:
    name = NAME

    def sniff(self, texts: Sequence[str]) -> bool:
        first = texts[0] if texts else ""
        return "Questrade" in first and "ACCOUNT STATEMENT" in first

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        first = pages[0].text
        account = search(_ACCOUNT, first, f"{NAME}: account number")[1]
        found = search(_CURRENT, first, f"{NAME}: statement month")
        as_of = date(int(found[3]), month(found[1]), int(found[2]))
        fx = _FX.search(first)
        positions = _positions(pages, Decimal(fx[1]) if fx else None)
        total = _total(first, positions)
        check_total(NAME, positions, total)
        snapshot = HoldingSnapshot(
            account_id=account,
            date=as_of,
            positions=tuple(positions),
            total=total,
            origin="statement-pdf",
        )
        return Statement(
            institution=INSTITUTION,
            account_hint=account,
            account_kind=AccountKind.investment,
            date_from=as_of.replace(day=1),
            date_to=as_of,
            rows=tuple(_rows(pages, account)),
            holdings=(snapshot,),
        )


def _glossary_edge(page: Page) -> float | None:
    edge = page.right_edge_of("port.")
    return edge + 8 if edge is not None else None


def _total(first: str, positions: Sequence[Position]) -> Decimal:
    found = _BALANCE.search(first)
    if found is not None:
        return money(found[1])
    if positions:
        raise ParseError(f"{NAME}: account total not found")
    return Decimal(0)


def _positions(pages: Sequence[Page], fx: Decimal | None) -> list[Position]:
    details = [p for p in pages if "INVESTMENT DETAILS" in p.text]
    lines = document_lines(details, _glossary_edge)
    out = [p for section in _sections(lines) for p in _section_positions(*section, fx)]
    cash = next((m for line in lines if (m := _OWNED_CASH.match(line.text))), None)
    held = optional_money(cash["cad"]) if cash else None
    if held:
        out.append(
            Position(
                symbol="CASH",
                name="Cash, combined in CAD",
                quantity=held,
                price=Decimal(1),
                market_value=held,
                book_cost=held,
            )
        )
    return out


def _sections(lines: Sequence[Line]) -> list[tuple[str, list[Line]]]:
    out: list[tuple[str, list[Line]]] = []
    current: list[Line] | None = None
    for line in lines:
        held_in = _HELD_IN.match(line.text)
        if held_in is not None:
            current = []
            out.append((held_in[1], current))
        elif current is not None and _TABLE_END.match(line.text):
            current = None
        elif current is not None:
            current.append(line)
    return out


def _section_positions(currency: str, lines: Sequence[Line], fx: Decimal | None) -> list[Position]:
    if currency == "USD" and fx is None:
        raise ParseError(f"{NAME}: USD positions without an exchange rate")
    rate = fx if currency == "USD" and fx is not None else Decimal(1)
    out = []
    for row, found, extra in attach(lines, _POSITION.match, before=True):
        mv = money(found["mv"])
        out.append(
            Position(
                symbol=found["sym"],
                name=around(row, found["desc"] or "", extra),
                quantity=money(found["qty"]),
                price=(optional_money(found["px"]) or Decimal(0)) * rate,
                market_value=(mv * rate).quantize(CENT),
                book_cost=((optional_money(found["cost"]) or Decimal(0)) * rate).quantize(CENT),
            )
        )
    return out


def _rows(pages: Sequence[Page], account: str) -> list[ParsedRow]:
    activity = [
        p for p in pages if "ACTIVITY DETAILS" in p.text and "TRADES TO SETTLE" not in p.text
    ]
    lines = _txn_lines(document_lines(activity))
    out = []
    for _, found, extra in attach(lines, _TXN.match, before=True):
        parsed = _row(found, extra, account)
        if parsed is not None:
            out.append(parsed)
    return out


def _txn_lines(lines: Sequence[Line]) -> list[Line]:
    out: list[Line] = []
    inside = False
    for line in lines:
        if _TXN_START.match(line.text):
            inside = True
        elif inside and _TXN_END.match(line.text):
            inside = False
        elif inside and not line.text.startswith("Opening balance"):
            out.append(line)
    return out


def _row(found: re.Match[str], extra: list[Line], account: str) -> ParsedRow | None:
    tokens = found["rest"].split()
    if len(tokens) < 10 or not all(re.fullmatch(_CELL, t) for t in tokens[-9:]):
        raise ParseError(f"{NAME}: a transaction line has an unexpected column count")
    cad_net = optional_money(tokens[-5])
    if not cad_net:
        return None
    head = [t for t in tokens[:-9] if not _REFERENCE.match(t)]
    references = [t for t in tokens[:-9] if _REFERENCE.match(t)]
    text = " ".join([*head, *(e.text for e in extra)]).replace("|", " ")
    descriptor = " ".join(_BOILERPLATE.sub(" ", text).split())
    m, d, y = (int(x) for x in found["sd"].split("/"))
    return ParsedRow(
        account_hint=account,
        date=date(y, m, d),
        amount=cad_net,
        descriptor=descriptor,
        memo=" ".join(f"reference {r}" for r in references),
    )


FAMILY = Questrade()
