"""OFX 1 (SGML), OFX 2 (XML) and QFX through ofxtools' tree builder.

The parser reads the element tree rather than ofxtools' validated models:
real files break the spec (missing BALAMT, proprietary tags) and the models
reject them wholesale. Posting dates are the digits as written; the bracketed
offset is ignored because converting through UTC shifts Canadian files a day.
"""

from __future__ import annotations

import html
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from typing import Literal

from ofxtools.header import OFXHeaderError
from ofxtools.Parser import OFXTree
from ofxtools.Parser import ParseError as OfxSyntaxError

from tally.model import AccountKind, BalanceAssertion, ParsedFile, ParsedRow
from tally.parsers import ParseError, register, sha256_of

_STATEMENTS = {"STMTRS": "BANKACCTFROM", "CCSTMTRS": "CCACCTFROM"}
_BANK_KINDS = {
    "CHECKING": AccountKind.chequing,
    "SAVINGS": AccountKind.savings,
    "MONEYMRKT": AccountKind.savings,
    "CD": AccountKind.savings,
    "CREDITLINE": AccountKind.credit,
}


@dataclass(frozen=True)
class _Statement:
    account: str | None
    kind: AccountKind | None
    rows: tuple[ParsedRow, ...]
    assertion: BalanceAssertion | None
    span: tuple[date, ...]


def _text(el: ET.Element | None, tag: str) -> str:
    found = None if el is None else el.find(tag)
    if found is None or found.text is None:
        return ""
    return " ".join(html.unescape(found.text).split())


def _date(raw: str, what: str, name: str) -> date:
    digits = raw[:8]
    try:
        return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        raise ParseError(f"{name}: a {what} is not an OFX date") from None


def _amount(raw: str, what: str, name: str) -> Decimal:
    text = raw if "." in raw else raw.replace(",", ".")
    try:
        return Decimal(text)
    except InvalidOperation:
        raise ParseError(f"{name}: a {what} is not a number") from None


def descriptor(name: str, memo: str) -> str:
    """NAME truncates at 32 characters, so MEMO extends it when it says more."""
    if not memo or memo.casefold() in name.casefold():
        return name
    if not name or memo.casefold().startswith(name.casefold()):
        return memo
    return f"{name} {memo}"


def _row(trn: ET.Element, account: str | None, name: str) -> ParsedRow:
    payee = _text(trn, "NAME") or _text(trn.find("PAYEE"), "NAME")
    memo = _text(trn, "MEMO")
    return ParsedRow(
        account_hint=account,
        date=_date(_text(trn, "DTPOSTED"), "DTPOSTED", name),
        amount=_amount(_text(trn, "TRNAMT"), "TRNAMT", name),
        descriptor=descriptor(payee, memo) or _text(trn, "TRNTYPE"),
        memo=memo,
        fitid=_text(trn, "FITID") or None,
    )


def _assertion(stmt: ET.Element, account: str | None, name: str) -> BalanceAssertion | None:
    bal = stmt.find("LEDGERBAL")
    amount, asof = _text(bal, "BALAMT"), _text(bal, "DTASOF")
    if account is None or not amount or not asof:
        return None
    return BalanceAssertion(
        account_id=account,
        date=_date(asof, "DTASOF", name),
        balance=_amount(amount, "BALAMT", name),
        origin=name,
    )


def _kind(stmt: ET.Element, acct: ET.Element | None) -> AccountKind | None:
    if stmt.tag == "CCSTMTRS":
        return AccountKind.credit
    return _BANK_KINDS.get(_text(acct, "ACCTTYPE"))


def _statement(stmt: ET.Element, name: str) -> _Statement:
    acct = stmt.find(_STATEMENTS[stmt.tag])
    account = _text(acct, "ACCTID") or None
    tranlist = stmt.find("BANKTRANLIST")
    trns = [] if tranlist is None else tranlist.findall("STMTTRN")
    span = tuple(
        _date(raw, tag, name) for tag in ("DTSTART", "DTEND") if (raw := _text(tranlist, tag))
    )
    return _Statement(
        account=account,
        kind=_kind(stmt, acct),
        rows=tuple(_row(t, account, name) for t in trns),
        assertion=_assertion(stmt, account, name),
        span=span,
    )


def _tree(path: Path) -> ET.Element:
    try:
        return OFXTree().parse(BytesIO(path.read_bytes()))
    except (OfxSyntaxError, OFXHeaderError, UnicodeDecodeError, ValueError, KeyError) as err:
        raise ParseError(f"{path.name}: not a readable OFX file ({type(err).__name__})") from None


def _only[T](values: list[T]) -> T | None:
    return values[0] if len(set(values)) == 1 else None


def _format(path: Path, root: ET.Element) -> Literal["ofx", "qfx"]:
    intuit = root.find(".//INTU.BID") is not None
    return "qfx" if path.suffix.lower() == ".qfx" or intuit else "ofx"


def parse(path: Path) -> ParsedFile:
    root = _tree(path)
    stmts = [_statement(el, path.name) for el in root.iter() if el.tag in _STATEMENTS]
    if not stmts:
        raise ParseError(f"{path.name}: OFX holds no bank or card statement")
    rows = tuple(r for s in stmts for r in s.rows)
    days = [r.date for r in rows] + [d for s in stmts for d in s.span]
    return ParsedFile(
        name=path.name,
        format=_format(path, root),
        institution=_text(root.find(".//SONRS/FI"), "ORG") or None,
        account_hint=_only([s.account for s in stmts]),
        account_kind_hint=_only([s.kind for s in stmts]),
        rows=rows,
        assertions=tuple(s.assertion for s in stmts if s.assertion is not None),
        sha256=sha256_of(path),
        date_from=min(days, default=None),
        date_to=max(days, default=None),
    )


class OfxParser:
    def sniff(self, path: Path, head: bytes) -> bool:
        if path.suffix.lower() in {".ofx", ".qfx"}:
            return True
        return b"OFXHEADER" in head or b"<OFX>" in head.upper()

    def parse(self, path: Path) -> ParsedFile:
        return parse(path)


register(OfxParser())
