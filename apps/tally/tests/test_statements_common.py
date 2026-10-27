import re
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.parsers import ParseError
from tally.parsers.statements import (
    Line,
    Page,
    Word,
    around,
    attach,
    between,
    document_lines,
    identify,
    money,
    optional_money,
)


@pytest.mark.parametrize(
    ("text", "value"),
    [
        ("1,234.56", Decimal("1234.56")),
        ("$1,234.56", Decimal("1234.56")),
        ("(1,234.56)", Decimal("-1234.56")),
        ("1,234.56-", Decimal("-1234.56")),
        ("-$5.00", Decimal("-5.00")),
        ("12.3456", Decimal("12.3456")),
    ],
)
def test_money_reads_statement_notations(text, value):
    assert money(text) == value


def test_money_rejects_garbage_without_echoing_it():
    with pytest.raises(ParseError) as e:
        money("12a.00")
    assert "12a" not in str(e.value)


def test_optional_money_treats_a_dash_as_nothing():
    assert optional_money("-") is None
    assert optional_money("0.00") == Decimal(0)


@given(st.decimals(min_value=0, max_value=10**9, places=2, allow_nan=False))
def test_money_round_trips_every_notation(value):
    shown = f"{value:,.2f}"
    assert money(f"${shown}") == value
    assert money(f"({shown})") == -value
    assert money(f"{shown}-") == -value


def test_lines_fall_back_to_text_without_words():
    page = Page(text="first\n\n second \nthird")
    assert [ln.text for ln in page.lines()] == ["first", "second", "third"]


def test_lines_group_words_by_top_and_crop_a_right_column():
    words = (
        Word("ROW", 10, 30, 100.0),
        Word("1.00", 40, 60, 100.8),
        Word("glossary", 400, 450, 100.0),
        Word("next", 10, 30, 112.0, blank_after=True),
    )
    lines = Page(text="", words=words).lines(x_max=200)
    assert [ln.text for ln in lines] == ["ROW 1.00", "next"]
    assert [ln.blank_after for ln in lines] == [False, True]


def test_document_lines_keep_pages_apart():
    lines = document_lines([Page(text="a\nb"), Page(text="c")])
    assert [ln.text for ln in lines] == ["a", "b", "c"]
    assert lines[2].top - lines[1].top > 1000


def _row(text: str) -> re.Match[str] | None:
    return re.match(r"^ROW (\w+)$", text)


def test_attach_gives_wrapped_lines_to_the_nearest_row():
    lines = [
        Line("ROW a", 0),
        Line("tail of a", 10),
        Line("head of b", 30),
        Line("ROW b", 40),
        Line("tail of b", 50),
    ]
    got = attach(lines, _row, before=True)
    assert [(m[1], [e.text for e in extra]) for _, m, extra in got] == [
        ("a", ["tail of a"]),
        ("b", ["head of b", "tail of b"]),
    ]
    row, _, extra = got[1]
    assert around(row, "inline", extra) == "head of b inline tail of b"


def test_attach_drops_headings_when_only_continuations_count():
    lines = [Line("HEADING", 0), Line("ROW a", 10), Line("tail", 20)]
    got = attach(lines, _row, before=False)
    assert [[e.text for e in extra] for _, _, extra in got] == [["tail"]]


def test_between_collects_every_section():
    lines = [
        Line(t, i) for i, t in enumerate(["x", "START", "a", "STOP", "y", "START", "b", "STOP"])
    ]
    got = between(lines, re.compile("^START$"), re.compile("STOP"))
    assert [ln.text for ln in got] == ["a", "b"]


def test_identify_names_no_family_for_unknown_text():
    assert identify(["A grocery receipt", "nothing else"]) is None
