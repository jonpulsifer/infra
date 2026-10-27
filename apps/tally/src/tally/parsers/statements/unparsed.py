"""Families tally recognises but does not parse yet, so the inventory can count them."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from tally.parsers import ParseError
from tally.parsers.statements import Page, Statement


@dataclass(frozen=True)
class Recognised:
    name: str
    needles: tuple[str, ...]

    def sniff(self, texts: Sequence[str]) -> bool:
        """Any page: an issuer may be named only after page 1."""
        return any(n in t for t in texts for n in self.needles)

    def parse(self, pages: Sequence[Page], origin: str) -> Statement:
        raise ParseError(f"{self.name} statement: recognised, not parsed yet")


PWL = Recognised("pwl", ("PWL Capital",))
