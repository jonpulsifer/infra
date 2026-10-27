"""CSV through the profile registry, matched by column fingerprint.

`read(path)` returns the ParsedFile plus per-row tags (the trusted category
hints a ParsedRow has no field for); `CsvParser.parse` returns the file alone.
Error messages name the column count and a header only when every cell of it is a
known column name, never a cell of a data row.
"""

from __future__ import annotations

import csv
import io
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from tally.model import ParsedFile, ParsedRow
from tally.parsers import ParseError, register, sha256_of
from tally.parsers.profiles import PROFILES, describe_header
from tally.parsers.profiles.base import (
    ENCODINGS,
    DateFormatError,
    Profile,
    Roles,
    Row,
    Sign,
    Table,
    detect_date_format,
    norm,
    parse_amount,
    parse_date,
)

DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%Y%m%d",
    "%m/%d/%Y",
    "%d/%m/%Y",
    "%m/%d/%y",
    "%d/%m/%y",
    "%d-%b-%Y",
    "%d %b %Y",
    "%b %d, %Y",
)
TRANSFER_TAG = "transfer"


@dataclass(frozen=True)
class CsvImport:
    file: ParsedFile
    tags: tuple[tuple[str, ...], ...]

    def seed_hints(self) -> dict[str, str]:
        """Descriptor to its most frequent trusted category tag, transfers left out."""
        seen: dict[str, Counter[str]] = {}
        for row, tags in zip(self.file.rows, self.tags, strict=True):
            category = [t for t in tags if "/" in t]
            if category and not any(t.endswith(f":{TRANSFER_TAG}") for t in tags):
                seen.setdefault(row.descriptor, Counter()).update(category)
        return {d: c.most_common(1)[0][0] for d, c in sorted(seen.items())}


def _decode(raw: bytes, name: str) -> str:
    for encoding in dict.fromkeys(e for p in PROFILES for e in (*p.encodings, *ENCODINGS)):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ParseError(f"{name}: not text in any of {', '.join(ENCODINGS)}")


def _sniff_delimiter(text: str) -> str:
    try:
        return csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def _table(text: str, delimiter: str, name: str) -> Table:
    rows = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        return tuple(tuple(r) for r in rows if any(c.strip() for c in r))
    except csv.Error:
        raise ParseError(f"{name}: not a well-formed CSV") from None


def _unknown(name: str, table: Table) -> ParseError:
    if not table:
        return ParseError(f"{name}: empty CSV")
    width = Counter(len(r) for r in table).most_common(1)[0][0]
    return ParseError(
        f"{name}: no CSV profile matches {width} columns, {describe_header(table[0])}"
    )


def _match(text: str, name: str) -> tuple[Profile, Roles, Table]:
    tables: dict[str, Table] = {}
    for profile in PROFILES:
        delimiter = profile.delimiter or _sniff_delimiter(text)
        if delimiter not in tables:
            tables[delimiter] = _table(text, delimiter, name)
        roles = profile.fingerprint(tables[delimiter])
        if roles is not None:
            return profile, roles, tables[delimiter]
    raise _unknown(name, tables[","] if "," in tables else _table(text, ",", name))


def _label(header: Row | None, col: int) -> str:
    return f"'{header[col]}'" if header and col < len(header) else str(col + 1)


def _date_format(values: list[str], label: str, name: str) -> str:
    try:
        return detect_date_format(values, DATE_FORMATS)
    except DateFormatError as err:
        raise ParseError(f"{name}: column {label} {err}") from None


def _cell(row: Row, col: int | None) -> str:
    return "" if col is None else " ".join(row[col].split())


def _join(row: Row, cols: tuple[int, ...] | list[int]) -> str:
    return " ".join(c for c in (_cell(row, i) for i in cols) if c)


def _amount(profile: Profile, roles: Roles, row: Row) -> Decimal | None:
    if roles.amount is not None:
        value = parse_amount(row[roles.amount])
        if value is None:
            return None
        return -value if (roles.sign or profile.sign) is Sign.out_positive else value
    out = parse_amount(row[roles.outflow]) if roles.outflow is not None else None
    inflow = parse_amount(row[roles.inflow]) if roles.inflow is not None else None
    if out is None and inflow is None:
        return None
    return abs(inflow or Decimal(0)) - abs(out or Decimal(0))


