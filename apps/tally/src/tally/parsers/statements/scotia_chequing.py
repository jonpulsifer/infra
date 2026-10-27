"""Scotiabank day-to-day banking e-statements (the "Package" chequing accounts).

Page 1 holds a summary (opening balance, total withdrawals, total deposits,
closing balance, each opening and closing dated) and the start of a table of
date, transaction type, withdrawn, deposited and running balance; the table
continues on later pages under the same header. The text layer drops the
spaces inside phrases, so patterns take an optional space between words.

A row's sign comes from its running balance, not from its column: the change
from the balance above must equal the printed amount, and the statement is
refused unless the rows add up to the summary's totals and closing balance.
The line below a row is its counterparty and becomes the descriptor; the
transaction type goes in the memo, as the Scotiabank CSV profile does.
Zero-amount rows (waived fees) carry nothing and are dropped. Barcode and
mail-sort codes printed down the left margin are cut by geometry, left of
the table's Date column.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal

from tally.model import AccountKind, BalanceAssertion, ParsedRow
from tally.parsers import ParseError
from tally.parsers.statements import (
    Line,
    Page,
    Statement,
    attach,
    between,
    document_lines,
    money,
    month,
    search,
)

NAME = "scotiabank-chequing"
INSTITUTION = "Scotiabank"

_SUMMARY = re.compile(r"Your (?P<product>.+?) account summary")
_SEEN = re.compile(r"Here's what happened in your account")
_SIGNED = r"-?\$?\d[\d,]*\.\d{2}-?"
_ON = r" ?on ?(?P<m>[A-Z][a-z]+) ?(?P<d>\d{1,2}), ?(?P<y>\d{4}) (?P<amt>" + _SIGNED + ")"
_OPENING = re.compile(r"Opening ?Balance" + _ON)
_CLOSING = re.compile(r"Closing ?Balance" + _ON)
_WITHDRAWN = re.compile(r"Minus ?total ?withdrawals (?P<amt>\$?[\d,]+\.\d{2})")
_DEPOSITED = re.compile(r"Plus ?total ?deposits (?P<amt>\$?[\d,]+\.\d{2})")
ACCOUNT_DIGITS = 12
_ACCOUNT = re.compile(r"Your ?account ?number:[^\n]*\n[^\n]*?(\d[\d -]{4,}\d)[ \t]*$", re.M)
_TABLE_START = re.compile(r"^Date Transactions")
_TABLE_STOP = re.compile(r"Closing ?Balance|continued ?on ?next ?page")
_ROW = re.compile(
    r"^(?P<m>[A-Z][a-z]{2}) ?(?P<d>\d{1,2}) (?P<type>.+?) "
    r"(?P<amt>\d[\d,]*\.\d{2}) (?P<bal>" + _SIGNED + r")$"
)


class ScotiaChequing:
    name = NAME

    def sniff(self, texts: Sequence[str]) -> bool:
        first = texts[0] if texts else ""
        return bool(
            _SUMMARY.search(first)
            and _SEEN.search(first)
            and _OPENING.search(first)
            and "scotia" in first.lower()
        )

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        first = pages[0].text
        opening = search(_OPENING, first, f"{NAME}: opening balance")
        closing = search(_CLOSING, first, f"{NAME}: closing balance")
        start, end = _day(opening), _day(closing)
        found = search(_ACCOUNT, first, f"{NAME}: account number")
        # Transit and account number are twelve digits; a later layout prints one more
        # digit in front, and the same account must resolve to the same hint.
        account = re.sub(r"\D", "", found[1])[-ACCOUNT_DIGITS:]
        product = search(_SUMMARY, first, f"{NAME}: account summary")["product"]
        kind = AccountKind.savings if "sav" in product.lower() else AccountKind.chequing
        table = between(document_lines(_in_table(pages)), _TABLE_START, _TABLE_STOP)
        rows = _rows(table, money(opening["amt"]), end, account)
        _check(first, rows, money(opening["amt"]), money(closing["amt"]))
        return Statement(
            institution=INSTITUTION,
            account_hint=account,
            account_kind=kind,
            date_from=start,
            date_to=end,
            rows=tuple(rows),
            assertions=(
                BalanceAssertion(
                    account_id=account,
                    date=start - timedelta(days=1),
                    balance=money(opening["amt"]),
                    origin=origin,
                ),
                BalanceAssertion(
                    account_id=account, date=end, balance=money(closing["amt"]), origin=origin
                ),
            ),
        )


def _day(found: re.Match[str]) -> date:
    return date(int(found["y"]), month(found["m"]), int(found["d"]))


def _in_period(mon: str, day: str, end: date) -> date:
    m = month(mon)
    return date(end.year if m <= end.month else end.year - 1, m, int(day))


def _in_table(pages: Sequence[Page]) -> list[Page]:
    """Each page without the words left of its Date column, where the margin codes sit."""
    out = []
    for page in pages:
        edge = min((w.x0 for w in page.words if w.text == "Date"), default=None)
        if edge is None:
            out.append(page)
        else:
            kept = tuple(w for w in page.words if w.x0 >= edge - 2)
            out.append(Page(text=page.text, words=kept))
    return out


def _rows(lines: Sequence[Line], balance: Decimal, end: date, account: str) -> list[ParsedRow]:
    out = []
    for _, found, extra in attach(lines, _ROW.match, before=False):
        after = money(found["bal"])
        amount = after - balance
        if abs(amount) != money(found["amt"]):
            raise ParseError(f"{NAME}: a row's amount does not match its running balance")
        balance = after
        if not amount:
            continue
        kind = found["type"].strip()
        detail = " ".join(e.text for e in extra).strip()
        out.append(
            ParsedRow(
                account_hint=account,
                date=_in_period(found["m"], found["d"], end),
                amount=amount,
                descriptor=detail or kind,
                memo=kind,
                balance_after=after,
            )
        )
    return out


def _check(first: str, rows: Sequence[ParsedRow], opening: Decimal, closing: Decimal) -> None:
    withdrawn = money(search(_WITHDRAWN, first, f"{NAME}: total withdrawals")["amt"])
    deposited = money(search(_DEPOSITED, first, f"{NAME}: total deposits")["amt"])
    out = -sum((r.amount for r in rows if r.amount < 0), Decimal(0))
    into = sum((r.amount for r in rows if r.amount > 0), Decimal(0))
    if out != withdrawn or into != deposited or opening - out + into != closing:
        raise ParseError(f"{NAME}: rows do not add up to the statement summary")


FAMILY = ScotiaChequing()
