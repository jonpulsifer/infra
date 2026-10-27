import sys
from decimal import Decimal
from pathlib import Path

import pytest

from tally.parsers import ParseError
from tally.parsers import pdf as pdf_module
from tally.parsers.pdf import PdfParser, identity, is_scanned, ocr_pages, read
from tally.parsers.statements import Page


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(path: Path, pages: list[list[str]]) -> Path:
    """A minimal text-layer PDF: one Helvetica line per string, 12pt apart."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]
    kids = []
    for lines in pages:
        body = " ".join(f"({_escape(t)}) Tj T*" for t in lines)
        stream = f"BT /F1 9 Tf 12 TL 40 760 Td {body} ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R "
            b"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 "
            b"/BaseFont /Helvetica >> >> >> >>" % content
        )
        kids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids),
        len(kids),
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, obj)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    path.write_bytes(bytes(out))
    return path


VISA_PAGE = [
    "Statement Period Mar 2, 2021 -Apr 1, 2021",
    "Account # 0000 111 222 333 444",
    "Scotia Momentum VISA Infinite Card",
    "Previous balance,Mar 1/21 $50.00",
    "Payments/credits - $50.00",
    "Purchases/charges + $12.50",
    "New balance = $12.50",
    "001 Mar 3 Mar 4 BLUE HERON BAKERYOTTAWAON 12.50",
    "002 Mar 5 Mar 5 PC PAYMENT FROM *****00*0000 50.00 ",
]


def test_smoke_a_rendered_statement_parses_end_to_end(tmp_path):
    path = write_pdf(tmp_path / "statement.pdf", [VISA_PAGE])
    parser = PdfParser()
    assert parser.sniff(path, path.read_bytes()[:4096])
    parsed = parser.parse(path)
    assert (parsed.format, parsed.institution, parsed.pages, parsed.scanned) == (
        "pdf",
        "Scotiabank",
        1,
        False,
    )
    assert [r.amount for r in parsed.rows] == [Decimal("-12.50"), Decimal("50.00")]
    assert [a.balance for a in parsed.assertions] == [Decimal("-50.00"), Decimal("-12.50")]
    assert len(parsed.sha256) == 64
    assert identity(path).family == "scotiabank-visa"


def test_sniff_claims_only_pdf_bytes(tmp_path):
    assert not PdfParser().sniff(tmp_path / "x.csv", b"Date,Amount\n")


def test_an_unrecognised_pdf_is_a_parse_error(tmp_path):
    path = write_pdf(tmp_path / "receipt.pdf", [["A receipt for one coffee"] * 3])
    with pytest.raises(ParseError, match="no statement family"):
        PdfParser().parse(path)


def test_a_recognised_unparsed_family_names_itself(tmp_path):
    path = write_pdf(tmp_path / "s.pdf", [["Quarterly report"] * 3, ["PWL Capital Inc."] * 3])
    with pytest.raises(ParseError, match="pwl statement: recognised"):
        PdfParser().parse(path)


def test_importing_one_parser_first_does_not_hide_the_others(monkeypatch):
    import importlib

    import tally.parsers as registry

    monkeypatch.setattr(registry, "_REGISTRY", [])
    monkeypatch.setattr(registry, "_LOADED", False)
    for name in ("csv_", "ofx", "xlsx", "pdf"):
        monkeypatch.delitem(sys.modules, f"tally.parsers.{name}", raising=False)
    importlib.import_module("tally.parsers.pdf")  # a direct import registers PdfParser alone
    assert [type(p).__name__ for p in registry._REGISTRY] == ["PdfParser"]
    names = {type(p).__name__ for p in registry.parsers()}
    assert {"CsvParser", "OfxParser", "XlsxParser", "PdfParser"} <= names


def test_a_broken_file_is_unreadable_not_a_crash(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4\nnot really")
    with pytest.raises(ParseError, match="unreadable PDF"):
        PdfParser().parse(path)


def test_scanned_is_decided_by_text_length():
    assert is_scanned(["", " \n", "x"])
    assert not is_scanned(["a full line of statement text here"] * 2)


def test_scans_go_to_ocr(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf_module, "text_layer", lambda _: [Page(""), Page("")])
    monkeypatch.setattr(pdf_module, "ocr_pages", lambda _: ["page one", "page two"])
    pages, scanned = read(tmp_path / "scan.pdf")
    assert scanned
    assert [p.text for p in pages] == ["page one", "page two"]


def test_ocr_without_the_extra_names_it(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "docling", None)
    monkeypatch.setitem(sys.modules, "docling.document_converter", None)
    with pytest.raises(ParseError, match=r"scanned PDF; install tally\[ocr\]"):
        ocr_pages(tmp_path / "scan.pdf")


def test_identity_reports_a_scan_without_ocr(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf_module, "text_layer", lambda _: [Page("")] * 3)
    got = identity(tmp_path / "scan.pdf")
    assert (got.family, got.scanned, got.pages) == (None, True, 3)
