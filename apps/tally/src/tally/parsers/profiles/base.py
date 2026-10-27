"""What a CSV profile declares, and the probes that fingerprint a file against one."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from tally.model import AccountKind

Row = tuple[str, ...]
Table = tuple[Row, ...]
Probe = Callable[[str], bool]

ENCODINGS = ("utf-8-sig", "cp1252")

_MONEY_NOISE = re.compile(r"[\s$,]|CAD", re.IGNORECASE)


class Sign(StrEnum):
    """How a single signed amount column reads."""

    in_positive = "in-positive"
    out_positive = "out-positive"


@dataclass(frozen=True)
class Roles:
    """Column indices. Either `amount` or the `outflow`/`inflow` pair is set.

    `sign` overrides the profile's sign rule when the header implies one.
    """

    date: int
    descriptor: tuple[int, ...]
    amount: int | None = None
    outflow: int | None = None
    inflow: int | None = None
    memo: tuple[int, ...] = ()
    type: int | None = None
    balance: int | None = None
    account: int | None = None
    category: tuple[int, ...] = ()
    pending: int | None = None
    sign: Sign | None = None

    def money(self) -> tuple[int, ...]:
        return tuple(c for c in (self.amount, self.outflow, self.inflow) if c is not None)


@dataclass(frozen=True)
class Profile:
    """A file shape. `fingerprint` returns the roles when a table has this shape.

    `date_format` None means the format is detected per file from a fixed
    candidate list. `confirm` marks a guessed layout the owner must confirm.
    """

    id: str
    institution: str | None
    has_header: bool
    fingerprint: Callable[[Table], Roles | None]
    date_format: str | None
    delimiter: str | None = ","
    encodings: tuple[str, ...] = ENCODINGS
    sign: Sign = Sign.in_positive
    trust_categories: bool = False
    tag_prefix: str | None = None
    transfer_prefix: str | None = None
    pending_values: frozenset[str] = frozenset()
    account_kind: AccountKind | None = None
    confirm: bool = False
    skip_blank_amounts: bool = False


def norm(cell: str) -> str:
    return " ".join(cell.replace("﻿", "").split()).casefold()


def parse_amount(cell: str) -> Decimal | None:
    """`$1,234.56`, `-$5.00`, `(5.00)` and `5.00-` all read; blank is None."""
    text = _MONEY_NOISE.sub("", cell)
    if not text:
        return None
    negative = (text.startswith("(") and text.endswith(")")) or text.endswith("-")
    text = text.strip("()").removesuffix("-")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise ValueError("not an amount") from None
    if not value.is_finite():
        raise ValueError("not an amount")
    return -value if negative else value


def parse_date(cell: str, fmt: str) -> date:
    return datetime.strptime(cell.strip(), fmt).date()


class DateFormatError(ValueError):
    """No candidate format reads every value, or two read them differently."""


def detect_date_format(values: Sequence[str], formats: Sequence[str]) -> str:
    """The one format that reads every value; ambiguity is an error, never a guess."""
    parsed: dict[str, tuple[date, ...]] = {}
    for fmt in formats:
        try:
            parsed[fmt] = tuple(parse_date(v, fmt) for v in values)
        except ValueError:
            continue
    if not parsed:
        raise DateFormatError("matches no known date format")
    if len(set(parsed.values())) > 1:
        raise DateFormatError(f"reads as {' or '.join(parsed)}; name one")
    return next(iter(parsed))


def is_amount(cell: str) -> bool:
    try:
        return parse_amount(cell) is not None
    except ValueError:
        return False


def is_date(fmt: str) -> Probe:
    def probe(cell: str) -> bool:
        try:
            parse_date(cell, fmt)
        except ValueError:
            return False
        return True

    return probe


def literal(value: str) -> Probe:
    return lambda cell: cell.strip() == value


def nonempty(cell: str) -> bool:
    return bool(cell.strip())


def anything(cell: str) -> bool:
    return True


def header_shaped(row: Row) -> bool:
    """A header names columns: no cell reads as an amount and every cell has a letter."""
    return all(any(ch.isalpha() for ch in c) and not is_amount(c) for c in row if c.strip())


def by_header(header: Sequence[str], roles: Roles) -> Callable[[Table], Roles | None]:
    want = tuple(norm(h) for h in header)

    def fingerprint(table: Table) -> Roles | None:
        return roles if table and tuple(norm(c) for c in table[0]) == want else None

    return fingerprint


def by_shape(
    probes: Sequence[Probe], roles: Roles, min_ratio: float = 0.95
) -> Callable[[Table], Roles | None]:
    """Headerless match: the column count, the first row, and most rows pass every probe."""

    def fits(row: Row) -> bool:
        return len(row) == len(probes) and all(p(c) for p, c in zip(probes, row, strict=True))

    def fingerprint(table: Table) -> Roles | None:
        if not table or not fits(table[0]):
            return None
        matched = sum(1 for row in table if fits(row))
        return roles if matched >= min_ratio * len(table) else None

    return fingerprint
