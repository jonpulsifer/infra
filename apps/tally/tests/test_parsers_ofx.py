from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from tally import parsers
from tally.model import AccountKind
from tally.parsers import ParseError, ofx

V1_HEADER = """OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

"""

SIGNON = (
    "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>"
    "<DTSERVER>20300201<LANGUAGE>ENG<FI><ORG>Maple Test Bank<FID>9999</FI>"
    "{intu}</SONRS></SIGNONMSGSRSV1>"
)


def trn(fitid: str, posted: str, amount: str, name: str, memo: str = "") -> str:
    memo_tag = f"<MEMO>{memo}" if memo else ""
    return (
        f"<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>{posted}<TRNAMT>{amount}"
        f"<FITID>{fitid}<NAME>{name}{memo_tag}</STMTTRN>"
    )


def bank_stmt(acctid: str, accttype: str, trns: str, ledger: str = "") -> str:
    return (
        "<STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS><CURDEF>CAD"
        f"<BANKACCTFROM><BANKID>000<ACCTID>{acctid}<ACCTTYPE>{accttype}</BANKACCTFROM>"
        f"<BANKTRANLIST><DTSTART>20300101<DTEND>20300131{trns}</BANKTRANLIST>"
        f"{ledger}</STMTRS></STMTTRNRS>"
    )


def v1(body: str, intu: str = "") -> str:
    return f"{V1_HEADER}<OFX>{SIGNON.format(intu=intu)}<BANKMSGSRSV1>{body}</BANKMSGSRSV1></OFX>\n"


def write(tmp_path: Path, name: str, text: str) -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="cp1252")
    return path


def test_sgml_bank_statement(tmp_path: Path) -> None:
    trns = trn("A1", "20300105120000[-5:EST]", "-12.34", "CORNER GROCER") + trn(
        "A2", "20300110", "1500.00", "PAYROLL"
    )
    ledger = "<LEDGERBAL><BALAMT>2000.50<DTASOF>20300131020000[-5:EST]</LEDGERBAL>"
    path = write(tmp_path, "chq.ofx", v1(bank_stmt("ACC-1", "CHECKING", trns, ledger)))

    pf = ofx.parse(path)

    assert pf.format == "ofx"
    assert pf.institution == "Maple Test Bank"
    assert pf.account_hint == "ACC-1"
    assert pf.account_kind_hint is AccountKind.chequing
    assert [(r.date, r.amount, r.descriptor, r.fitid) for r in pf.rows] == [
        (date(2030, 1, 5), Decimal("-12.34"), "CORNER GROCER", "A1"),
        (date(2030, 1, 10), Decimal("1500.00"), "PAYROLL", "A2"),
    ]
    assert all(r.account_hint == "ACC-1" for r in pf.rows)
    (assertion,) = pf.assertions
    assert (assertion.account_id, assertion.date, assertion.balance) == (
        "ACC-1",
        date(2030, 1, 31),
        Decimal("2000.50"),
    )
    assert assertion.origin == "chq.ofx"
    assert (pf.date_from, pf.date_to) == (date(2030, 1, 1), date(2030, 1, 31))
    assert len(pf.sha256) == 64


def test_late_utc_time_keeps_the_written_date(tmp_path: Path) -> None:
    trns = trn("X", "20300301230000[-5:EST]", "-1.00", "LATE NIGHT")
    pf = ofx.parse(write(tmp_path, "a.ofx", v1(bank_stmt("ACC", "SAVINGS", trns))))
    assert pf.rows[0].date == date(2030, 3, 1)
    assert pf.account_kind_hint is AccountKind.savings


def test_duplicate_fitids_are_all_kept(tmp_path: Path) -> None:
    trns = trn("SAME", "20300105", "-5.00", "COFFEE") * 2
    pf = ofx.parse(write(tmp_path, "d.ofx", v1(bank_stmt("ACC", "CHECKING", trns))))
    assert [r.fitid for r in pf.rows] == ["SAME", "SAME"]


def test_memo_extends_truncated_name(tmp_path: Path) -> None:
    name = "NORTHERN HARDWARE AND SUPPLY CO"
    trns = trn("1", "20300105", "-9.99", name, memo=name + "MPANY HALIFAX NS") + trn(
        "2", "20300106", "-1.00", "FOO &amp; BAR", memo="ONLINE"
    )
    pf = ofx.parse(write(tmp_path, "m.ofx", v1(bank_stmt("ACC", "CHECKING", trns))))
    assert pf.rows[0].descriptor == name + "MPANY HALIFAX NS"
    assert pf.rows[1].descriptor == "FOO & BAR ONLINE"
    assert pf.rows[1].memo == "ONLINE"


