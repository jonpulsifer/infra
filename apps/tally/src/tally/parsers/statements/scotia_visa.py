"""Scotiabank VISA monthly e-statements.

Transactions are listed by posting date within the statement period, so a
row's date is its posting date and the transaction date goes in the memo; that
keeps the rows summing to the change between the previous and new balance.
Tally signs a card from the holder's side: a purchase and an amount owed are
negative, and a credit (a trailing minus, or the blank its unmapped glyph
leaves in the text layer, see `Word.blank_after`) is positive.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal

from tally.model import AccountKind, BalanceAssertion, ParsedRow
from tally.parsers import ParseError
from tally.parsers.statements import Line, Page, Statement, document_lines, money, month, search

NAME = "scotiabank-visa"
INSTITUTION = "Scotiabank"

_DATE = r"(?P<{0}m>[A-Z][a-z]{{2}}) (?P<{0}d>\d{{1,2}}), (?P<{0}y>\d{{4}})"
_PERIOD = re.compile(
    r"Statement Period\s*(?:" + _DATE.format("s") + r")?\s*-\s*" + _DATE.format("e")
)
_ACCOUNT = re.compile(r"Account #\s*(\d[\d ]*\d)")
_PREVIOUS = re.compile(
    r"Previous balance,?\s*(?:(?P<m>[A-Z][a-z]{2}) (?P<d>\d{1,2})/(?P<y>\d{2}))?\s*"
    r"\$(?P<amt>[\d,]+\.\d{2})(?P<cr>-|\s?CR\b)?"
)
_NEW = re.compile(r"New balance\s*=?\s*\$(?P<amt>[\d,]+\.\d{2})(?P<cr>-|\s?CR\b)?")
_INTEREST = re.compile(r"Interest\s*\+\s*\$(?P<amt>[\d,]+\.\d{2})")
_START = (
    r"(?<!\S)(?P<ref>\d{1,4}) (?P<tm>[A-Z][a-z]{2}) (?P<td>\d{1,2}) "
    r"(?P<pm>[A-Z][a-z]{2}) (?P<pd>\d{1,2})"
)
_STARTS = re.compile(_START + r"(?!\S)")
_TXN = re.compile(_START + r" (?P<details>.+?) (?P<amt>\d{1,3}(?:,\d{3})*\.\d{2})(?P<cr>-?)$")
_BARE = re.compile(_START + r" (?P<amt>\d{1,3}(?:,\d{3})*\.\d{2})-?$")
_FOREIGN = re.compile(r"\s*AMT(?:\s+(?=[\d,]*\d\.\d{2})|$)")
_WALLET = re.compile(r"\s*\((?:APPLE|GOOGLE|ANDROID|SAMSUNG)(?: PAY\)?)?$")
_CONTINUATION = re.compile(
    r"^(?:\(?(?:APPLE|GOOGLE|ANDROID|SAMSUNG)? ?PAY\)|(?:\S*AMT )?[\d,]*\d\.\d{2}(?: [A-Z][A-Z ]+)?"
    r"|[A-Z][A-Z ]*(?:DOLLAR|EURO|STERLING|FRANC|PESO|YEN|KRONA|KRONE|RAND|YUAN|RUPEE|WON|BAHT)S?)$"
)


class ScotiaVisa:
    name = NAME

    def sniff(self, texts: Sequence[str]) -> bool:
        first = texts[0] if texts else ""
        return "Statement Period" in first and "VISA" in first and "Scotia" in first

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        first = pages[0].text
        period = search(_PERIOD, first, f"{NAME}: statement period")
        end = _day(period["em"], period["ed"], period["ey"])
        start = _day(period["sm"], period["sd"], period["sy"]) if period["sm"] else None
        account = re.sub(r"\D", "", search(_ACCOUNT, first, f"{NAME}: account number")[1])
        listed = _rows(document_lines(pages, _amount_edge), end, account)
        rows = (*listed, *_interest(first, listed, end, account))
        return Statement(
            institution=INSTITUTION,
            account_hint=account,
            account_kind=AccountKind.credit,
            date_from=start or min((r.date for r in rows), default=None),
            date_to=end,
            rows=rows,
            assertions=_assertions(first, account, start, end, origin),
        )


def _interest(
    first: str, listed: Sequence[ParsedRow], end: date, account: str
) -> tuple[ParsedRow, ...]:
    """Interest appears only in the page-1 summary; it becomes a row on the statement date."""
    found = _INTEREST.search(first)
    charged = money(found["amt"]) if found else Decimal(0)
    if not charged or any("INTEREST" in r.descriptor.upper() for r in listed):
        return ()
    return (
        ParsedRow(
            account_hint=account,
            date=end,
            amount=-charged,
            descriptor="INTEREST CHARGES",
            memo="from the statement summary",
        ),
    )


def _amount_edge(page: Page) -> float | None:
    """Footer codes share a baseline with the last row; cut at the amount column."""
    edge = page.right_edge_of("AMOUNT($)")
    return edge + 4 if edge is not None else None


def _day(mon: str, day: str, year: str) -> date:
    return date(int(year), month(mon), int(day))


def _in_period(mon: str, day: str, end: date) -> date:
    m = month(mon)
    return date(end.year if m <= end.month else end.year - 1, m, int(day))


def _card_balance(found: re.Match[str]) -> Decimal:
    owed = money(found["amt"])
    return owed if found["cr"] else -owed


def _assertions(
    first: str, account: str, start: date | None, end: date, origin: str
) -> tuple[BalanceAssertion, ...]:
    new = search(_NEW, first, f"{NAME}: new balance")
    closing = _card_balance(new)
    out = [BalanceAssertion(account_id=account, date=end, balance=closing, origin=origin)]
    previous = _PREVIOUS.search(first)
    if previous is not None:
        when = (
            date(2000 + int(previous["y"]), month(previous["m"]), int(previous["d"]))
            if previous["m"]
            else (start - timedelta(days=1) if start else None)
        )
        if when is not None:
            out.insert(
                0,
                BalanceAssertion(
                    account_id=account, date=when, balance=_card_balance(previous), origin=origin
                ),
            )
    return tuple(out)


def _rows(lines: Sequence[Line], end: date, account: str) -> list[ParsedRow]:
    out: list[ParsedRow] = []
    pending: tuple[re.Match[str], bool] | None = None
    extra: list[str] = []
    for line in [*_joined(lines), Line("", 0.0)]:
        found = _TXN.search(line.text)
        if pending is not None and found is None and _CONTINUATION.match(line.text):
            extra.append(line.text)
            continue
        if pending is not None:
            out.append(_row(*pending, extra, end, account))
            pending, extra = None, []
        pending = (found, bool(found["cr"]) or line.blank_after) if found else None
    return out


def _joined(lines: Sequence[Line]) -> list[Line]:
    """A row whose details or amount wrapped onto the next lines, joined back to one line."""
    out: list[Line] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        bare = _BARE.search(line.text)
        if bare and i + 1 < len(lines) and not _STARTS.search(lines[i + 1].text):
            cut = bare.start("amt")
            text = f"{line.text[:cut]}{lines[i + 1].text} {line.text[cut:]}"
            line, i = Line(text, line.top, line.blank_after), i + 1
        elif _STARTS.search(line.text) and not _TXN.search(line.text):
            for j in (1, 2):
                tail = lines[i + 1 : i + j + 1]
                if len(tail) < j or _STARTS.search(tail[-1].text):
                    break
                merged = " ".join(ln.text for ln in (line, *tail))
                if _TXN.search(merged):
                    line, i = Line(merged, line.top, tail[-1].blank_after), i + j
                    break
        out.append(line)
        i += 1
    return out


def _row(
    found: re.Match[str], credit: bool, extra: list[str], end: date, account: str
) -> ParsedRow:
    descriptor, *foreign = _FOREIGN.split(found["details"], maxsplit=1)
    memo: list[str] = []
    wallet = _WALLET.search(descriptor)
    if wallet is not None:
        descriptor = descriptor[: wallet.start()]
        memo.append(wallet.group().strip())
    memo += [f"AMT {f}" for f in foreign if f] + extra
    posted = _in_period(found["pm"], found["pd"], end)
    traded = _in_period(found["tm"], found["td"], end)
    if traded != posted:
        memo.append(f"transaction date {traded.isoformat()}")
    if not descriptor.strip():
        raise ParseError(f"{NAME}: a transaction line has no details")
    amount = money(found["amt"])
    return ParsedRow(
        account_hint=account,
        date=posted,
        amount=amount if credit else -amount,
        descriptor=descriptor.strip(),
        memo=" ".join(memo),
    )


FAMILY = ScotiaVisa()
