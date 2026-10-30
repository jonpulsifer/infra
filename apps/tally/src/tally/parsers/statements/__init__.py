"""Statement families: extracted pages in, rows, assertions and holdings out.

One module per family. A family never opens a file: `tally.parsers.pdf` extracts
the pages and hands them over, so every family is testable on invented text.
A page carries its text and, when the PDF had a text layer, its positioned words;
families that need geometry (dropping a glossary column, attaching wrapped
descriptions to the nearest row) read `Page.lines()`, which falls back to the
text's own lines when there are no words.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal, Protocol

from tally.model import AccountKind, BalanceAssertion, HoldingSnapshot, ParsedRow, Position
from tally.parsers import ParseError

PAGE_SPAN = 10_000.0
LINE_STEP = 10.0


@dataclass(frozen=True)
class Word:
    """`blank_after`: a drawn glyph that extracts as whitespace touches the word's right edge.

    Scotiabank VISA draws its credit minus in a font with no Unicode mapping for
    it, so the only trace of a credit in the text layer is that blank.
    """

    text: str
    x0: float
    x1: float
    top: float
    blank_after: bool = False


@dataclass(frozen=True)
class Line:
    text: str
    top: float
    blank_after: bool = False


@dataclass(frozen=True)
class Page:
    text: str
    words: tuple[Word, ...] = ()

    def lines(self, x_max: float | None = None, tolerance: float = 3.0) -> list[Line]:
        """Words grouped into lines by their top edge; `x_max` drops words right of it."""
        if not self.words:
            return [
                Line(t.strip(), i * LINE_STEP)
                for i, t in enumerate(self.text.splitlines())
                if t.strip()
            ]
        kept = sorted(
            (w for w in self.words if x_max is None or w.x1 <= x_max),
            key=lambda w: (w.top, w.x0),
        )
        groups: list[list[Word]] = []
        for w in kept:
            if groups and w.top - groups[-1][0].top <= tolerance:
                groups[-1].append(w)
            else:
                groups.append([w])
        return [_line(sorted(g, key=lambda w: w.x0)) for g in groups]

    def right_edge_of(self, prefix: str) -> float | None:
        return next((w.x1 for w in self.words if w.text.startswith(prefix)), None)


def _line(words: Sequence[Word]) -> Line:
    return Line(" ".join(w.text for w in words), words[0].top, words[-1].blank_after)


def document_lines(
    pages: Sequence[Page], x_max: Callable[[Page], float | None] = lambda _: None
) -> list[Line]:
    """Every page's lines in order, tops offset per page so distances stay meaningful."""
    return [
        Line(line.text, i * PAGE_SPAN + line.top, line.blank_after)
        for i, page in enumerate(pages)
        for line in page.lines(x_max(page))
    ]


@dataclass(frozen=True)
class Statement:
    institution: str
    account_hint: str | None
    account_kind: AccountKind | None
    date_from: date | None
    date_to: date | None
    rows: tuple[ParsedRow, ...] = ()
    assertions: tuple[BalanceAssertion, ...] = ()
    holdings: tuple[HoldingSnapshot, ...] = ()
    currency: Literal["CAD", "USD"] = "CAD"


class Family(Protocol):
    @property
    def name(self) -> str: ...

    def sniff(self, texts: Sequence[str]) -> bool:
        """True when this family claims the document. Usually reads page 1 only."""
        ...

    def parse(self, pages: Sequence[Page], origin: str) -> Statement: ...


def families() -> tuple[Family, ...]:
    from tally.parsers.statements import (
        questrade,
        scotia_chequing,
        scotia_portfolio,
        scotia_visa,
        shareworks,
        unparsed,
    )

    return (
        questrade.FAMILY,
        scotia_visa.FAMILY,
        scotia_portfolio.FAMILY,
        scotia_chequing.FAMILY,
        shareworks.FAMILY,
        unparsed.PWL,
    )


def identify(texts: Sequence[str]) -> Family | None:
    return next((f for f in families() if f.sniff(texts)), None)


MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}

AMOUNT = r"\(?-?\$?\d[\d,]*\.\d+\)?-?"


def month(name: str) -> int:
    try:
        return MONTHS[name[:3].lower()]
    except KeyError:
        raise ParseError(f"unreadable month name ({len(name)} chars)") from None


def money(text: str) -> Decimal:
    """`$1,234.56`, `(1,234.56)`, `1,234.56-` and `-1,234.56` all read; parens and dashes negate."""
    s = text.strip()
    negative = (s.startswith("(") and s.endswith(")")) or s.endswith("-") or s.startswith("-")
    digits = s.strip("()-$ ").replace("$", "").replace(",", "")
    try:
        value = Decimal(digits)
    except InvalidOperation:
        raise ParseError("unreadable amount") from None
    return -value if negative else value


def optional_money(text: str) -> Decimal | None:
    return None if text.strip() in {"-", ""} else money(text)


def search(pattern: re.Pattern[str], text: str, what: str) -> re.Match[str]:
    found = pattern.search(text)
    if found is None:
        raise ParseError(f"{what} not found")
    return found


def attach[T](
    lines: Sequence[Line], row: Callable[[str], T | None], *, before: bool
) -> list[tuple[Line, T, list[Line]]]:
    """Each row with the non-row lines nearest it.

    A wrapped description sits closer to its own row than to its neighbour;
    a tie goes to the row above. With `before=False`, lines nearer the next
    row are headings and are dropped instead of attached.
    """
    parsed = [(line, row(line.text)) for line in lines]
    rows = [(line, value) for line, value in parsed if value is not None]
    extra: list[list[Line]] = [[] for _ in rows]
    tops = [line.top for line, _ in rows]
    for line, value in parsed:
        if value is not None or not rows:
            continue
        prev = max((i for i, t in enumerate(tops) if t < line.top), default=None)
        nxt = min((i for i, t in enumerate(tops) if t > line.top), default=None)
        if prev is not None and (nxt is None or line.top - tops[prev] <= tops[nxt] - line.top):
            extra[prev].append(line)
        elif nxt is not None and before:
            extra[nxt].append(line)
    return [(line, value, e) for (line, value), e in zip(rows, extra, strict=True)]


def around(row: Line, inline: str, extra: Sequence[Line]) -> str:
    """A row's text with its attached lines above and below, in reading order."""
    above = [e.text for e in extra if e.top < row.top]
    below = [e.text for e in extra if e.top > row.top]
    return " ".join(t for t in (*above, inline, *below) if t).strip()


def between(lines: Iterable[Line], start: re.Pattern[str], stop: re.Pattern[str]) -> list[Line]:
    """The lines after each `start` match up to its `stop` match, all sections joined."""
    out: list[Line] = []
    inside = False
    for line in lines:
        if inside and stop.search(line.text):
            inside = False
        elif not inside and start.search(line.text):
            inside = True
        elif inside:
            out.append(line)
    return out


def check_total(family: str, positions: Sequence[Position], total: Decimal) -> None:
    """The deterministic mapper's guard: positions must add up to the stated total."""
    held = sum((p.market_value for p in positions), Decimal(0))
    if abs(held - total) > Decimal("0.02") * max(len(positions), 1):
        raise ParseError(f"{family}: positions do not add up to the account total")
