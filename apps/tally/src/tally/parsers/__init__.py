"""Parsers turn a file into a ParsedFile. They never see the ledger.

`parse(path)` sniffs the format and dispatches. OFX/QFX goes through
`tally.parsers.ofx` (a wrapped ofxtools). CSV goes through
`tally.parsers.csv_` and its profile registry, matched by column fingerprint.
PDF goes through `tally.parsers.pdf`; only a scanned PDF needs the `ocr` extra.
"""

from __future__ import annotations

import contextlib
import importlib
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from tally.model import ParsedFile


class ParseError(Exception):
    """The file is not something tally can read. The message names why, never a row."""


class Parser(Protocol):
    def sniff(self, path: Path, head: bytes) -> bool:
        """True when this parser claims the file. Cheap; reads `head` only."""
        ...

    def parse(self, path: Path) -> ParsedFile: ...


_REGISTRY: list[Parser] = []
_LOADED = False


def register(parser: Parser) -> Parser:
    _REGISTRY.append(parser)
    return parser


def parsers() -> tuple[Parser, ...]:
    if not _LOADED:
        _load()
    return tuple(_REGISTRY)


def _load() -> None:
    """Import each parser for its `register` side effect, in sniff order.

    Importing a parser module directly (a caller that wants `pdf` alone)
    registers it early; the flag, not the registry's size, says whether the
    whole set has been loaded, so that early import cannot hide the rest.
    """
    global _LOADED
    _LOADED = True
    for name in ("csv_", "ofx", "xlsx"):
        importlib.import_module(f"tally.parsers.{name}")
    with contextlib.suppress(ImportError):
        importlib.import_module("tally.parsers.pdf")


def parse(path: Path) -> ParsedFile:
    head = path.read_bytes()[:4096]
    for p in parsers():
        if p.sniff(path, head):
            return p.parse(path)
    raise ParseError(f"{path.name}: no parser claims this file")


def sha256_of(path: Path, read: Callable[[Path], bytes] = Path.read_bytes) -> str:
    import hashlib

    return hashlib.sha256(read(path)).hexdigest()
