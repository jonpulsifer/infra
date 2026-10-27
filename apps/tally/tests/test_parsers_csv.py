from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally import parsers
from tally.model import AccountKind
from tally.parsers import ParseError, csv_
from tally.parsers.profiles.base import parse_amount

YNAB_HEADER = (
    '"Account","Flag","Date","Payee","Category Group/Category","Category Group",'
    '"Category","Memo","Outflow","Inflow","Cleared"'
)
YNAB_ROWS = [
    '"Test Visa","","2031-02-03","Lantern Cafe","Everyday: Coffee","Everyday","Coffee",'
    '"","$4.50","$0.00","Reconciled"',
    '"Test Chequing","","2031-02-04","Acme Payroll","Inflow: Ready to Assign","Inflow",'
    '"Ready to Assign","feb","$0.00","$1,234.56","Cleared"',
    '"Test Chequing","Red","2031-02-05","Transfer : Test Visa","","","","","$100.00",'
    '"$0.00","Uncleared"',
    '"Test Visa","","2031-02-06","Lantern Cafe","Everyday: Coffee","Everyday","Coffee",'
    '"","$3.25","$0.00","Cleared"',
    '"Test Visa","","2031-02-07","Lantern Cafe","Everyday: Treats","Everyday","Treats",'
    '"","$9.00","$0.00","Cleared"',
]


def write(tmp_path: Path, name: str, lines: list[str], encoding: str = "utf-8") -> Path:
    path = tmp_path / name
    path.write_bytes("\r\n".join(lines).encode(encoding) + b"\r\n")
    return path


def test_ynab_register(tmp_path: Path) -> None:
    path = write(tmp_path, "Register.csv", [YNAB_HEADER, *YNAB_ROWS], encoding="utf-8-sig")

    got = csv_.read(path)
    pf = got.file

    assert pf.profile_id == "ynab-register"
    assert pf.format == "csv"
    assert pf.account_hint is None
    assert [(r.account_hint, r.date, r.amount) for r in pf.rows[:3]] == [
        ("Test Visa", date(2031, 2, 3), Decimal("-4.50")),
        ("Test Chequing", date(2031, 2, 4), Decimal("1234.56")),
        ("Test Chequing", date(2031, 2, 5), Decimal("-100.00")),
    ]
    assert pf.rows[1].memo == "feb"
    assert [r.pending for r in pf.rows[:3]] == [False, False, True]
    assert got.tags[0] == ("ynab:Everyday/Coffee",)
    assert got.tags[2] == ("ynab:transfer",)
    assert (pf.date_from, pf.date_to) == (date(2031, 2, 3), date(2031, 2, 7))


def test_ynab_seed_hints_take_the_majority_and_skip_transfers(tmp_path: Path) -> None:
    got = csv_.read(write(tmp_path, "r.csv", [YNAB_HEADER, *YNAB_ROWS]))
    assert got.seed_hints() == {
        "Acme Payroll": "ynab:Inflow/Ready to Assign",
        "Lantern Cafe": "ynab:Everyday/Coffee",
    }


SCOTIA_ROWS = [
    "1/2/31,-25.10,-,POS Purchase,FAKE MART 0001",
    "1/15/31,1500.00,-,Payroll Deposit,EXAMPLE CORP",
    '12/31/31,-3.00,-,Service Charge,""',
]


def test_scotiabank_headerless(tmp_path: Path) -> None:
    pf = csv_.read(write(tmp_path, "chq.csv", SCOTIA_ROWS)).file

    assert pf.profile_id == "scotiabank-chequing-headerless"
    assert pf.institution == "Scotiabank"
    assert pf.account_kind_hint is AccountKind.chequing
    assert [(r.date, r.amount, r.descriptor, r.memo) for r in pf.rows] == [
        (date(2031, 1, 2), Decimal("-25.10"), "FAKE MART 0001", "POS Purchase"),
        (date(2031, 1, 15), Decimal("1500.00"), "EXAMPLE CORP", "Payroll Deposit"),
        (date(2031, 12, 31), Decimal("-3.00"), "Service Charge", "Service Charge"),
    ]
    assert all(r.account_hint is None for r in pf.rows)