@pytest.mark.parametrize(
    ("name", "memo", "want"),
    [
        ("SHOP", "", "SHOP"),
        ("SHOP 123", "shop", "SHOP 123"),
        ("SHOP", "SHOP TORONTO", "SHOP TORONTO"),
        ("SHOP", "POS 42", "SHOP POS 42"),
        ("", "ONLY MEMO", "ONLY MEMO"),
    ],
)
def test_descriptor(name: str, memo: str, want: str) -> None:
    assert ofx.descriptor(name, memo) == want


def test_xml_credit_card_qfx(tmp_path: Path) -> None:
    text = """<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<DTSERVER>20300201</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID>
<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<CCSTMTRS><CURDEF>CAD</CURDEF><CCACCTFROM><ACCTID>CARD-9</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20300101</DTSTART><DTEND>20300131</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20300115</DTPOSTED><TRNAMT>-42.00</TRNAMT>
<FITID>C1</FITID><NAME>BOOKSHOP</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-42.00</BALAMT><DTASOF>20300131</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>
"""
    path = tmp_path / "card.qfx"
    path.write_text(text, encoding="utf-8")

    pf = ofx.parse(path)

    assert pf.format == "qfx"
    assert pf.account_kind_hint is AccountKind.credit
    assert pf.account_hint == "CARD-9"
    assert pf.rows[0].amount == Decimal("-42.00")
    assert pf.assertions[0].balance == Decimal("-42.00")


def test_intuit_tag_marks_qfx(tmp_path: Path) -> None:
    body = bank_stmt("ACC", "CHECKING", trn("1", "20300105", "-1.00", "X"))
    pf = ofx.parse(write(tmp_path, "export.ofx", v1(body, intu="<INTU.BID>00000")))
    assert pf.format == "qfx"


def test_two_statements_leave_the_file_account_open(tmp_path: Path) -> None:
    body = bank_stmt("ONE", "CHECKING", trn("1", "20300105", "-1.00", "X")) + bank_stmt(
        "TWO", "SAVINGS", trn("2", "20300106", "2.00", "Y")
    )
    pf = ofx.parse(write(tmp_path, "multi.ofx", v1(body)))
    assert pf.account_hint is None
    assert pf.account_kind_hint is None
    assert [r.account_hint for r in pf.rows] == ["ONE", "TWO"]
    assert pf.assertions == ()


def test_missing_ledger_balance_amount_is_no_assertion(tmp_path: Path) -> None:
    ledger = "<LEDGERBAL><DTASOF>20300131</LEDGERBAL>"
    trns = trn("1", "20300105", "-1.00", "X")
    pf = ofx.parse(write(tmp_path, "l.ofx", v1(bank_stmt("ACC", "CHECKING", trns, ledger))))
    assert pf.assertions == ()


def test_garbage_raises_without_echoing_content(tmp_path: Path) -> None:
    path = write(tmp_path, "bad.ofx", "OFXHEADER:100\nSECRET-PAYEE 123.45\n")
    with pytest.raises(ParseError) as err:
        ofx.parse(path)
    assert "SECRET" not in str(err.value)
    assert "123.45" not in str(err.value)


def test_no_statement_raises(tmp_path: Path) -> None:
    text = f"{V1_HEADER}<OFX>{SIGNON.format(intu='')}</OFX>\n"
    with pytest.raises(ParseError, match="no bank or card statement"):
        ofx.parse(write(tmp_path, "empty.ofx", text))


def test_bad_amount_raises_without_value(tmp_path: Path) -> None:
    trns = trn("1", "20300105", "lots", "X")
    with pytest.raises(ParseError, match="TRNAMT") as err:
        ofx.parse(write(tmp_path, "amt.ofx", v1(bank_stmt("ACC", "CHECKING", trns))))
    assert "lots" not in str(err.value)


def test_registered_and_sniffs(tmp_path: Path) -> None:
    path = write(
        tmp_path, "noext", v1(bank_stmt("ACC", "CHECKING", trn("1", "20300105", "-1", "X")))
    )
    assert parsers.parse(path).format == "ofx"
    assert any(isinstance(p, ofx.OfxParser) for p in parsers.parsers())
