"""PDF statements: the text layer through pdfplumber, or OCR for a scan, then a family.

A PDF counts as scanned when its text layer averages fewer than
`SCANNED_CHARS_PER_PAGE` characters a page. Scans go to `ocr_pages`, which
needs the `ocr` extra (Docling); without it the parse fails and names the extra.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tally.model import ParsedFile
from tally.parsers import ParseError, register, sha256_of
from tally.parsers.statements import Page, Word, identify

SCANNED_CHARS_PER_PAGE = 20


@dataclass(frozen=True)
class Identity:
    """What the inventory needs to count a PDF, without parsing it."""

    family: str | None
    scanned: bool
    pages: int


class PdfParser:
    def sniff(self, path: Path, head: bytes) -> bool:
        return b"%PDF-" in head[:1024]

    def parse(self, path: Path) -> ParsedFile:
        pages, scanned = read(path)
        return from_pages(path, pages, scanned=scanned)


def from_pages(path: Path, pages: Sequence[Page], *, scanned: bool) -> ParsedFile:
    """The ParsedFile for pages already extracted, by whichever family claims them.

    A caller that OCRs on its own terms (a cache, a worker) hands the pages
    in here; `PdfParser.parse` is this after `read`.
    """
    family = identify([p.text for p in pages])
    if family is None:
        raise ParseError(f"{path.name}: no statement family recognises this PDF")
    try:
        statement = family.parse(pages, origin=path.name)
    except ParseError as e:
        raise ParseError(f"{path.name}: {e}") from None
    return ParsedFile(
        name=path.name,
        format="pdf",
        institution=statement.institution,
        account_hint=statement.account_hint,
        account_kind_hint=statement.account_kind,
        rows=statement.rows,
        assertions=statement.assertions,
        holdings=statement.holdings,
        sha256=sha256_of(path),
        date_from=statement.date_from,
        date_to=statement.date_to,
        pages=len(pages),
        scanned=scanned,
    )


def is_scanned(texts: Sequence[str]) -> bool:
    return sum(len(t.strip()) for t in texts) < SCANNED_CHARS_PER_PAGE * max(len(texts), 1)


def text_layer(path: Path) -> list[Page]:
    import pdfplumber
    from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect
    from pdfplumber.utils.exceptions import PdfminerException

    try:
        with pdfplumber.open(path) as pdf:
            return [_page(p) for p in pdf.pages]
    except PdfminerException as e:
        cause = e.args[0] if e.args else None
        encrypted = isinstance(cause, PDFPasswordIncorrect | PDFEncryptionError)
        raise ParseError(f"{path.name}: {'encrypted' if encrypted else 'unreadable'} PDF") from None


def _page(page: Any) -> Page:
    blanks: dict[int, list[float]] = defaultdict(list)
    for c in page.chars:
        if c["text"].isspace():
            blanks[round(c["top"])].append(float(c["x0"]))
    words = tuple(
        Word(
            text=w["text"],
            x0=float(w["x0"]),
            x1=float(w["x1"]),
            top=float(w["top"]),
            blank_after=any(abs(x - w["x1"]) < 1.0 for x in blanks.get(round(w["top"]), ())),
        )
        for w in page.extract_words()
    )
    return Page(text=page.extract_text() or "", words=words)


def read(path: Path) -> tuple[list[Page], bool]:
    pages = text_layer(path)
    if not is_scanned([p.text for p in pages]):
        return pages, False
    return [Page(text=t) for t in ocr_pages(path)], True


def ocr_pages(path: Path) -> list[str]:
    """One text per page from Docling, which OCRs only the regions that are bitmaps."""
    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        raise ParseError("scanned PDF; install tally[ocr]") from None
    document: Any = DocumentConverter().convert(path).document
    return [str(document.export_to_markdown(page_no=n)) for n in sorted(document.pages)]


def identity(path: Path) -> Identity:
    pages = text_layer(path)
    texts = [p.text for p in pages]
    if is_scanned(texts):
        return Identity(family=None, scanned=True, pages=len(pages))
    family = identify(texts)
    return Identity(family=family.name if family else None, scanned=False, pages=len(pages))


register(PdfParser())