def test_rbc_style_generic(tmp_path: Path) -> None:
    lines = [
        '"Account Type","Account Number","Transaction Date","Cheque Number",'
        '"Description 1","Description 2","CAD$","USD$"',
        'Chequing,00000-1111111,3/4/2032,,"ONLINE PURCHASE","SOME SHOP",-12.00,',
        'Chequing,00000-1111111,3/19/2032,,"DEPOSIT","",250.00,',
        "Chequing,00000-1111111,3/10/2032,,,,,",
    ]
    pf = csv_.read(write(tmp_path, "rbc.csv", lines)).file

    assert pf.profile_id == "generic"
    assert pf.account_hint == "00000-1111111"
    assert [(r.date, r.amount, r.descriptor) for r in pf.rows] == [
        (date(2032, 3, 4), Decimal("-12.00"), "ONLINE PURCHASE SOME SHOP"),
        (date(2032, 3, 19), Decimal("250.00"), "DEPOSIT"),
    ]


def test_split_debit_credit_with_balance(tmp_path: Path) -> None:
    lines = [
        "Date,Transaction Description,Debit,Credit,Balance",
        "2032-05-01,GROCER,40.00,,960.00",
        "2032-05-02,REFUND,,5.00,965.00",
    ]
    pf = csv_.read(write(tmp_path, "td.csv", lines)).file
    assert [(r.amount, r.balance_after) for r in pf.rows] == [
        (Decimal("-40.00"), Decimal("960.00")),
        (Decimal("5.00"), Decimal("965.00")),
    ]


def test_tangerine_style_generic(tmp_path: Path) -> None:
    lines = [
        "Transaction date,Transaction,Name,Memo,Amount",
        "6/17/2032,DEBIT,BAKERY,Interac purchase,-8.25",
    ]
    (row,) = csv_.read(write(tmp_path, "t.csv", lines)).file.rows
    assert (row.descriptor, row.memo, row.amount) == (
        "BAKERY",
        "DEBIT Interac purchase",
        Decimal("-8.25"),
    )


def test_card_export_reads_positive_as_a_charge(tmp_path: Path) -> None:
    lines = [
        "Date,Date Processed,Description,Cardmember,Amount",
        "07 Jun 2032,08 Jun 2032,RESTAURANT,A TESTER,30.00",
        "09 Jun 2032,09 Jun 2032,PAYMENT RECEIVED,A TESTER,-100.00",
    ]
    pf = csv_.read(write(tmp_path, "amex.csv", lines)).file
    assert [r.amount for r in pf.rows] == [Decimal("-30.00"), Decimal("100.00")]
    assert pf.rows[0].date == date(2032, 6, 7)


def test_semicolon_delimited_generic(tmp_path: Path) -> None:
    lines = ["Date;Description;Amount", "2032-01-02;SHOP;-1.00", "2032-01-03;SHOP;-2.00"]
    pf = csv_.read(write(tmp_path, "semi.csv", lines)).file
    assert [r.amount for r in pf.rows] == [Decimal("-1.00"), Decimal("-2.00")]


def test_ambiguous_dates_raise(tmp_path: Path) -> None:
    lines = ["Date,Description,Amount", "01/02/2032,A,-1.00", "03/04/2032,B,-2.00"]
    with pytest.raises(ParseError, match=r"%m/%d/%Y or %d/%m/%Y"):
        csv_.read(write(tmp_path, "amb.csv", lines))


def test_unambiguous_day_first_dates(tmp_path: Path) -> None:
    lines = ["Date,Description,Amount", "25/02/2032,A,-1.00", "03/04/2032,B,-2.00"]
    pf = csv_.read(write(tmp_path, "dm.csv", lines)).file
    assert [r.date for r in pf.rows] == [date(2032, 2, 25), date(2032, 4, 3)]


def test_cp1252_fallback(tmp_path: Path) -> None:
    lines = ["Date,Description,Amount", "2032-01-02,CAFÉ CRÈME,-4.00"]
    (row,) = csv_.read(write(tmp_path, "w.csv", lines, encoding="cp1252")).file.rows
    assert row.descriptor == "CAFÉ CRÈME"


def test_unknown_layout_of_known_column_names_names_the_header(tmp_path: Path) -> None:
    lines = ["Date,Memo,Notes", "2032-01-02,PRIVATE PAYEE,x"]
    with pytest.raises(ParseError, match=r"3 columns, header \['Date', 'Memo', 'Notes'\]") as err:
        csv_.read(write(tmp_path, "u.csv", lines))
    assert "PRIVATE" not in str(err.value)


