"""Scotiabank quarterly investment statements (Scotia Securities and bank-held plans).

Two layouts: the "Personal Portfolio Statement" before September 2015 and
"Your Investments" after, told apart by the second phrase because later
statements still name the first in their marketing text. Both list every
plan the holder has (LRSP, RRSP, TFSA...), so one file yields one holdings
snapshot per plan, keyed by the plan's number. Mutual fund names wrap below
their row and fund categories sit above it; `attach(before=False)` keeps the
first and drops the second.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from itertools import pairwise

from tally.model import AccountKind, HoldingSnapshot, Position
from tally.parsers import ParseError
from tally.parsers.statements import (
    AMOUNT,
    Line,
    Page,
    Statement,
    around,
    attach,
    between,
    check_total,
    document_lines,
    money,
    month,
    search,
)

NAME = "scotiabank-portfolio"
INSTITUTION = "Scotiabank"

_PERIOD = re.compile(
    r"(?P<sm>[A-Z][a-z]+) (?P<sd>\d{1,2})\s*to\s*(?P<em>[A-Z][a-z]+) (?P<ed>\d{1,2}), (?P<ey>\d{4})"
)
_PLANS = r"LRSP|RRSP|RSP|TFSA|RESP|RRIF|RIF|LIRA|LIF|FHSA|Non-registered|NON-REGISTERED"
_NEW_ACCOUNT = re.compile(rf"^(?P<plan>{_PLANS}) #(?P<number>\d{{5,}})$")
_ACCOUNT_VALUE = re.compile(rf"^ACCOUNT VALUE (?P<v>{AMOUNT})$")
_OLD_SECTION = re.compile(
    r"^Details of your (?:tax free |registered |non-registered )?investments$"
)
_OLD_PLAN = re.compile(rf"^(?P<plan>{_PLANS})\b")
_OLD_NUMBER = re.compile(r"^#(?P<number>\d{5,})$")
_OLD_TOTAL = re.compile(rf"^Total value of your plan {AMOUNT} (?P<v>{AMOUNT})$")
_TWO_VALUES = re.compile(rf"^(?P<name>\D.*?) (?P<prev>{AMOUNT}) (?P<cur>{AMOUNT})$")
_FUND = re.compile(
    rf"^(?P<name>.+?) (?P<book>{AMOUNT}) {AMOUNT} (?P<units>{AMOUNT}) "
    rf"(?P<px>{AMOUNT}) (?P<mv>{AMOUNT})$"
)
_CASH_START = re.compile(r"^Details of your investments$")
_CASH_STOP = re.compile(r"\b(?:TOTAL CASH HELD|Total held with)\b")
_FUND_START = re.compile(r"^DESCRIPTION\b")
_FUND_STOP = re.compile(r"\bTOTAL MUTUAL FUNDS\b")
_HEADER = re.compile(r"^(?:VALUE AT|[A-Z]{3} \d{1,2}, \d{4} \(\$\)|Value at)")


class ScotiaPortfolio:
    name = NAME

    def sniff(self, texts: Sequence[str]) -> bool:
        first = texts[0] if texts else ""
        layout = "Personal Portfolio Statement" in first or "Your Investments" in first
        return layout and "scotia" in first.lower()

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        found = search(_PERIOD, pages[0].text, f"{NAME}: statement period")
        end = date(int(found["ey"]), month(found["em"]), int(found["ed"]))
        start_month = month(found["sm"])
        start = date(
            end.year if start_month <= end.month else end.year - 1, start_month, int(found["sd"])
        )
        lines = document_lines(pages)
        old = "Your Investments" not in pages[0].text
        snapshots = _old_layout(lines, end) if old else _new_layout(lines, end)
        if not snapshots:
            raise ParseError(f"{NAME}: no plan found")
        return Statement(
            institution=INSTITUTION,
            account_hint=snapshots[0].account_id if len(snapshots) == 1 else None,
            account_kind=AccountKind.investment,
            date_from=start,
            date_to=end,
            holdings=tuple(snapshots),
        )


def _blocks(lines: Sequence[Line], starts: list[int]) -> list[list[Line]]:
    bounds = [*starts, len(lines)]
    return [list(lines[a:b]) for a, b in pairwise(bounds)]


def _new_layout(lines: Sequence[Line], end: date) -> list[HoldingSnapshot]:
    starts = [i for i, line in enumerate(lines) if _NEW_ACCOUNT.match(line.text)]
    out = []
    for block in _blocks(lines, starts):
        account = search(_NEW_ACCOUNT, block[0].text, f"{NAME}: plan number")["number"]
        value = next((m for line in block if (m := _ACCOUNT_VALUE.match(line.text))), None)
        if value is None:
            raise ParseError(f"{NAME}: account value not found")
        positions = _cash(block) + _funds(block)
        out.append(_snapshot(account, end, positions, money(value["v"])))
    return out


def _old_layout(lines: Sequence[Line], end: date) -> list[HoldingSnapshot]:
    starts = [
        i
        for i, line in enumerate(lines)
        if _OLD_SECTION.match(line.text)
        and i + 1 < len(lines)
        and _OLD_PLAN.match(lines[i + 1].text)
    ]
    out = []
    for block in _blocks(lines, starts):
        number = next((m for line in block[1:4] if (m := _OLD_NUMBER.match(line.text))), None)
        total = next((m for line in block if (m := _OLD_TOTAL.match(line.text))), None)
        if number is None or total is None:
            raise ParseError(f"{NAME}: plan number or plan value not found")
        positions = _cash(block) + _funds(block)
        out.append(_snapshot(number["number"], end, positions, money(total["v"])))
    return out


def _snapshot(
    account: str, end: date, positions: list[Position], total: Decimal
) -> HoldingSnapshot:
    check_total(NAME, positions, total)
    return HoldingSnapshot(
        account_id=account,
        date=end,
        positions=tuple(p for p in positions if p.market_value),
        total=total,
        origin="statement-pdf",
    )


def _cash(block: Sequence[Line]) -> list[Position]:
    out = []
    for line in between(block, _CASH_START, _CASH_STOP):
        found = _TWO_VALUES.match(line.text)
        if found is None or _HEADER.match(line.text):
            continue
        value = money(found["cur"])
        out.append(
            Position(
                symbol="CASH",
                name=found["name"],
                quantity=value,
                price=Decimal(1),
                market_value=value,
                book_cost=value,
            )
        )
    return out


def _funds(block: Sequence[Line]) -> list[Position]:
    table = [
        line
        for line in between(block, _FUND_START, _FUND_STOP)
        if not re.fullmatch(r"\d+", line.text)
    ]
    out = []
    for row, found, extra in attach(table, _FUND.match, before=False):
        name = around(row, found["name"], extra)
        out.append(
            Position(
                symbol=name,
                name=name,
                quantity=money(found["units"]),
                price=money(found["px"]),
                market_value=money(found["mv"]),
                book_cost=money(found["book"]),
            )
        )
    return out


FAMILY = ScotiaPortfolio()