def _tags(profile: Profile, roles: Roles, row: Row, descriptor: str) -> tuple[str, ...]:
    if not (profile.trust_categories and profile.tag_prefix):
        return ()
    tags: list[str] = []
    cats = [_cell(row, c) for c in roles.category]
    if any(cats):
        tags.append(f"{profile.tag_prefix}:{'/'.join(cats)}")
    if profile.transfer_prefix and descriptor.startswith(profile.transfer_prefix):
        tags.append(f"{profile.tag_prefix}:{TRANSFER_TAG}")
    return tuple(tags)


@dataclass(frozen=True)
class _Layout:
    profile: Profile
    roles: Roles
    date_format: str
    header: Row | None
    width: int
    name: str


def _row(layout: _Layout, row: Row, n: int) -> tuple[ParsedRow, tuple[str, ...]] | None:
    p, r, name = layout.profile, layout.roles, layout.name
    if len(row) != layout.width:
        raise ParseError(f"{name}: row {n} has {len(row)} columns, expected {layout.width}")
    try:
        amount = _amount(p, r, row)
    except ValueError:
        cols = ", ".join(_label(layout.header, c) for c in r.money())
        raise ParseError(f"{name}: row {n}: column {cols} is not an amount") from None
    if amount is None:
        if p.skip_blank_amounts:
            return None
        raise ParseError(f"{name}: row {n} has no amount")
    try:
        day = parse_date(row[r.date], layout.date_format)
    except ValueError:
        label = _label(layout.header, r.date)
        raise ParseError(f"{name}: row {n}: column {label} is not {layout.date_format}") from None
    try:
        balance = parse_amount(row[r.balance]) if r.balance is not None else None
    except ValueError:
        balance = None
    descriptor = _join(row, r.descriptor) or _cell(row, r.type) or _join(row, r.memo)
    parsed = ParsedRow(
        account_hint=_cell(row, r.account) or None,
        date=day,
        amount=amount,
        descriptor=descriptor,
        memo=_join(row, [c for c in (r.type, *r.memo) if c is not None]),
        pending=norm(_cell(row, r.pending)) in p.pending_values,
        balance_after=balance,
    )
    return parsed, _tags(p, r, row, descriptor)


def _layout(
    profile: Profile, roles: Roles, table: Table, name: str, date_format: str | None
) -> _Layout:
    header = table[0] if profile.has_header else None
    data = table[1:] if header else table
    fmt = (
        profile.date_format
        or date_format
        or _date_format(
            [row[roles.date] for row in data if len(row) > roles.date and row[roles.date].strip()],
            _label(header, roles.date),
            name,
        )
    )
    return _Layout(profile, roles, fmt, header, len(table[0]), name)


def _only(values: list[str | None]) -> str | None:
    return values[0] if len(set(values)) == 1 else None


def read(path: Path, date_format: str | None = None) -> CsvImport:
    """`date_format` is the owner's answer when a generic file's dates are ambiguous."""
    name = path.name
    profile, roles, table = _match(_decode(path.read_bytes(), name), name)
    layout = _layout(profile, roles, table, name, date_format)
    data = table[1:] if layout.header else table
    got = [x for n, row in enumerate(data, start=1) if (x := _row(layout, row, n)) is not None]
    rows = tuple(r for r, _ in got)
    days = [r.date for r in rows]
    file = ParsedFile(
        name=name,
        format="csv",
        institution=profile.institution,
        account_hint=_only([r.account_hint for r in rows]),
        account_kind_hint=profile.account_kind,
        rows=rows,
        profile_id=profile.id,
        sha256=sha256_of(path),
        date_from=min(days, default=None),
        date_to=max(days, default=None),
    )
    return CsvImport(file=file, tags=tuple(t for _, t in got))


class CsvParser:
    def sniff(self, path: Path, head: bytes) -> bool:
        return path.suffix.lower() in {".csv", ".tsv"}

    def parse(self, path: Path) -> ParsedFile:
        return read(path).file


register(CsvParser())