def test_unknown_header_words_are_never_echoed(tmp_path: Path) -> None:
    lines = ["Foo,Bar,Baz", "PRIVATE PAYEE,77.77,x"]
    with pytest.raises(ParseError, match="3 columns, an unrecognised header row") as err:
        csv_.read(write(tmp_path, "u.csv", lines))
    assert "Foo" not in str(err.value)
    assert "77.77" not in str(err.value)


def test_a_header_shaped_data_row_is_never_echoed(tmp_path: Path) -> None:
    cells = ["Jan 5 note", "ACME CAFE ref 998877", "Acct 5500123456"]
    lines = [",".join(cells), "Feb 6 note,OTHER PLACE ref 1,Acct 1"]
    with pytest.raises(ParseError) as err:
        csv_.read(write(tmp_path, "t.csv", lines))
    for text in (*cells, "998877", "5500123456", "ACME"):
        assert text not in str(err.value)


def test_unknown_headerless_layout_shows_no_row(tmp_path: Path) -> None:
    lines = ["2032-01-02,PRIVATE PAYEE,77.77", "2032-01-03,OTHER,1.00"]
    with pytest.raises(ParseError, match="3 columns, no header row") as err:
        csv_.read(write(tmp_path, "h.csv", lines))
    assert "PRIVATE" not in str(err.value)


def test_bad_amount_names_the_column_not_the_value(tmp_path: Path) -> None:
    bad = YNAB_ROWS[0].replace("$4.50", "four fifty")
    with pytest.raises(ParseError, match=r"row 1: column 'Outflow', 'Inflow'") as err:
        csv_.read(write(tmp_path, "b.csv", [YNAB_HEADER, bad]))
    assert "four" not in str(err.value)


def test_short_row_raises(tmp_path: Path) -> None:
    lines = SCOTIA_ROWS * 10 + ["1/2/31,-1.00,-,POS"]
    with pytest.raises(ParseError, match="row 31 has 4 columns, expected 5"):
        csv_.read(write(tmp_path, "s.csv", lines))


def test_named_date_format_settles_ambiguity(tmp_path: Path) -> None:
    lines = ["Date,Description,Amount", "01/02/2032,A,-1.00", "03/04/2032,B,-2.00"]
    pf = csv_.read(write(tmp_path, "amb.csv", lines), date_format="%d/%m/%Y").file
    assert [r.date for r in pf.rows] == [date(2032, 2, 1), date(2032, 4, 3)]


def test_oversized_field_raises(tmp_path: Path) -> None:
    path = tmp_path / "big.csv"
    path.write_bytes(b'Date,Description,Amount\r\n2032-01-02,"' + b"x" * 200_000 + b'",-1\r\n')
    with pytest.raises(ParseError, match="not a well-formed CSV"):
        csv_.read(path)


def test_empty_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ParseError, match="empty"):
        csv_.read(write(tmp_path, "e.csv", []))


def test_registered_and_dispatched(tmp_path: Path) -> None:
    path = write(tmp_path, "chq.csv", SCOTIA_ROWS)
    assert parsers.parse(path).profile_id == "scotiabank-chequing-headerless"


@pytest.mark.parametrize(
    ("cell", "want"),
    [
        ("$1,234.56", Decimal("1234.56")),
        ("-$5.00", Decimal("-5.00")),
        ("(5.00)", Decimal("-5.00")),
        ("5.00-", Decimal("-5.00")),
        ("  ", None),
        ("CAD 7", Decimal("7")),
    ],
)
def test_parse_amount(cell: str, want: Decimal | None) -> None:
    assert parse_amount(cell) == want


@pytest.mark.parametrize("cell", ["-", "abc", "NaN", "1.2.3"])
def test_parse_amount_rejects(cell: str) -> None:
    with pytest.raises(ValueError):
        parse_amount(cell)


@given(st.decimals(min_value=-(10**9), max_value=10**9, places=2, allow_nan=False))
def test_parse_amount_round_trips_dollar_format(value: Decimal) -> None:
    sign = "-" if value < 0 else ""
    assert parse_amount(f"{sign}${abs(value):,.2f}") == value
